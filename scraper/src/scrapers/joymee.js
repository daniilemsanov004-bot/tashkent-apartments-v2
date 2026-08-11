import { getWithRetry } from '../http.js';

// ЧЕТВЁРТЫЙ ИСТОЧНИК: joymee.uz — платформа объявлений о недвижимости
// по Узбекистану. ПОДТВЕРЖДЕНО ВЖИВУЮ 11.08.2026 через DevTools →
// Network на joymee.uz:
//
//   Список:  GET https://api.joymee.uz/api/v1/announcement/
//            ?deal_type=3&region=59&country=1&perPagePlain=N&page=1
//            → { page, total_pages, next, previous, total_count,
//                filtered_count, results: [ {...} ] }
//
//   Деталь:  GET https://api.joymee.uz/api/v1/announcement/{id}/
//            → полный объект объявления (описание, телефон, район,
//              продавец, advertiser_type и т.д.)
//
// Самое важное подтверждённое поле — "advertiser_type" в ОТВЕТЕ
// ДЕТАЛЬНОГО запроса (в списке его НЕТ, только в /announcement/{id}/):
//   advertiser_type: 1 → на странице объявления написано "Кто
//                         разместил: Собственник" (проверено на
//                         объявлении id=287608)
//   advertiser_type: 2 → на странице написано "Агентство"/риелтор
//                         (проверено на объявлении id=390907,
//                         seller.bio = "Агенство Недвижимости...")
// Другие значения не встречались — на всякий случай ТРЕТЬИМ (не
// подтверждённым) значением тоже считаем "не собственник", чтобы не
// пропустить агента по ошибке (см. sellerNameLooksLikeAgent ниже).
//
// НЕ подтверждено (TODO, см. также run.js):
//   - deal_type для аренды (deal_type=3 подтверждён ТОЛЬКО для
//     "Продажа"; посуточная/аренда не проверялись — не гадаем,
//     чтобы случайно не притащить не те объявления под видом аренды).
//   - category/property_type для домов и коммерции (подтверждено
//     только property_type=1 + category=8 — это категория "квартиры",
//     видно на двух реальных объявлениях).
//   - настоящий URL страницы объявления на самом сайте (joymee.uz) —
//     видели только API-эндпоинт деталей, реальный фронтенд-адрес
//     карточки в браузере не зафиксирован. Ниже используется
//     https://joymee.uz/announcement/{id} как правдоподобная
//     заглушка-ссылка для Telegram-уведомлений; исправить, когда
//     кто-то откроет объявление и посмотрит адресную строку.
//   - есть ли отдельная страница "все объявления продавца" (аналог
//     OLX/Uybor) — если да, можно так же считать число объявлений
//     риелтора; пока sellerListingsUrl всегда null.

const JOYMEE_API = 'https://api.joymee.uz/api/v1/announcement/';
const JOYMEE_DETAIL_API = (id) => `https://api.joymee.uz/api/v1/announcement/${id}/`;

// region=59 ("Toshkent shahri") и country=1 ("O'zbekiston") —
// подтверждены вживую (видны в ответах API и в district/region/
// country объектах внутри объявлений).
const JOYMEE_REGION_TASHKENT = 59;
const JOYMEE_COUNTRY_UZ = 1;

// deal_type — подтверждено ТОЛЬКО значение для продажи (3). Для
// аренды намеренно оставляем null и не гадаем: если позже кто-то
// подтвердит реальное значение через DevTools (открыть вкладку
// "Аренда" на сайте и посмотреть параметр deal_type в Network),
// просто заменить null на найденное число.
const JOYMEE_DEAL_TYPE = {
  sale: 3,
  rent: null, // TODO: не подтверждено
};

// category/property_type — подтверждено только для квартир (оба поля
// видны в реальных ответах API: property_type=1, category=8).
const JOYMEE_CATEGORY = {
  apartment: { property_type: 1, category: 8 },
  house: null, // TODO: не подтверждено
  commercial: null, // TODO: не подтверждено
};

// Сколько объявлений забирать за один запрос списка. Не подтверждено
// вживую, что perPagePlain можно задавать произвольно большим — пока
// используем то же значение, что видели в реальных запросах сайта
// (10), чтобы не выглядеть подозрительно на фоне обычного трафика.
const JOYMEE_PER_PAGE = 10;

// Фильтруем только сегодняшние объявления — тот же принцип, что у
// OLX/Uybor: не тащим в базу старые объявления, поднятые платным
// продвижением. Поле с датой публикации — "ads_at" (подтверждено и в
// списке, и в деталях).
function isToday(dateStr) {
  if (!dateStr) return true;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return true;
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

/**
 * @param {'rent'|'sale'} dealType
 * @param {'apartment'|'house'|'commercial'} propertyType
 */
export async function fetchJoymeeListings(dealType = 'rent', propertyType = 'apartment') {
  const dealTypeValue = JOYMEE_DEAL_TYPE[dealType];
  const categoryInfo = JOYMEE_CATEGORY[propertyType];

  if (dealTypeValue == null) {
    console.warn(`[joymee-${propertyType}-${dealType}] deal_type для "${dealType}" не подтверждён — пропускаю (см. TODO в scrapers/joymee.js)`);
    return [];
  }
  if (!categoryInfo) {
    console.warn(`[joymee-${propertyType}-${dealType}] category/property_type для "${propertyType}" не подтверждены — пропускаю (см. TODO в scrapers/joymee.js)`);
    return [];
  }

  const { data } = await getWithRetry(JOYMEE_API, {
    params: {
      deal_type: dealTypeValue,
      property_type: categoryInfo.property_type,
      category: categoryInfo.category,
      region: JOYMEE_REGION_TASHKENT,
      country: JOYMEE_COUNTRY_UZ,
      perPagePlain: JOYMEE_PER_PAGE,
      page: 1,
    },
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
    },
    timeout: 15000,
  });

  // Подтверждено вживую: объявления лежат в data.results (объект с
  // пагинацией — page/total_pages/next/previous/total_count/
  // filtered_count/results). Оставляем запасные варианты на случай,
  // если структура немного отличается для других параметров.
  const items = data?.results || data?.data || data?.items || (Array.isArray(data) ? data : []);

  console.log(`[joymee-${propertyType}-${dealType}] получено ${items.length} объявлений от API (total_count=${data?.total_count ?? '?'}, filtered_count=${data?.filtered_count ?? '?'})`);
  if (items[0]) {
    console.log(`[joymee-${propertyType}-${dealType}] пример сырого объявления:`, JSON.stringify(items[0]).slice(0, 1200));
  }

  const listings = [];
  for (const item of items) {
    const postedRaw = item.ads_at || '';
    if (!isToday(postedRaw)) continue;

    const id = item.id;
    if (!id) continue;

    const title = item.title || 'Без названия';

    const priceValue = item.pricing?.price ?? '';
    const priceCurrencyDisplay = item.pricing?.currency_display || '';
    const price = priceValue ? `${Number(priceValue) || priceValue} ${priceCurrencyDisplay}`.trim() : '';

    // advertiser_type (собственник/агентство) в списке НЕ приходит —
    // только в детальном запросе (см. fetchJoymeeDetails ниже,
    // sellerNameLooksLikeAgent). На этапе списка структурного признака
    // нет, поэтому seller_is_organization пока всегда false — решение
    // принимается позже, когда придут детали.
    const sellerIsOrganization = false;
    const sellerName = item.created_by?.full_name || item.created_by?.username || null;

    // Район в списке приходит только как часть текстовой строки
    // address_line ("Toshkent shahri, Yunusobod tumani"), а не как
    // структурный объект (структурный district есть только в
    // деталях) — намеренно НЕ парсим его тут, чтобы не подменить
    // собой более надёжный district.name из fetchJoymeeDetails (см.
    // приоритет источников района в run.js: raw_district не
    // перезаписывается, если уже заполнен).
    const rawDistrict = null;

    const imageUrl = item.image || null;

    listings.push({
      id: `joymee_${id}`,
      source: 'joymee',
      deal_type: dealType,
      property_type: propertyType,
      // TODO: настоящий фронтенд-URL не подтверждён, см. комментарий
      // в шапке файла. Формат ниже — правдоподобная заглушка.
      url: `https://joymee.uz/announcement/${id}`,
      title,
      price,
      posted_raw: postedRaw || 'неизвестно',
      phone_from_api: null, // в списке телефона нет, только в деталях
      seller_is_organization: sellerIsOrganization,
      seller_name: sellerName,
      raw_district: rawDistrict,
      image_url: imageUrl,
    });
  }

  return listings;
}

/**
 * Детали объявления — здесь и только здесь приходит advertiser_type
 * (1 = собственник, всё остальное = не собственник), полный телефон,
 * структурный район (district.name) и описание.
 *
 * ВАЖНО: url приходит из item.url (см. fetchJoymeeListings выше) — из
 * него достаём числовой id простым regex по последним цифрам пути.
 * Это устойчиво к тому, что настоящий формат ссылки на сайте пока не
 * подтверждён (id всегда есть в конце заглушки-URL).
 */
export async function fetchJoymeeDetails(url) {
  const idMatch = String(url || '').match(/(\d+)\/?$/);
  const id = idMatch ? idMatch[1] : null;
  if (!id) {
    console.warn(`[joymee] не удалось извлечь id объявления из URL: ${url}`);
    return { description: '', sellerName: null, sellerListingsUrl: null };
  }

  const { data: item } = await getWithRetry(JOYMEE_DETAIL_API(id), {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
    },
    timeout: 15000,
  });

  // advertiser_type: 1 подтверждено = "Собственник" на странице
  // объявления. Всё, что НЕ строго равно 1 (включая 2 = агентство и
  // любые другие непроверенные значения), намеренно считаем "похоже
  // на агентство" — лучше по ошибке пометить редкого собственника как
  // непроверенного, чем пропустить агентство в уведомления.
  const advertiserType = item?.advertiser_type;
  const sellerNameLooksLikeAgent = advertiserType !== 1;
  if (sellerNameLooksLikeAgent) {
    console.log(`[joymee] объявление ${id}: advertiser_type=${advertiserType} — считаю не собственником`);
  }

  const seller = item?.seller || {};
  const sellerName =
    [seller.first_name, seller.last_name].filter(Boolean).join(' ').trim() ||
    seller.username ||
    null;

  const phone = item?.phone_number || null;
  const locationDistrict = item?.district?.name || null;

  const priceValue = item?.pricing?.price ?? '';
  const priceCurrencyDisplay = item?.pricing?.currency_display || '';
  const ldPrice = priceValue ? `${Number(priceValue) || priceValue} ${priceCurrencyDisplay}`.trim() : null;

  const imageUrl = extractJoymeeDetailImage(item);

  return {
    description: item?.description || '',
    sellerName,
    // TODO: не подтверждено, есть ли у Joymee отдельная страница
    // "все объявления продавца" (как на OLX/Uybor) — пока всегда null.
    sellerListingsUrl: null,
    authorAdsCountHint: null,
    sellerNameLooksLikeAgent,
    locationDistrict,
    phone,
    ldPrice,
    imageUrl,
  };
}

// Подтверждённая структура: media — массив { file: { url }, order,
// is_cover }. Берём объявленную обложку (is_cover: true), если есть,
// иначе первый элемент по порядку.
function extractJoymeeDetailImage(item) {
  const media = item?.media;
  if (!Array.isArray(media) || media.length === 0) return null;
  const cover = media.find((m) => m?.is_cover) || media[0];
  return cover?.file?.url || null;
}
