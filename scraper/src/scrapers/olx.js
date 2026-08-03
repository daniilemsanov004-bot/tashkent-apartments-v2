import * as cheerio from 'cheerio';
import { getWithRetry } from '../http.js';

// Два раздела — аренда и продажа квартир по Ташкенту. Забираем ВСЕ
// объявления в каждом, не только помеченные сайтом "от собственника"
// (часть реальных собственников просто не ставят эту галочку).
// Фильтрацию собственник/агент делает классификация в classify.js.
export const OLX_URLS = {
  rent: 'https://www.olx.uz/nedvizhimost/kvartiry/arenda-dolgosrochnaya/tashkent/',
  sale: 'https://www.olx.uz/nedvizhimost/kvartiry/prodazha/tashkent/',
};

const LISTING_LINK_RE = /\/d\/obyavlenie\/[^"'\s]*-ID([a-zA-Z0-9]+)\.html/;
const PRICE_RE = /[\d\s]{3,}\s*(?:сум|у\.?\s?е\.?)/i;

// OLX подписывает карточки датой публикации: "Сегодня в 14:23", "Вчера в 09:10"
// или конкретной датой ("30 июля"). Нас интересуют ТОЛЬКО сегодняшние —
// иначе в базу лезут старые объявления, поднятые в топ платным продвижением.
const TODAY_RE = /сегодня/i;
const DATE_META_RE = /(сегодня|вчера)\s*(?:в\s*\d{1,2}:\d{2})?|(\d{1,2}\s?(?:янв|фев|мар|апр|ма[йя]|июн|июл|авг|сен|окт|ноя|дек)[а-я]*)/i;

/**
 * @param {'rent'|'sale'} dealType
 */
export async function fetchOlxListings(dealType = 'rent') {
  const url = OLX_URLS[dealType];
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
    // пробуем alt у картинки внутри неё.
    let title = link.text().trim();
    if (!title) {
      title = link.find('img').attr('alt')?.trim() || '';
    }
    if (!title) return; // без заголовка карточка бесполезна — пропускаем

    // Цену и дату публикации ищем в ближайшем родительском блоке-карточке —
    // поднимаемся на несколько уровней вверх и ищем текст, похожий на них.
    let price = '';
    let dateRaw = '';
    let container = link.parent();
    for (let i = 0; i < 5 && container.length; i++) {
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
 * Заходит на страницу конкретного объявления и вытаскивает полный текст
 * описания — он нужен для классификации "собственник/агент".
 */
export async function fetchOlxDetails(url) {
  const { data: html } = await getWithRetry(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 15000,
  });
  const $ = cheerio.load(html);
  const description = $('[data-cy="ad_description"]').text().trim();
  return description;
}

/**
 * Номер телефона на OLX обычно скрыт за кнопкой "показать номер" и
 * подгружается отдельным XHR-запросом к их внутреннему API (не через
 * обычный HTML). Чтобы найти актуальный URL этого запроса:
 *   1. Откройте объявление в браузере.
 *   2. DevTools → вкладка Network → нажмите "показать номер".
 *   3. Найдите запрос (обычно к чему-то вроде /api/v1/offers/{id}/phones)
 *      и скопируйте его точный путь и параметры сюда.
 * Ниже — заглушка, которую нужно донастроить под реальный эндпоинт.
 * Пока не вызывается нигде в коде — номер, если есть, ищется прямо
 * в тексте описания (см. PHONE_REGEX в server.js/index.js).
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
      1 // одна попытка — это заглушка, не хотим спамить недоделанным эндпоинтом
    );
    return data?.data?.phones?.[0] || null;
  } catch (err) {
    return null;
  }
}
