import * as cheerio from 'cheerio';
import { getWithRetry } from '../http.js';
import { parsePrice } from '../priceParser.js';

// Два раздела — аренда и продажа квартир по Ташкенту. Забираем ВСЕ
// объявления в каждом, не только помеченные сайтом "от собственника"
// (часть реальных собственников просто не ставят эту галочку).
// Фильтрацию собственник/агент делает классификация в classify.js.
// Три категории недвижимости — у каждой свой URL-паттерн (проверено
// вживую на olx.uz). property_type пишем в объявление, чтобы отличать
// их на сайте/в боте фильтром.
export const OLX_CATEGORIES = {
  apartment: {
    rent: 'https://www.olx.uz/nedvizhimost/kvartiry/arenda-dolgosrochnaya/tashkent/',
    sale: 'https://www.olx.uz/nedvizhimost/kvartiry/prodazha/tashkent/',
  },
  house: {
    rent: 'https://www.olx.uz/nedvizhimost/doma/arenda-dolgosrochnaya/tashkent/',
    sale: 'https://www.olx.uz/nedvizhimost/doma/prodazha/tashkent/',
  },
  commercial: {
    // у коммерции на OLX аренда называется просто "arenda", без "-dolgosrochnaya"
    rent: 'https://www.olx.uz/nedvizhimost/kommercheskie-pomeshcheniya/arenda/tashkent/',
    sale: 'https://www.olx.uz/nedvizhimost/kommercheskie-pomeshcheniya/prodazha/tashkent/',
  },
};

// Оставлено для обратной совместимости (старые импорты в run.js/тестах).
export const OLX_URLS = OLX_CATEGORIES.apartment;

const LISTING_LINK_RE = /\/d\/obyavlenie\/[^"'\s]*-ID([a-zA-Z0-9]+)\.html/;
// Раньше было [\d\s]{3,} — "любой набор цифр и пробелов от 3 символов"
// перед "сум"/"у.е.". Проблема: это могло случайно склеить цену с
// соседним числом без разделителя-не-цифры (например, "3/9 4 596 985
// сум" — этаж "3/9" отделён слэшем, но следующая цифра "9" после
// пробела уже воспринималась как начало цены, и вместо "4 596 985"
// получалось "9 4 596 985" → лишняя цифра спереди, цена в 10 раз
// больше реальной). Теперь требуем ПРАВИЛЬНОЕ разбиение по разрядам
// (группы ровно по 3 цифры через пробел, как OLX и форматирует суммы:
// "4 596 985") — так число "9 4 596 985" не пройдёт как одна цена,
// потому что "9 4" — не валидная группа разрядов.
const PRICE_RE = /\d{1,3}(?:[\s\u00A0]\d{3})*\s*(?:сум|у\.?\s?е\.?)/i;

// Второй уровень защиты от кривой цены (после ужесточения самого
// PRICE_RE выше) — грубая проверка "разумных границ" рынка Ташкента.
// Если распарсенное число вообще не лезет ни в какие ворота для этого
// типа сделки — лучше не показывать цену, чем показать в 10 раз
// завышенную/заниженную из-за случайно захваченной соседней цифры.
// Границы намеренно широкие (с запасом), чтобы не резать реальные
// дорогие/дешёвые варианты — это просто "не бывает такого" фильтр.
const PLAUSIBLE_RANGES = {
  rent: { UZS: [200000, 150000000], USD: [20, 15000] },
  sale: { UZS: [30000000, 200000000000], USD: [2000, 15000000] },
};

function isPlausiblePrice(rawPrice, dealType) {
  if (!rawPrice) return true; // пустую цену не трогаем — это отдельный случай
  const { value, currency } = parsePrice(rawPrice);
  if (value === null || !currency) return true; // не смогли распарсить — не блокируем
  const ranges = PLAUSIBLE_RANGES[dealType] || PLAUSIBLE_RANGES.rent;
  const range = ranges[currency];
  if (!range) return true;
  return value >= range[0] && value <= range[1];
}

// OLX подписывает карточки датой публикации: "Сегодня в 14:23", "Вчера в 09:10"
// или конкретной датой ("30 июля"). Нас интересуют ТОЛЬКО сегодняшние —
// иначе в базу лезут старые объявления, поднятые в топ платным продвижением.
const TODAY_RE = /сегодня/i;
const DATE_META_RE = /(сегодня|вчера)\s*(?:в\s*\d{1,2}:\d{2})?|(\d{1,2}\s?(?:янв|фев|мар|апр|ма[йя]|июн|июл|авг|сен|окт|ноя|дек)[а-я]*)/i;

/**
 * @param {'rent'|'sale'} dealType
 * @param {'apartment'|'house'|'commercial'} propertyType
 */
export async function fetchOlxListings(dealType = 'rent', propertyType = 'apartment') {
  const url = OLX_CATEGORIES[propertyType][dealType];
  const { data: html } = await getWithRetry(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'ru-RU,ru;q=0.9',
    },
    timeout: 15000,
  });

  const $ = cheerio.load(html);
  const seen = new Map(); // externalId -> listing, чтобы не дублировать
  let skippedOld = 0;

  // Ищем ВСЕ ссылки на страницы объявлений (шаблон /d/obyavlenie/...-IDxxxx.html) —
  // это устойчивее к смене CSS-классов, чем привязка к конкретному
  // data-атрибуту вроде data-cy="l-card".
  $('a[href*="/d/obyavlenie/"]').each((_, el) => {
    const link = $(el);
    const href = link.attr('href') || '';
    const idMatch = href.match(LISTING_LINK_RE);
    if (!idMatch) return;

    const externalId = idMatch[1];
    if (seen.has(externalId)) return; // уже нашли эту карточку через другую ссылку (картинка/заголовок)

    const fullUrl = href.startsWith('http') ? href : `https://www.olx.uz${href}`;

    // Заголовок — берём текст самой ссылки; если пусто (ссылка на картинку) —
    // пробуем alt у картинки внутри неё. Сначала убираем <style>/<script>,
    // которые OLX иногда вставляет прямо внутрь карточки (scoped-стили) —
    // без этого .text() захватывал бы CSS-код вместо реального заголовка.
    const linkClone = link.clone();
    linkClone.find('style, script').remove();
    let title = linkClone.text().trim();
    if (!title) {
      title = link.find('img').attr('alt')?.trim() || '';
    }
    if (!title || title.startsWith('.css-')) return; // мусор вместо заголовка — пропускаем

    // Цену и дату публикации ищем в ближайшем родительском блоке-карточке.
    // ВАЖНО: раньше здесь поднимались вверх на 5 уровней БЕЗ проверки, не
    // вышли ли мы уже за пределы карточки этого объявления — на сеточной
    // вёрстке OLX 3-4 уровня вверх обычно попадают в общий контейнер сразу
    // нескольких карточек, и regex цены мог выхватить цену СОСЕДНЕГО
    // объявления. Из-за этого у многих объявлений цена была неправильной.
    // Теперь останавливаемся, как только в контейнере находится больше
    // одного РАЗНЫХ объявления (считаем по уникальным ID из ссылок, а не
    // по числу тегов <a> — у карточки обычно 2 ссылки на один и тот же
    // объект: картинка + заголовок).
    let price = '';
    let dateRaw = '';
    let container = link.parent();
    for (let i = 0; i < 6 && container.length; i++) {
      const idsInside = new Set();
      container.find('a[href*="/d/obyavlenie/"]').each((_, a) => {
        const m = ($(a).attr('href') || '').match(LISTING_LINK_RE);
        if (m) idsInside.add(m[1]);
      });
      if (idsInside.size > 1) break; // вышли за пределы карточки — не читаем дальше

      const text = container.text();
      if (!price) {
        const priceMatch = text.match(PRICE_RE);
        if (priceMatch && isPlausiblePrice(priceMatch[0], dealType)) {
          price = priceMatch[0].trim();
        }
        // если цена нашлась, но выглядит неправдоподобно — НЕ берём её и
        // НЕ помечаем price как найденную, идём выше по DOM ещё на
        // уровень в надежде найти корректную; если так и не найдём —
        // просто останется пустой (см. posted_raw ниже, аналогично)
      }
      if (!dateRaw) {
        const dateMatch = text.match(DATE_META_RE);
        if (dateMatch) dateRaw = dateMatch[0].trim();
      }
      if (price && dateRaw) break;
      container = container.parent();
    }

    // Если дату не нашли вообще — не рискуем отбрасывать объявление
    // (лучше показать лишнее, чем упустить), помечаем как "неизвестно".
    // Если дата есть и это НЕ "сегодня" — пропускаем, это старый пост.
    const isToday = !dateRaw || TODAY_RE.test(dateRaw);
    if (!isToday) {
      skippedOld++;
      return;
    }

    seen.set(externalId, {
      id: `olx_${externalId}`,
      source: 'olx',
      deal_type: dealType, // 'rent' | 'sale'
      property_type: propertyType, // 'apartment' | 'house' | 'commercial'
      url: fullUrl,
      title,
      price,
      posted_raw: dateRaw || 'неизвестно',
    });
  });

  if (skippedOld > 0) {
    console.log(`[olx-${dealType}] пропущено ${skippedOld} старых объявлений (не "сегодня")`);
  }

  return Array.from(seen.values());
}

/**
 * Заходит на страницу конкретного объявления и вытаскивает:
 * - полный текст описания (для классификации собственник/агент)
 * - имя продавца (ещё один сигнал для классификации)
 * - ссылку "Все объявления автора" (чтобы посчитать, сколько у него
 *   объявлений — если много, это почти наверняка агентство)
 */
/**
 * OLX кладёт на КАЖДУЮ страницу объявления структурированный блок
 * <script type="application/ld+json"> (schema.org/Product) — для
 * поисковиков, но нам он тоже полезен: там надёжно, без хрупкого
 * парсинга вёрстки, лежат sku (числовой ID — нужен для запроса
 * телефона, см. fetchOlxPhone), цена+валюта и район (areaServed.name).
 * Подтверждено вживую 06.08.2026 (реальный HTML конкретного
 * объявления), формат:
 *   { "sku": "65297366",
 *     "offers": { "price": 8, "priceCurrency": "USD" },
 *     "offers": { "areaServed": { "name": "Юнусабадский район" } } }
 */
function parseJsonLd($) {
  let result = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (result) return;
    try {
      const json = JSON.parse($(el).contents().text());
      if (json && json['@type'] === 'Product') result = json;
    } catch {
      // не JSON-LD или битый — пропускаем, это не критично, есть fallback'и
    }
  });
  return result;
}

export async function fetchOlxDetails(url) {
  const { data: html } = await getWithRetry(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 15000,
  });
  const $ = cheerio.load(html);
  const description = $('[data-cy="ad_description"]').text().trim();

  const jsonLd = parseJsonLd($);
  const offerId = jsonLd?.sku || null;

  // Телефон — через подтверждённый вживую эндпоинт (см. fetchOlxPhone).
  // Работает только если нашли числовой ID в JSON-LD; если нет — просто
  // не будет номера с этого источника, останется fallback на текст
  // описания (см. PHONE_REGEX в run.js).
  let phone = null;
  if (offerId) {
    phone = await fetchOlxPhone(offerId);
  }

  // Цена и район из JSON-LD — надёжнее регулярок по вёрстке, но не
  // всегда достоверны (например, у коммерции offers.price иногда
  // указан "за м²", а не общей суммой) — поэтому это ДОПОЛНИТЕЛЬНЫЙ
  // источник, itog price всё ещё проходит через isPlausiblePrice в
  // fetchOlxListings, откуда берётся основная цена. Здесь просто
  // возвращаем как альтернативу, run.js решает, что использовать.
  let ldPrice = null;
  if (jsonLd?.offers?.price && jsonLd?.offers?.priceCurrency) {
    const currencyLabel = jsonLd.offers.priceCurrency === 'USD' ? 'у.е.' : 'сум';
    ldPrice = `${jsonLd.offers.price} ${currencyLabel}`;
  }
  const ldDistrict = jsonLd?.offers?.areaServed?.name || jsonLd?.areaServed?.name || null;

  // Блок "МЕСТОПОЛОЖЕНИЕ" на странице объявления — запасной вариант на
  // случай, если в JSON-LD района нет (fallback, менее надёжный, чем
  // ldDistrict выше, — ищем по тексту всей страницы, так как точный
  // CSS-класс блока не подтверждён вживую).
  const bodyText = $('body').text().replace(/\s+/g, ' ');
  const locationMatch = bodyText.match(/Ташкент\s*,\s*([А-ЯЁ][а-яё-]+\s+район)/i);
  const locationDistrict = ldDistrict || (locationMatch ? locationMatch[1].trim() : null);

  // Ссылка на профиль продавца — раньше искали только по тексту самой
  // кнопки, но это хрупко: OLX уже дважды менял формулировку (сначала
  // "Все объявления автора" пропало как ссылка вообще, теперь рядом
  // есть отдельная ссылка "Смотреть все" — а это слишком общая фраза,
  // чтобы искать её по всей странице: такой же текст бывает у других
  // каруселей вроде "Похожие объявления", и можно случайно схватить
  // не ту ссылку). Порядок проверок — от самого надёжного к самому
  // общему:
  //  1) href-паттерн "/o/..." — это сам путь профиля продавца на OLX,
  //     не зависит от текста/локализации кнопки вообще;
  //  2) точный/предсказуемый текст ссылки ("все объявления автора" и
  //     т.п.);
  //  3) "смотреть все" — но ТОЛЬКО внутри контейнера заголовка "Все
  //     объявления автора", а не по всей странице.
  let sellerListingsUrl = null;
  let authorLinkEl = null;

  $('a[href^="/o/"], a[href*="olx.uz/o/"]').each((_, el) => {
    if (sellerListingsUrl) return;
    const href = $(el).attr('href');
    if (href) {
      sellerListingsUrl = href.startsWith('http') ? href : `https://www.olx.uz${href}`;
      authorLinkEl = el;
    }
  });

  const AUTHOR_LINK_TEXT_RE = /все\s+объявлени|объявлени[яй]\s+(?:автора|продавца)|профиль\s+продавца/i;
  if (!sellerListingsUrl) {
    $('a').each((_, el) => {
      if (sellerListingsUrl) return;
      const text = $(el).text().trim().toLowerCase();
      if (AUTHOR_LINK_TEXT_RE.test(text)) {
        const href = $(el).attr('href');
        if (href) {
          sellerListingsUrl = href.startsWith('http') ? href : `https://www.olx.uz${href}`;
          authorLinkEl = el;
        }
      }
    });
  }

  if (!sellerListingsUrl) {
    // Заголовок "Все объявления автора" — сейчас (08.08.2026) это уже
    // не ссылка, а обычный текст (h2/div), рядом с ним отдельная
    // ссылка "Смотреть все". Ищем именно эту пару: заголовок → ближайшая
    // ссылка "смотреть все" В ЕГО ЖЕ КОНТЕЙНЕРЕ (родитель/дед), чтобы не
    // подхватить одноимённую ссылку у другой карусели на странице.
    const heading = $('*')
      .filter((_, el) => {
        const own = $(el).clone().children().remove().end().text().trim().toLowerCase();
        return own === 'все объявления автора';
      })
      .first();
    if (heading.length) {
      const container = heading.closest('section, div').length ? heading.closest('section, div') : heading.parent();
      const link = container.find('a').filter((_, el) => /смотреть\s*все/i.test($(el).text())).first();
      const href = link.attr('href');
      if (href) {
        sellerListingsUrl = href.startsWith('http') ? href : `https://www.olx.uz${href}`;
        authorLinkEl = link.get(0);
      }
    }
  }

  // Доп. сигнал: OLX иногда пишет число объявлений автора прямо в
  // тексте рядом с кнопкой, например "Все объявления автора (34)".
  // Если удалось выцепить это число — сохраняем как подстраховку на
  // случай, если сама страница профиля не откроется/не распарсится
  // (fetchOlxSellerListingsCount вернёт null) — тогда в run.js можно
  // использовать этот hint вместо того, чтобы просто сдаваться.
  // ВНИМАНИЕ: в отличие от fetchOlxSellerListingsCount, это число
  // может включать объявления НЕ из недвижимости (та же причина бага,
  // из-за которого раньше все считались агентами) — поэтому в run.js
  // это используется только как fallback, не как основной сигнал.
  let authorAdsCountHint = null;
  if (authorLinkEl) {
    const nearbyText = $(authorLinkEl).text() + ' ' + $(authorLinkEl).parent().text();
    const countMatch = nearbyText.match(/\((\d+)\)|(\d+)\s*объявлен/i);
    const num = countMatch ? Number(countMatch[1] || countMatch[2]) : null;
    if (Number.isFinite(num)) authorAdsCountHint = num;
  }

  // Имя продавца — точный селектор не подтверждён вживую, пробуем
  // несколько распространённых вариантов разметки OLX.
  let sellerName =
    $('[data-cy="seller_name"]').text().trim() ||
    $('[data-testid="seller-name"]').text().trim() ||
    '';
  if (!sellerName && authorLinkEl) {
    // запасной вариант: заголовок рядом с найденной ссылкой на профиль
    sellerName = $(authorLinkEl).closest('div').find('h4, h3, [class*="name"]').first().text().trim();
  }

  return {
    description,
    sellerName: sellerName || null,
    sellerListingsUrl,
    authorAdsCountHint,
    locationDistrict,
    phone,
    ldPrice,
  };
}

/**
 * Считает, сколько ВСЕГО объявлений у продавца на его странице
 * "Все объявления автора" — в любой категории OLX, не только
 * недвижимость. Если их заметно больше одного-двух — это почти
 * наверняка агентство/риелтор, даже если сам текст объявления
 * звучит по-человечески.
 *
 * ВАЖНО (сознательный компромисс, а не забытый баг): раньше здесь был
 * фильтр по слагу ссылки (REAL_ESTATE_SLUG_RE), чтобы не считать
 * "трусы"/телефон/диван и т.п., которые обычный человек может заодно
 * продавать. Но из-за этого агентства, чьи объявления на OLX попадают
 * под нестандартные слаги (не совпадающие с регуляркой), недосчитывались
 * и проходили как "не агент" — то есть агентский спам снова начинал
 * просачиваться в уведомления. По явному решению — считаем ВСЕ
 * объявления продавца без разбора категории: пропустить агентство хуже,
 * чем изредка ошибочно пометить активного частника, который параллельно
 * продаёт что-то ещё.
 *
 * Возвращает null при ошибке (тогда просто не применяем это правило).
 */
export async function fetchOlxSellerListingsCount(sellerListingsUrl) {
  if (!sellerListingsUrl) return null;
  try {
    const { data: html } = await getWithRetry(
      sellerListingsUrl,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 },
      2
    );
    const $ = cheerio.load(html);
    const ids = new Set();
    $('a[href*="/d/obyavlenie/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(LISTING_LINK_RE);
      if (m) ids.add(m[1]);
    });
    return ids.size;
  } catch (err) {
    console.warn(`Не удалось посчитать объявления продавца (${sellerListingsUrl}):`, err.message);
    return null;
  }
}

/**
 * Номер телефона на OLX скрыт за кнопкой "показать номер" и
 * подгружается отдельным запросом к их внутреннему API. Эндпоинт и
 * формат ответа ПОДТВЕРЖДЕНЫ ВЖИВУЮ 06.08.2026 (через DevTools →
 * Network на реальном объявлении):
 *   GET https://www.olx.uz/api/v1/offers/{offerId}/limited-phones/
 *   → { "data": { "phones": ["+99 893 1804767"] } }
 * offerId — это ЧИСЛОВОЙ ID (не то же самое, что буквенно-цифровой код
 * из URL объявления вроде "ID4pYww") — берём его из sku в JSON-LD
 * блока на странице объявления, см. parseJsonLd/fetchOlxDetails выше.
 */
export async function fetchOlxPhone(offerId) {
  try {
    const { data } = await getWithRetry(
      `https://www.olx.uz/api/v1/offers/${offerId}/limited-phones/`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'application/json',
        },
        timeout: 10000,
      },
      2
    );
    return data?.data?.phones?.[0] || null;
  } catch (err) {
    console.warn(`Не удалось получить телефон (offerId=${offerId}):`, err.message);
    return null;
  }
}