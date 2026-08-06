import * as cheerio from 'cheerio';
import { getWithRetry } from '../http.js';
import { normalizeDistrict } from '../districts.js';

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
const PRICE_RE = /[\d\s]{3,}\s*(?:сум|у\.?\s?е\.?)/i;

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
        if (priceMatch) price = priceMatch[0].trim();
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
export async function fetchOlxDetails(url) {
  const { data: html } = await getWithRetry(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 15000,
  });
  const $ = cheerio.load(html);
  const description = $('[data-cy="ad_description"]').text().trim();
  const bodyText = $('body').text().replace(/\s+/g, ' ');

  // Блок "МЕСТОПОЛОЖЕНИЕ" на странице объявления рендерится из
  // встроенного JSON с данными страницы. Вы прислали реальный кусок
  // этого JSON прямо со страницы:
  //   "location":{"cityName":"Ташкент","regionName":"Ташкентская область",
  //   "districtName":"Сергелийский район","districtId":19,...}
  // Это НАМНОГО надёжнее, чем искать текст "МЕСТОПОЛОЖЕНИЕ" на странице:
  // название района тут — обычное значение JSON-поля, а не завязано на
  // конкретную вёрстку/CSS-класс блока, которые могут меняться. Тянем
  // его прямо регуляркой из HTML — неважно, в каком именно <script>
  // сериализован этот JSON (Next.js __NEXT_DATA__, Apollo state и т.п.),
  // значение всё равно попадает в текст страницы как обычная строка.
  const districtNameMatch = html.match(/"districtName"\s*:\s*"([^"]+)"/);
  const rawDistrictName = districtNameMatch ? districtNameMatch[1].trim() : null;
  let locationDistrict = normalizeDistrict(rawDistrictName);

  // Запасной путь — на случай, если в этот раз JSON-поле не нашлось
  // (например, OLX поменял формат сериализации): ищем блок
  // "МЕСТОПОЛОЖЕНИЕ" по обычному тексту страницы, как раньше.
  if (!locationDistrict) {
    const locationMatch = bodyText.match(/Ташкент\s*,\s*([А-ЯЁ][а-яё-]+\s+район)/i);
    locationDistrict = locationMatch ? normalizeDistrict(locationMatch[1].trim()) : null;
  }

  // Тип аккаунта продавца — оказывается, OLX сам прямым текстом
  // подписывает это на странице объявления, прямо перед списком
  // параметров ("Тип жилья:", "Тип строения:" и т.п.): "Частное лицо"
  // у обычных пользователей и "Бизнес" у зарегистрированных бизнес-
  // аккаунтов. Подтверждено вживую (07.08.2026) на двух реальных
  // объявлениях OLX: у частника — "Частное лицо", у агентства
  // "Alpha Realty" (у которой оказалось 471 объявление недвижимости) —
  // "Бизнес". Это НАМНОГО надёжнее подсчёта чужих объявлений через
  // fetchOlxSellerListingsCount ниже — там из-за неполного списка
  // ключевых слов в REAL_ESTATE_SLUG_RE регулярно недосчитывались
  // объявления вида "2-комнатная ...", "3 xonali ..." (без слова
  // "квартира" в самой ссылке) — именно из-за этого агентства с
  // сотнями объявлений проходили тест "> N объявлений" с заниженным
  // счётом. Здесь же сайт САМ прямо говорит "Бизнес" — считать
  // вообще ничего не нужно.
  //
  // У бизнес-аккаунтов ещё и "Все объявления автора" обычно ведёт не
  // на обычный /list/user/..., а на отдельный фирменный поддомен вида
  // https://<имя-магазина>.olx.uz/home/ — OLX даёт бизнес-аккаунтам
  // отдельные страницы-витрины. Так что подсчёт по sellerListingsUrl
  // для таких аккаунтов не только неточен из-за REAL_ESTATE_SLUG_RE,
  // но и вообще не нужен — isBusinessAccount ниже решает вопрос сразу.
  //
  // Требуем, чтобы сразу за "Бизнес"/"Частное лицо" шло начало
  // первого параметра (слово с заглавной буквы + двоеточие) — иначе
  // возможно ложное совпадение с пунктом меню "Бизнес и услуги" в
  // подвале страницы (там после него не двоеточие, а следующий пункт
  // меню, так что этот шаблон туда не попадёт).
  const accountTypeMatch = bodyText.match(/(Бизнес|Частное лицо)\s+[А-ЯЁ][а-яёА-ЯЁ\s]{2,40}:/);
  const isBusinessAccount = accountTypeMatch ? accountTypeMatch[1] === 'Бизнес' : false;

  // Ссылка на профиль продавца — ищем по тексту самой кнопки, а не по
  // CSS-классу (он может меняться, а текст кнопки — вряд ли).
  let sellerListingsUrl = null;
  $('a').each((_, el) => {
    const text = $(el).text().trim().toLowerCase();
    if (text.includes('все объявления автора') || text.includes('все объявления продавца')) {
      const href = $(el).attr('href');
      if (href) {
        sellerListingsUrl = href.startsWith('http') ? href : `https://www.olx.uz${href}`;
      }
    }
  });

  // Имя продавца — точный селектор не подтверждён вживую, пробуем
  // несколько распространённых вариантов разметки OLX.
  let sellerName =
    $('[data-cy="seller_name"]').text().trim() ||
    $('[data-testid="seller-name"]').text().trim() ||
    '';
  if (!sellerName) {
    // запасной вариант: заголовок рядом с найденной ссылкой на профиль
    const link = $('a').filter((_, el) => $(el).text().trim().toLowerCase().includes('все объявления автора')).first();
    sellerName = link.closest('div').find('h4, h3, [class*="name"]').first().text().trim();
  }

  // Телефон — самое важное поле для агентства, но самое ненадёжное на
  // OLX: он почти всегда скрыт за кнопкой "показать номер" и не лежит
  // в исходном HTML открытым текстом (в отличие от района). Пробуем
  // несколько путей по возрастанию сложности:
  //  1) вдруг номер всё-таки есть прямо в HTML (некоторые продавцы
  //     дублируют его в описании — это уже покрыто PHONE_REGEX в
  //     run.js, тут не дублируем);
  //  2) ищем номер прямо в служебном JSON страницы — как ни странно,
  //     иногда встречается под ключами вида "phone"/"phoneNumber",
  //     даже если кнопка "показать номер" тоже есть на странице;
  //  3) если не нашли — пробуем вызвать fetchOlxPhone() через
  //     numeric ID объявления (не наш "ID4pYww" из ссылки — настоящий
  //     числовой id, который OLX хранит в этом же JSON рядом с
  //     заголовком/описанием).
  // ⚠️ Пункты 2 и 3 НЕ проверены на реальном прогоне (нет доступа в
  // интернет там, где это писалось) — если после первого прогона на
  // GitHub Actions телефоны по-прежнему не находятся, посмотрите в
  // логах строку "[olx-details] телефон не найден..." — она печатает
  // кусок сырого JSON страницы, по нему можно будет поправить регулярку.
  let phone = null;
  const jsonPhoneMatch = html.match(/"phone(?:Number)?"\s*:\s*"(\+?\d[\d\s\-()]{6,17}\d)"/i);
  if (jsonPhoneMatch) {
    phone = jsonPhoneMatch[1];
  } else {
    const adIdMatch = html.match(/"id"\s*:\s*(\d{6,12})\s*,\s*"(?:title|url|slug)"/);
    const adId = adIdMatch ? adIdMatch[1] : null;
    if (adId) {
      phone = await fetchOlxPhone(adId);
    }
    if (!phone) {
      console.log(`[olx-details] телефон не найден для ${url} (adId=${adId || 'не определён'}); фрагмент JSON: ${html.slice(0, 300).replace(/\s+/g, ' ')}`);
    }
  }

  return { description, sellerName: sellerName || null, sellerListingsUrl, locationDistrict, phone, isBusinessAccount };
}

/**
 * Слова, по которым слаг ссылки объявления похож на недвижимость.
 * OLX кладёт в URL человекочитаемый транслит заголовка — например
 * .../prodaetsya-3-komnatnaya-kvartira-na-6-etazhe-ID4pYww.html — поэтому
 * можно довольно надёжно отличить "квартира/дом/участок/офис" от
 * "iphone", "toyota" и т.д. прямо по самой ссылке, не открывая её.
 *
 * ВАЖНО (07.08.2026): изначальный список ловил только явные слова
 * типа "kvartira"/"dom" — но вживую выяснилось, что огромная доля
 * реальных объявлений называется по формату "2-komnatnaya ...",
 * "3 xonali ...", "novostroyka ..." БЕЗ слова "квартира" в самой
 * ссылке. Проверено на реальном профиле агентства с 471 объявлением
 * недвижимости — старым списком ключевых слов ловилась лишь малая
 * часть из них, из-за чего fetchOlxSellerListingsCount сильно
 * занижал счётчик и агентства с сотнями объявлений проходили порог
 * SELLER_LISTINGS_AGENT_THRESHOLD как обычные частники. Добавлены
 * количество комнат ("N-komnatn..."), узбекское "xona/xonali"
 * (комната) и "novostroyka"/"studiya".
 */
const REAL_ESTATE_SLUG_RE =
  /kvartir|kottedj|dom[ao]?[^a-z]|nedvizh|kommerch|ofis|sklad|magazin|pomeshen|uchastok|taunhaus|zemel|\d+-?komnatn|xonali|xona[^a-z]|novostroyk|studiy/i;

/**
 * Считает, сколько объявлений НЕДВИЖИМОСТИ у продавца на его странице
 * "Все объявления автора". Если их заметно больше одного-двух — это
 * почти наверняка агентство/риелтор, даже если сам текст объявления
 * звучит по-человечески.
 *
 * ВАЖНО: страница "Все объявления автора" показывает объявления ВО ВСЕХ
 * категориях OLX (машины, телефоны, мебель — что угодно), а не только
 * недвижимость. Раньше здесь считались вообще все ссылки на объявления
 * подряд — из-за этого обычный человек, продающий заодно старый телефон
 * или диван, уже набирал 3+ "объявления" и ошибочно помечался как
 * агентство. Это и было причиной, почему ~84% объявлений улетали в
 * "агент" (диагностика от 06.08.2026). Теперь считаем только ссылки,
 * похожие на недвижимость (см. REAL_ESTATE_SLUG_RE).
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
      if (!REAL_ESTATE_SLUG_RE.test(href)) return; // не про недвижимость — не считаем
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
 * Номер телефона на OLX обычно скрыт за кнопкой "показать номер" и
 * подгружается отдельным XHR-запросом к их внутреннему API (не через
 * обычный HTML). Теперь вызывается из fetchOlxDetails() (см. выше),
 * когда номер не нашёлся напрямую в JSON страницы.
 *
 * ⚠️ Эндпоинт и формат ответа НЕ подтверждены на реальном прогоне —
 * если после первого запуска на GitHub Actions в логах будет видно
 * "не удалось получить телефон" со статусом 404 — значит либо
 * offerId определяется неверно (см. adIdMatch в fetchOlxDetails),
 * либо сам путь запроса изменился. В этом случае:
 *   1. Откройте любое объявление OLX в браузере.
 *   2. DevTools → вкладка Network → нажмите "показать номер".
 *   3. Найдите реальный запрос и путь → пришлите его, поправим тут.
 * Одна попытка (без ретраев) — чтобы не спамить недоподтверждённый
 * эндпоинт, если он окажется неверным.
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
      1
    );
    const phone = data?.data?.phones?.[0] || null;
    if (!phone) {
      console.log(`[olx-phone] ответ API для offerId=${offerId} не содержит телефона: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return phone;
  } catch (err) {
    console.warn(`[olx-phone] не удалось получить телефон для offerId=${offerId}: ${err.response?.status || ''} ${err.message}`);
    return null;
  }
}