import 'dotenv/config';
import { fetchOlxListings, fetchOlxDetails, fetchOlxSellerListingsCount } from './scrapers/olx.js';
import { fetchUyborListings, fetchUyborDetails } from './scrapers/uybor.js';
import { fetchRealtingListings, fetchRealtingDetails } from './scrapers/realting.js';
import { classifyListing, labelFor, SELLER_LISTINGS_AGENT_THRESHOLD } from './classify.js';
import { notifyAlert, notifyToTopicGroup } from './telegram.js';
import { isKnown, saveListing, markNotified } from './db.js';
import { normalizeDistrict } from './districts.js';
import { parsePrice } from './priceParser.js';
import { cleanAgentBacklog } from './cleanAgentMessages.js';

const PHONE_REGEX = /(\+?998[\s\-]?\d{2}[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2})/;

// ИИ-классификация отключена по решению (05.08.2026) — весь проект
// теперь работает только на жёстких правилах (много объявлений у
// продавца / аккаунт-организация / метка сайта), без обращения к
// Anthropic API. Код классификации (classify.js, ветка ниже) НЕ
// удалён — просто эта константа жёстко зафиксирована в false, так
// что ветка с classifyListing() больше не выполняется, даже если
// кто-то случайно оставит USE_AI_CLASSIFICATION=true в GitHub Secrets.
// Если понадобится снова включить ИИ — верните строку ниже на
// `process.env.USE_AI_CLASSIFICATION === 'true'`.
const USE_AI_CLASSIFICATION = false;

async function processSource(fetchList, fetchDetails, sourceName, dealType, fetchSellerCount = null, propertyType = 'apartment') {
  const sourceLabel = `${sourceName}-${propertyType}-${dealType}`;
  console.log(`[${sourceLabel}] проверяю новые объявления...`);

  let items = [];
  try {
    items = await fetchList(dealType, propertyType);
  } catch (err) {
    console.error(`[${sourceLabel}] ошибка при получении списка:`, err.message);
    await notifyAlert(
      `⚠️ ${sourceLabel}: не удалось загрузить список объявлений после нескольких попыток (${err.message}).`
    );
    return;
  }

  console.log(`[${sourceLabel}] найдено ${items.length} объявлений (сегодняшних) на странице`);
  if (items.length === 0) return;

  // Счётчики для само-диагностики этого прогона — цель: если сайт
  // тихо поменяет вёрстку и жёсткое правило "риэлтор по числу
  // объявлений" перестанет срабатывать, мы должны узнать об этом из
  // Telegram-алерта в течение 15 минут, а не из жалобы через
  // несколько дней (см. баг 08.08.2026 — ссылка на профиль продавца
  // перестала находиться, риэлторы пошли как собственники, и это
  // никак не было видно, пока кто-то не заметил руками).
  let sellerLinkMissingCount = 0;
  let sellerCheckedCount = 0;

  for (const item of items) {
    if (await isKnown(item.id)) continue;

    let rawText = item.title;
    let sellerName = null;
    let sellerListingsUrl = null;
    let authorAdsCountHint = null;
    let sellerNameLooksLikeAgent = false;
    try {
      const details = await fetchDetails(item.url);
      if (details?.description) rawText = `${item.title}\n${details.description}`;
      sellerName = details?.sellerName || item.seller_name || null;
      sellerListingsUrl = details?.sellerListingsUrl || null;
      authorAdsCountHint = details?.authorAdsCountHint ?? null;
      sellerNameLooksLikeAgent = details?.sellerNameLooksLikeAgent || false;
      if (sourceName === 'olx' && fetchSellerCount) {
        sellerCheckedCount++;
        if (!sellerListingsUrl) {
          sellerLinkMissingCount++;
          // Раньше это никак не логировалось — если OLX поменяет вёрстку
          // кнопки "все объявления автора", проверка на риэлтора молча
          // не срабатывает, и агент просто проходит как "непонятно".
          console.warn(
            `[${sourceLabel}] не нашли ссылку на профиль продавца "${sellerName || '?'}" — проверка числа объявлений пропущена: ${item.url}`
          );
        }
      }
      // Телефон со страницы объявления (пока реализовано только для
      // OLX, см. fetchOlxDetails) — приоритетнее, чем поиск номера в
      // тексте, потому что это самое надёжное поле, когда доступно.
      if (details?.phone) item.phone_from_details = details.phone;
      // Цена из JSON-LD (см. fetchOlxDetails) — надёжнее, чем то, что
      // нашлось при скрапинге списка (структурные данные, а не парсинг
      // вёрстки). Предпочитаем её везде, КРОМЕ коммерции — там
      // offers.price на OLX иногда указан "за м²", а не общей суммой,
      // так что для коммерции берём её только как подстраховку, если
      // со страницы списка цена вообще не нашлась.
      if (details?.ldPrice) {
        if (propertyType !== 'commercial' || !item.price) {
          item.price = details.ldPrice;
        }
      }
      // Структурное поле "район" со страницы объявления (сейчас — блок
      // "МЕСТОПОЛОЖЕНИЕ" на OLX, см. fetchOlxDetails). У Uybor
      // raw_district уже выставлен на этапе списка (fetchUyborListings),
      // так что тут его не перезаписываем.
      if (details?.locationDistrict && !item.raw_district) item.raw_district = details.locationDistrict;
    } catch (err) {
      console.warn(`[${sourceLabel}] не удалось получить текст объявления ${item.url}:`, err.message);
    }

    const phoneMatch = rawText.match(PHONE_REGEX);
    const phoneFromText = phoneMatch ? phoneMatch[1] : null;
    const phoneFromApi = item.phone_from_api || null;

    // Жёсткие правила (без ИИ, бесплатно), два источника — свои для
    // каждого сайта:
    //  - OLX: если у продавца много других объявлений — агентство.
    //  - Uybor: сайт сам помечает аккаунт как организацию (не частник) —
    //    это ещё надёжнее числа объявлений.
    // Работает независимо от USE_AI_CLASSIFICATION.
    let sellerListingsCount = null;
    let isConfirmedAgent = false;
    let confirmedAgentReason = '';

    // Самая дешёвая проверка — бесплатная (без похода на страницу
    // профиля): продавец сам назвал себя риэлтором/агентством в имени
    // или подписи аватарки (см. sellerNameLooksLikeAgent в
    // fetchOlxDetails). Ставим её первой, до счётчика объявлений —
    // ловит агентов, у которых объявлений на OLX пока мало (только
    // начали), но кто уже не скрывает, что не частник.
    if (sellerNameLooksLikeAgent) {
      isConfirmedAgent = true;
      confirmedAgentReason = `имя/аватарка продавца ("${sellerName}") — риэлтор/агентство`;
    }

    if (!isConfirmedAgent && fetchSellerCount && sellerListingsUrl) {
      sellerListingsCount = await fetchSellerCount(sellerListingsUrl);
      if (sellerListingsCount !== null && sellerListingsCount > SELLER_LISTINGS_AGENT_THRESHOLD) {
        isConfirmedAgent = true;
        confirmedAgentReason = `${sellerListingsCount} объявлений`;
      } else if (sellerListingsCount === null && authorAdsCountHint !== null) {
        // Основная проверка не удалась (страница профиля не открылась/
        // не распарсилась) — используем число со страницы самого
        // объявления как запасной, менее точный сигнал (может включать
        // не только недвижимость, поэтому берём порог с запасом заметно
        // выше основного, чтобы не наступить на старый баг "все подряд
        // считаются агентом").
        if (authorAdsCountHint > SELLER_LISTINGS_AGENT_THRESHOLD * 2) {
          isConfirmedAgent = true;
          confirmedAgentReason = `~${authorAdsCountHint} объявлений (со страницы, точная проверка не удалась)`;
        }
      }
    } else if (fetchSellerCount && !sellerListingsUrl && authorAdsCountHint !== null) {
      // Ссылку на профиль вообще не нашли (см. warn выше) — тот же
      // запасной сигнал, что и в ветке выше.
      if (authorAdsCountHint > SELLER_LISTINGS_AGENT_THRESHOLD * 2) {
        isConfirmedAgent = true;
        confirmedAgentReason = `~${authorAdsCountHint} объявлений (со страницы, ссылка на профиль не найдена)`;
      }
    }
    if (!isConfirmedAgent && item.seller_is_organization) {
      isConfirmedAgent = true;
      confirmedAgentReason = 'аккаунт организации';
    }
    if (isConfirmedAgent) {
      console.log(
        `[${sourceLabel}] продавец "${sellerName || '?'}" — похоже на агентство (${confirmedAgentReason}): ${item.title}`
      );
    }

    // Realting.uz сам размечает продавца ("Частный продавец" в
    // карточке / выделенная страница "от собственников") — доверяем
    // этому напрямую, не тратя вызов ИИ-классификации.
    const isConfirmedOwner = !isConfirmedAgent && item.source === 'realting';

    let classification;
    let label;

    if (isConfirmedOwner) {
      classification = {
        seller_type: 'owner',
        confidence: 'high',
        district: null,
        rooms: null,
        area: null,
        phone: null,
      };
      label = { text: 'Собственник (метка Realting.uz)', kind: 'owner' };
    } else if (isConfirmedAgent) {
      classification = {
        seller_type: 'agent',
        confidence: 'high',
        district: null,
        rooms: null,
        area: null,
        phone: null,
      };
      label = { text: `Агентство (${confirmedAgentReason})`, kind: 'agent' };
    } else if (!USE_AI_CLASSIFICATION) {
      // Раньше эта ветка (без ИИ) писала "Без проверки ИИ" — но так как
      // явные агентства уже отсеиваются жёсткими правилами чуть выше
      // (isConfirmedAgent), то, что осталось непроверенным, почти всегда
      // и есть частник — так и подписываем, чтобы не пугать формулировкой
      // "не проверено".
      classification = {
        seller_type: 'unknown',
        confidence: 'n/a',
        district: null,
        rooms: null,
        area: null,
        phone: null,
      };
      label = { text: 'Скорее всего собственник', kind: 'unchecked' };
    } else {
      try {
        classification = await classifyListing(rawText, sellerName);
      } catch (err) {
        console.error('Ошибка классификации:', err.message);
        classification = {
          seller_type: 'unknown',
          confidence: 'low',
          district: null,
          rooms: null,
          area: null,
          phone: null,
        };
      }
      label = labelFor(classification);
    }

    // Нормализация района — нужна для фильтра в Telegram-боте
    // (иначе "Чиланзар"/"Chilonzor"/"Чиланзарский район" не совпадут
    // друг с другом). Приоритет источников (по явному решению):
    //  1. То, что продавец САМ написал в тексте объявления (заголовок
    //     + описание) — если он явно назвал район, это и есть самый
    //     достоверный источник, даже если структурное поле сайта
    //     говорит другое (JSON-поле показывает район ПУБЛИКАЦИИ
    //     объявления на сайте, а не обязательно тот, о котором пишет
    //     продавец, — бывают расхождения).
    //  2. Район от ИИ-классификации (если включена) — тоже читает
    //     текст объявления, тот же уровень доверия, что и п.1.
    //  3. Структурное поле с самого сайта (item.raw_district — сейчас
    //     JSON districtName у OLX, аналогичное поле у Uybor) —
    //     используется, только если продавец вообще не упомянул район
    //     в тексте.
    const district =
      normalizeDistrict(rawText) ||
      normalizeDistrict(classification.district) ||
      normalizeDistrict(item.raw_district);
    const districtRaw = classification.district || item.raw_district || null;

    // Числовая цена + валюта — нужны, чтобы бот мог фильтровать по
    // диапазону цены (price остаётся текстом для отображения как есть).
    const { value: priceValue, currency: priceCurrency } = parsePrice(item.price);

    const listing = {
      ...item,
      raw_text: rawText,
      seller_name: sellerName,
      seller_listings_count: sellerListingsCount,
      district,
      district_raw: districtRaw,
      price_value: priceValue,
      price_currency: priceCurrency,
      rooms: classification.rooms,
      area: classification.area,
      phone: item.phone_from_details || phoneFromApi || phoneFromText,
      seller_type: classification.seller_type,
      confidence: classification.confidence,
      label_text: label.text,
      label_kind: label.kind,
      notified: false,
    };
    delete listing.phone_from_api; // служебное поле, в базу не пишем
    delete listing.phone_from_details; // тоже служебное — уже перенесено в phone
    delete listing.raw_district; // тоже служебное — уже перенесено в district/district_raw

    const saved = await saveListing(listing);
    if (!saved) {
      // Не сохранилось в базу — не шлём уведомление вообще (иначе
      // получим дубль на следующем прогоне, см. комментарий в db.js).
      // Просто пропускаем — при следующем запуске isKnown() снова
      // увидит его как "новое" и попробует сохранить+отправить с нуля.
      console.error(`[${sourceLabel}] пропускаю уведомление — не удалось сохранить в базу: ${listing.title}`);
      continue;
    }

    // Агентства (isConfirmedAgent) снова НЕ отправляем в Telegram —
    // вернули как было раньше (пробовали показывать всех, но по
    // фидбэку агентских объявлений слишком много и они мешают).
    // В базу (saveListing выше) пишем всех — чтобы не парсить их
    // заново на каждом прогоне, но notifyToTopicGroup зовём только для
    // тех, кто не агентство.
    if (isConfirmedAgent) {
      await markNotified(listing.id); // чтобы не пытались отправить его снова на будущих прогонах
      continue;
    }

    try {
      // Раньше тут ещё был notifyNewListing() — отправка ВСЕХ объявлений
      // (любого типа) в основной чат без привязки к теме. Убрали: он
      // приводил к тому, что в тему "General" супергруппы "Квартиры"
      // (это тот же чат, что и TELEGRAM_CHAT_ID) попадали вперемешку и
      // дома, и коммерция. notifyToTopicGroup сам по себе уже даёт
      // нужное: квартиры с известным районом уходят в свою тему, без
      // района — в "General" СВОЕЙ группы (но по-прежнему только
      // квартиры), а дома/коммерция — только в свои отдельные группы.
      const sentTo = await notifyToTopicGroup(listing);
      await markNotified(listing.id, sentTo);
      console.log(`[${sourceLabel}] уведомление отправлено (${label.kind}): ${listing.title}`);
    } catch (err) {
      console.error('Ошибка отправки в Telegram:', err.message);
    }

    await new Promise((r) => setTimeout(r, 1200));
  }

  // Само-диагностика: если больше трети OLX-объявлений в этом прогоне
  // не дали найти ссылку на профиль продавца — это почти наверняка
  // значит, что OLX поменял вёрстку/текст кнопки, и жёсткое правило
  // "риэлтор по числу объявлений" массово не срабатывает. Раньше такая
  // поломка была не видна вообще никак, кроме как по жалобе через
  // несколько дней — теперь шлём алерт сразу, в этом же прогоне.
  // Порог (30%, минимум 5 проверенных) взят с запасом, чтобы не спамить
  // из-за пары случайных сбоев сети на конкретных страницах.
  if (sellerCheckedCount >= 5 && sellerLinkMissingCount / sellerCheckedCount > 0.3) {
    await notifyAlert(
      `⚠️ [${sourceLabel}] не найдена ссылка на профиль продавца у ${sellerLinkMissingCount} из ${sellerCheckedCount} объявлений. ` +
      `Похоже, OLX поменял вёрстку — проверка "риэлтор по числу объявлений" может массово не срабатывать. Нужно проверить scrapers/olx.js.`
    );
  }
}

// OLX: квартиры + дома + коммерция. Uybor пока только квартиры — для
// домов/коммерции у Uybor нужны их внутренние category__eq ID (сейчас
// известен только id=7 для квартир), см. TODO в scrapers/uybor.js.
// Realting: квартиры + дома + коммерция, продажа и аренда (для
// продажи используются готовые /fsbo-страницы сайта, для аренды —
// фильтрация по метке "Частный продавец" внутри scrapers/realting.js).
const OLX_PROPERTY_TYPES = ['apartment', 'house', 'commercial'];
const REALTING_PROPERTY_TYPES = ['apartment', 'house', 'commercial'];

async function main() {
  // Продажа — в приоритете, проверяем её первой в каждом цикле
  for (const propertyType of OLX_PROPERTY_TYPES) {
    await processSource(fetchOlxListings, fetchOlxDetails, 'olx', 'sale', fetchOlxSellerListingsCount, propertyType);
  }
  await processSource(fetchUyborListings, fetchUyborDetails, 'uybor', 'sale');
  for (const propertyType of REALTING_PROPERTY_TYPES) {
    await processSource(fetchRealtingListings, fetchRealtingDetails, 'realting', 'sale', null, propertyType);
  }

  for (const propertyType of OLX_PROPERTY_TYPES) {
    await processSource(fetchOlxListings, fetchOlxDetails, 'olx', 'rent', fetchOlxSellerListingsCount, propertyType);
  }
  await processSource(fetchUyborListings, fetchUyborDetails, 'uybor', 'rent');
  for (const propertyType of REALTING_PROPERTY_TYPES) {
    await processSource(fetchRealtingListings, fetchRealtingDetails, 'realting', 'rent', null, propertyType);
  }
  console.log('Проверка завершена.');

  // Автоматическая чистка по расписанию: раз в 15 минут, вместе со
  // скрапингом. Удаляет только то, у чего уже есть сохранённый
  // telegram_chat_id/telegram_message_id (новые объявления, помеченные
  // агентом в этом же прогоне выше, или вручную кнопкой "Это агент" в
  // Telegram). Старый мусор без сохранённого id сюда не попадает — для
  // него нужен разовый backfill-from-telegram-export.js.
  try {
    console.log('Автоочистка агентских сообщений...');
    const { totalCandidates, deleted, failed } = await cleanAgentBacklog({ quiet: true });
    if (totalCandidates > 0) {
      console.log(`Автоочистка: удалено ${deleted}, не удалось ${failed} (из ${totalCandidates} кандидатов).`);
    } else {
      console.log('Автоочистка: чистить нечего.');
    }
  } catch (err) {
    console.error('Автоочистка агентских сообщений: ошибка:', err.message);
  }
}

main().catch((err) => {
  console.error('Критическая ошибка:', err);
  process.exit(1);
});