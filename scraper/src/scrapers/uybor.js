import { getWithRetry } from '../http.js';

// Найдено через DevTools → Network → Fetch/XHR на uybor.uz.
// operationType__eq принимает 'rent' | 'sale' напрямую — совпадает
// с нашими значениями dealType, поэтому передаём как есть.
const UYBOR_API = 'https://api.uybor.uz/api/v1/listings';

const REGION_TASHKENT = 13;
const CATEGORY_APARTMENTS = 7;

// TODO: узнать category__eq для "Дома" и "Коммерция" на uybor.uz —
// открыть сайт → DevTools → Network → XHR, выбрать эти категории в
// фильтре и посмотреть параметр category__eq в запросе к
// api.uybor.uz/api/v1/listings. Как только известны — добавить сюда
// по аналогии с CATEGORY_APARTMENTS и завести fetchUyborListings(dealType,
// propertyType) так же, как уже сделано в scrapers/olx.js.

/**
 * Uybor отдаёt некоторые текстовые поля (в т.ч. похоже, title) не
 * простой строкой, а объектом с переводами вида {ru: "...", uz: "...",
 * "uz-latn": "..."}. Эта функция достаёт из такого объекта читаемую
 * строку; если значение уже строка — просто возвращает её как есть.
 */
function localized(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return (
      value.ru || value.uz || value['uz-latn'] || value.en ||
      Object.values(value).find((v) => typeof v === 'string' && v.trim()) ||
      ''
    );
  }
  return String(value);
}

// Слова, которыми Uybor подписывает НЕ-частных продавцов прямо на
// странице объявления (см. скриншот: под именем продавца написано
// "Риелтор"). Замечено, что поле item.user?.organization в API часто
// пустое даже для таких продавцов — сайт хранит это отдельным полем
// "роль"/"тип аккаунта", точное имя которого в JSON не подтверждено,
// поэтому проверяем сразу несколько вероятных вариантов + текстовое
// совпадение по любому строковому полю пользователя.
const AGENT_ROLE_WORDS = ['риелтор', 'риэлтор', 'агент', 'agent', 'realtor', 'dealer', 'compan', 'agency', 'brok'];

function textLooksLikeAgent(value) {
  const s = localized(value).toLowerCase();
  return s ? AGENT_ROLE_WORDS.some((w) => s.includes(w)) : false;
}

/**
 * Определяет, что продавец — НЕ частник (риелтор/агентство), а не
 * только по item.user?.organization (которое, судя по скриншоту,
 * не всегда заполнено). Проверяет несколько вероятных полей "роли"
 * плюс текстовое совпадение по всем строковым полям user-объекта.
 */
function detectAgentRole(item) {
  const user = item.user || {};

  if (user.organization) {
    return { isAgent: true, roleText: localized(user.organization.name) || localized(user.organization.title) || 'organization' };
  }

  // Вероятные названия поля "роль"/"тип аккаунта" — точное имя не
  // подтверждено без реального ответа API, поэтому пробуем все.
  const roleCandidates = [
    user.role,
    user.roleName,
    user.userRole,
    user.userType,
    user.accountType,
    user.type,
    user.category,
    user.position,
    user.title,
    user.badge,
    user.label,
    item.userRole,
    item.role,
  ];
  for (const candidate of roleCandidates) {
    if (candidate && textLooksLikeAgent(candidate)) {
      return { isAgent: true, roleText: localized(candidate) };
    }
  }

  // Последний рубеж: пробегаем по всем строковым значениям объекта
  // user целиком — если Uybor называет поле как-то ещё, слово
  // "риелтор"/"агент" всё равно должно где-то встретиться.
  for (const value of Object.values(user)) {
    if (typeof value === 'string' && textLooksLikeAgent(value)) {
      return { isAgent: true, roleText: value };
    }
  }

  return { isAgent: false, roleText: null };
}

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
    // Отдельно логируем именно user — это где живёт роль
    // ("Риелтор"/"Агент"), которую мы сейчас пытаемся поймать.
    console.log(`[uybor-${dealType}] user первого объявления:`, JSON.stringify(items[0].user || null));
  }

  const listings = [];
  for (const item of items) {
    const postedRaw = item.upAt || item.createDate || item.updateDate || '';
    if (!isToday(postedRaw)) continue;

    const id = item.id ?? item._id;
    if (!id) continue;

    const title =
      localized(item.title) ||
      localized(item.name) ||
      [localized(item.category?.name), localized(item.district?.name)].filter(Boolean).join(', ') ||
      'Без названия';

    const priceValue = item.price ?? item.priceEquivalent ?? '';
    const priceCurrency = item.priceCurrency || 'usd';
    const price = priceValue ? `${priceValue} ${priceCurrency === 'usd' ? 'у.е.' : 'сум'}` : '';

    const phone = item.user?.phone || item.phone || item.contactPhone || null;

    // Uybor различает частных продавцов и риелторов/агентства — но,
    // как показал реальный прогон (см. скриншот с "Риелтор" под именем
    // продавца), одного item.user?.organization для этого недостаточно.
    // detectAgentRole() проверяет organization + несколько вероятных
    // полей "роли" + текстовое совпадение по всем строковым полям user.
    const { isAgent: sellerIsOrganization, roleText: sellerRoleText } = detectAgentRole(item);
    const orgName = localized(item.user?.organization?.name) || localized(item.user?.organization?.title) || null;
    const sellerName = orgName || item.user?.name || item.user?.fullName || null;
    if (sellerIsOrganization) {
      console.log(`[uybor-${dealType}] продавец "${sellerName || '?'}" помечен как риелтор/агентство (${sellerRoleText})`);
    }

    // Uybor отдаёт район структурно (через ?embed=district) — самый
    // надёжный источник района из всех сайтов, используем напрямую,
    // без необходимости в ИИ-классификации или поиске по тексту.
    // См. normalizeDistrict() в run.js, который приводит это к
    // каноничному названию.
    const rawDistrict = localized(item.district?.name) || null;

    listings.push({
      id: `uybor_${id}`,
      source: 'uybor',
      deal_type: dealType,
      property_type: 'apartment', // пока только квартиры, см. TODO выше
      // Точный формат URL объявления на uybor.uz не подтверждён —
      // если ссылка окажется нерабочей, поправить тут после проверки.
      url: `https://uybor.uz/listings/${id}`,
      title,
      price,
      posted_raw: postedRaw || 'неизвестно',
      phone_from_api: phone,
      seller_is_organization: sellerIsOrganization,
      seller_name: sellerName,
      raw_district: rawDistrict,
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
  return { description: '', sellerName: null, sellerListingsUrl: null };
}
