import * as cheerio from 'cheerio';
import { getWithRetry } from '../http.js';

// У Realting.uz, в отличие от OLX и Uybor, ЕСТЬ готовый встроенный
// фильтр "от собственника" — отдельные SEO-страницы /fsbo (For Sale
// By Owner), уже отфильтрованные сайтом. Подтверждено вживую
// (05.08.2026): /tashkent/apartments/fsbo — 392 квартиры от
// собственников в Ташкенте, есть пагинация ?page=N, карточки уже
// содержат явную метку "Частный продавец" / "Агентство" — то есть
// классификация продавца делается САМИМ сайтом и не требует
// эвристик (в отличие от OLX, где приходится считать объявления
// продавца, см. classify.js).
//
// Для аренды отдельных /fsbo-страниц НЕ существует (только продажа
// размечена так на сайте) — для rent используем обычные страницы
// /tashkent/property-to-rent/{type}. Метка "Частный продавец"/
// "Агентство" на этих страницах ЕСТЬ, но видна ТОЛЬКО на странице
// самого объявления (не в карточке списка) — подтверждено вживую
// 11.08.2026, решение принимается в fetchRealtingDetails/run.js.
//
// Все 6 URL (apartment/house/commercial × sale/rent) подтверждены
// вживую 11.08.2026 скриншотами пользователя — реальные страницы с
// объявлениями.
export const REALTING_CATEGORIES = {
  apartment: {
    sale: 'https://realting.uz/tashkent/apartments/fsbo',
    rent: 'https://realting.uz/tashkent/property-to-rent/apartments',
  },
  house: {
    sale: 'https://realting.uz/tashkent/houses/fsbo', // не проверено вживую
    rent: 'https://realting.uz/tashkent/property-to-rent/houses', // не проверено вживую
  },
  commercial: {
    sale: 'https://realting.uz/tashkent/commercial/fsbo', // не проверено вживую
    rent: 'https://realting.uz/tashkent/property-to-rent/commercials', // не проверено вживую
  },
};

// Ссылки на объявления имеют вид /property/3835137 (продажа) или
// /property-to-rent/3870895 (аренда), /commercial/3861623 и т.п. —
// числовой ID в конце пути, без расширения .html (в отличие от OLX).
// НАЙДЕН БАГ (11.08.2026): CSS-селектор ниже раньше ловил только
// a[href^="/property/"] — а это НЕ матчит "/property-to-rent/..."
// (после "property" сразу дефис, а не слэш), так что для ВСЕЙ аренды
// (все property_type) linksOnPage.length был 0 и код молча уходил в
// `break` на первой же странице, ничего не находя. Подтверждено
// вживую скриншотом реальной страницы объявления аренды — href именно
// "/property-to-rent/{id}". Селектор ниже теперь ловит все 4 префикса.
const LISTING_LINK_RE = /^\/(property-to-rent|property|commercial|short-term-rental)\/(\d+)(?:[/?].*)?$/;
const LISTING_LINK_SELECTOR =
  'a[href^="/property-to-rent/"], a[href^="/property/"], a[href^="/commercial/"], a[href^="/short-term-rental/"]';
const PRICE_RE = /\$[\d\s.,]+(?:\s?млн)?|[\d\s.,]{3,}\s*(?:UZS|сум|у\.?\s?е\.?)/i;
const MAX_PAGES = 5; // ограничиваем глубину пагинации за один прогон крона

function extractListingId(href) {
  if (!href) return null;
  const m = href.match(LISTING_LINK_RE);
  return m ? m[2] : null;
}

/**
 * @param {'rent'|'sale'} dealType
 * @param {'apartment'|'house'|'commercial'} propertyType
 */
export async function fetchRealtingListings(dealType = 'sale', propertyType = 'apartment') {
  const baseUrl = REALTING_CATEGORIES[propertyType]?.[dealType];
  if (!baseUrl) return [];

  const isFsboPage = dealType === 'sale'; // только продажа размечена сайтом как fsbo
  const seen = new Map();
  let skippedAgents = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1 ? baseUrl : `${baseUrl}?page=${page}`;
    let html;
    try {
      const res = await getWithRetry(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept-Language': 'ru-RU,ru;q=0.9',
        },
        timeout: 15000,
      });
      html = res.data;
    } catch (err) {
      if (page === 1) throw err; // первая страница обязана открыться
      console.warn(`[realting] страница ${page} не открылась (${url}), останавливаюсь:`, err.message);
      break;
    }

    const $ = cheerio.load(html);
    const linksOnPage = $(LISTING_LINK_SELECTOR);
    if (page === 1) {
      console.log(
        `[realting-${propertyType}-${dealType}] диагностика: html=${html.length} байт, найдено ссылок-кандидатов=${linksOnPage.length}, title="${$('title').text().trim().slice(0, 80)}"`
      );
    }
    if (linksOnPage.length === 0) break; // страниц больше нет

    let foundNewOnThisPage = false;

    linksOnPage.each((_, el) => {
      const link = $(el);
      const href = link.attr('href') || '';
      const externalId = extractListingId(href);
      if (!externalId) return;
      if (seen.has(externalId)) return;

      const fullUrl = `https://realting.uz${href.split('?')[0]}`;

      const linkClone = link.clone();
      linkClone.find('style, script').remove();
      let title = linkClone.text().trim();
      if (!title) title = link.find('img').attr('alt')?.trim() || '';
      if (!title) return;

      // Как и в olx.js — поднимаемся по родителям, но останавливаемся,
      // как только в контейнере оказывается больше одного уникального
      // ID объявления (значит, вышли за пределы карточки).
      let price = '';
      let sellerTypeText = '';
      let container = link.parent();
      for (let i = 0; i < 8 && container.length; i++) {
        const idsInside = new Set();
        container.find(LISTING_LINK_SELECTOR).each((_, a) => {
          const id = extractListingId($(a).attr('href') || '');
          if (id) idsInside.add(id);
        });
        if (idsInside.size > 1) break;

        const text = container.text();
        if (!price) {
          const priceMatch = text.match(PRICE_RE);
          if (priceMatch) price = priceMatch[0].trim();
        }
        if (!sellerTypeText && /Частный продавец|Агентство/.test(text)) {
          sellerTypeText = /Частный продавец/.test(text) ? 'owner' : 'agent';
        }
        if (price && sellerTypeText) break;
        container = container.parent();
      }

      // Дешёвая попытка поймать метку прямо в карточке списка — если
      // нашли "Агентство", можно отбросить сразу без похода на
      // страницу объявления. НО (подтверждено вживую 11.08.2026): на
      // страницах аренды (/property-to-rent/...) метка вообще не
      // отображается в карточке списка — видна только на странице
      // самого объявления. Поэтому здесь НЕЛЬЗЯ требовать найденную
      // метку для приёма объявления в rent — иначе вся аренда молча
      // отбрасывается на этом этапе (это и был реальный баг ДО
      // сегодняшнего фикса селектора, из-за которого сюда вообще не
      // доходило ни одной ссылки).
      if (!isFsboPage && sellerTypeText === 'agent') {
        skippedAgents++;
        return;
      }

      foundNewOnThisPage = true;
      seen.set(externalId, {
        id: `realting_${externalId}`,
        source: 'realting',
        deal_type: dealType,
        property_type: propertyType,
        url: fullUrl,
        title,
        price,
        posted_raw: 'неизвестно', // на страницах листинга Realting дата публикации не показана
        // На fsbo-страницах (продажа) сайт САМ гарантирует "от
        // собственника". На rent это ЕЩЁ НЕ подтверждено (метка в
        // карточке списка обычно не видна) — окончательное решение
        // принимается в run.js по данным со страницы объявления
        // (fetchRealtingDetails → sellerType).
        realting_owner_confirmed: isFsboPage || sellerTypeText === 'owner',
        seller_is_organization: false,
      });
    });

    if (!foundNewOnThisPage && page > 1) break; // дошли до дублей/конца — пагинация закончилась
  }

  if (skippedAgents > 0) {
    console.log(`[realting-${dealType}-${propertyType}] пропущено ${skippedAgents} объявлений от агентств`);
  }

  return Array.from(seen.values());
}

/**
 * Заходит на страницу объявления и вытаскивает описание + имя
 * продавца — для дозаписи полного текста (используется классификацией
 * и для поиска телефона в тексте, если он не скрыт).
 * Селекторы описания на детальной странице Realting вживую НЕ
 * подтверждены — ищем по нескольким распространённым вариантам и
 * запасному варианту (самый длинный текстовый блок на странице).
 */
export async function fetchRealtingDetails(url) {
  const { data: html } = await getWithRetry(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 15000,
  });
  const $ = cheerio.load(html);

  let description =
    $('[class*="description"]').first().text().trim() ||
    $('[itemprop="description"]').first().text().trim();

  if (!description) {
    // запасной вариант: самый длинный текстовый блок на странице
    let longest = '';
    $('div, p').each((_, el) => {
      const t = $(el).clone().children().remove().end().text().trim();
      if (t.length > longest.length && t.length < 3000) longest = t;
    });
    description = longest;
  }

  const sellerName =
    $('[class*="seller"] [class*="name"]').first().text().trim() ||
    $('[class*="agent-name"]').first().text().trim() ||
    $('.company-info-desc .company-title').first().text().trim() ||
    null;

  // Метка "Частный продавец"/"Агентство" на странице объявления —
  // подтверждено вживую 11.08.2026 (реальный HTML страницы): лежит в
  // блоке продавца, например <div class="color-dark">Частный
  // продавец</div><div class="company-title">Имя</div>. На страницах
  // аренды это ЕДИНСТВЕННОЕ место, где эта метка вообще видна (в
  // карточке списка её нет) — используется как основной сигнал в
  // run.js для isConfirmedOwner/isConfirmedAgent.
  const pageText = $('body').text();
  let sellerType = null;
  if (/Частный продавец/.test(pageText)) sellerType = 'owner';
  else if (/Агентство/.test(pageText)) sellerType = 'agent';

  // Район — структурный блок "Местонахождение" (подтверждено вживую
  // 11.08.2026, реальный HTML): список <li><div class="lh-small">
  // <div class="fs-small color-dark">Район</div><div>ЗНАЧЕНИЕ</div>
  // </div></li> внутри #blockAddress.
  let locationDistrict = null;
  $('#blockAddress li .lh-small').each((_, el) => {
    const label = $(el).children().eq(0).text().trim();
    if (label === 'Район') {
      locationDistrict = $(el).children().eq(1).text().trim() || null;
    }
  });

  const imageUrl = $('meta[property="og:image"]').attr('content') || null;

  return {
    description,
    sellerName: sellerName || null,
    sellerListingsUrl: null,
    imageUrl,
    sellerType,
    locationDistrict,
  };
}
