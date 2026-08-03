import { getWithRetry } from '../http.js';

// Найдено через DevTools → Network → Fetch/XHR на uybor.uz.
// operationType__eq принимает 'rent' | 'sale' напрямую — совпадает
// с нашими значениями dealType, поэтому передаём как есть.
const UYBOR_API = 'https://api.uybor.uz/api/v1/listings';

const REGION_TASHKENT = 13;
const CATEGORY_APARTMENTS = 7;

// Сегодняшняя дата — фильтруем так же, как и OLX, чтобы не тащить
// в базу старые объявления, поднятые платным продвижением.
function isToday(dateStr) {
  if (!dateStr) return true; // не нашли дату — лучше показать, чем упустить
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return true;
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

/**
 * @param {'rent'|'sale'} dealType
 */
export async function fetchUyborListings(dealType = 'rent') {
  const { data } = await getWithRetry(UYBOR_API, {
    params: {
      mode: 'search',
      limit: 30,
      order: 'upAt',
      operationType__eq: dealType,
      category__eq: CATEGORY_APARTMENTS,
      region__eq: REGION_TASHKENT,
      embed: 'media,user,district,region',
    },
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
    },
    timeout: 15000,
  });

  // Структура ответа пока не проверена вживую — поддерживаем
  // несколько вариантов на случай, если объявления лежат не в
  // data.data, а в другом поле.
  const items = data?.data || data?.items || data?.results || (Array.isArray(data) ? data : []);

  console.log(`[uybor-${dealType}] получено ${items.length} объявлений от API`);
  if (items[0]) {
    // Debug-лог первого объявления целиком — если какие-то поля ниже
    // окажутся пустыми/неверными, этот вывод покажет реальную структуру,
    // и поля будет легко поправить.
    console.log(`[uybor-${dealType}] пример сырого объявления:`, JSON.stringify(items[0]).slice(0, 1200));
  }

  const listings = [];
  for (const item of items) {
    const postedRaw = item.upAt || item.createDate || item.updateDate || '';
    if (!isToday(postedRaw)) continue;

    const id = item.id ?? item._id;
    if (!id) continue;

    const title =
      item.title || item.name || [item.category?.name, item.district?.name].filter(Boolean).join(', ') || 'Без названия';

    const priceValue = item.price ?? item.priceEquivalent ?? '';
    const priceCurrency = item.priceCurrency || 'usd';
    const price = priceValue ? `${priceValue} ${priceCurrency === 'usd' ? 'у.е.' : 'сум'}` : '';

    const phone = item.user?.phone || item.phone || item.contactPhone || null;

    listings.push({
      id: `uybor_${id}`,
      source: 'uybor',
      deal_type: dealType,
      // Точный формат URL объявления на uybor.uz не подтверждён —
      // если ссылка окажется нерабочей, поправить тут после проверки.
      url: `https://uybor.uz/listings/${id}`,
      title,
      price,
      posted_raw: postedRaw || 'неизвестно',
      phone_from_api: phone,
    });
  }

  return listings;
}

/**
 * Данные объявления уже приходят из /listings (поиска) почти полностью,
 * так что отдельный запрос за деталями обычно не нужен. Возвращаем
 * пустую строку — classify.js получит raw_text просто из title.
 * Если понадобится полное описание — можно дозапросить
 * GET https://api.uybor.uz/api/v1/listings/{id}, но сначала проверим,
 * хватает ли данных из поиска.
 */
export async function fetchUyborDetails() {
  return '';
}
