import 'dotenv/config';
import { fetchOlxListings, fetchOlxDetails, fetchOlxSellerListingsCount } from './scrapers/olx.js';
import { fetchUyborListings, fetchUyborDetails } from './scrapers/uybor.js';
import { fetchRealtingListings, fetchRealtingDetails } from './scrapers/realting.js';
import { classifyListing, labelFor, SELLER_LISTINGS_AGENT_THRESHOLD } from './classify.js';
import { notifyNewListing, notifyAlert } from './telegram.js';
import { isKnown, saveListing, markNotified } from './db.js';
import { normalizeDistrict } from './districts.js';
import { parsePrice } from './priceParser.js';

const PHONE_REGEX = /(\+?998[\s\-]?\d{2}[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2})/;
const USE_AI_CLASSIFICATION = process.env.USE_AI_CLASSIFICATION === 'true';

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

  for (const item of items) {
    if (await isKnown(item.id)) continue;

    let rawText = item.title;
    let sellerName = null;
    let sellerListingsUrl = null;
    try {
      const details = await fetchDetails(item.url);
      if (details?.description) rawText = `${item.title}\n${details.description}`;
      sellerName = details?.sellerName || item.seller_name || null;
      sellerListingsUrl = details?.sellerListingsUrl || null;
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

    if (fetchSellerCount && sellerListingsUrl) {
      sellerListingsCount = await fetchSellerCount(sellerListingsUrl);
      if (sellerListingsCount !== null && sellerListingsCount > SELLER_LISTINGS_AGENT_THRESHOLD) {
        isConfirmedAgent = true;
        confirmedAgentReason = `${sellerListingsCount} объявлений`;
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
      classification = {
        seller_type: 'unknown',
        confidence: 'n/a',
        district: null,
        rooms: null,
        area: null,
        phone: null,
      };
      label = { text: 'Без проверки ИИ', kind: 'unchecked' };
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
    // друг с другом). Приоритет источников:
    //  1. Структурное поле с самого сайта (пока только Uybor,
    //     item.raw_district) — самое надёжное.
    //  2. Район, который вернула ИИ-классификация (если включена).
    //  3. Fallback без ИИ: ищем упоминание района прямо в тексте
    //     объявления — работает и без USE_AI_CLASSIFICATION.
    const district =
      normalizeDistrict(item.raw_district) ||
      normalizeDistrict(classification.district) ||
      normalizeDistrict(rawText);
    const districtRaw = item.raw_district || classification.district || null;

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
      phone: classification.phone || phoneFromApi || phoneFromText,
      seller_type: classification.seller_type,
      confidence: classification.confidence,
      label_text: label.text,
      label_kind: label.kind,
      notified: false,
    };
    delete listing.phone_from_api; // служебное поле, в базу не пишем
    delete listing.raw_district; // тоже служебное — уже перенесено в district/district_raw

    await saveListing(listing);

    // Раньше подтверждённые агентства вообще не отправлялись в Telegram.
    // Теперь отправляем всех — просто с понятной меткой ("🏢 Агентство"),
    // чтобы риелторские объявления тоже было видно и можно было по ним
    // фильтровать/искать через бота, а собственники остаются в приоритете
    // (см. label_kind и сортировку в _priority.js / боте).
    try {
      await notifyNewListing(listing);
      await markNotified(listing.id);
      console.log(`[${sourceLabel}] уведомление отправлено (${label.kind}): ${listing.title}`);
    } catch (err) {
      console.error('Ошибка отправки в Telegram:', err.message);
    }

    await new Promise((r) => setTimeout(r, 1200));
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
}

main().catch((err) => {
  console.error('Критическая ошибка:', err);
  process.exit(1);
});
