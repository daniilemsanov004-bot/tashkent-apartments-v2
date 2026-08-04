import 'dotenv/config';
import { fetchOlxListings, fetchOlxDetails, fetchOlxSellerListingsCount } from './scrapers/olx.js';
import { fetchUyborListings, fetchUyborDetails } from './scrapers/uybor.js';
import { classifyListing, shouldNotify, labelFor, SELLER_LISTINGS_AGENT_THRESHOLD } from './classify.js';
import { notifyNewListing, notifyAlert } from './telegram.js';
import { isKnown, saveListing, markNotified } from './db.js';

const PHONE_REGEX = /(\+?998[\s\-]?\d{2}[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2})/;
const USE_AI_CLASSIFICATION = process.env.USE_AI_CLASSIFICATION === 'true';

async function processSource(fetchList, fetchDetails, sourceName, dealType, fetchSellerCount = null) {
  const sourceLabel = `${sourceName}-${dealType}`;
  console.log(`[${sourceLabel}] проверяю новые объявления...`);

  let items = [];
  try {
    items = await fetchList(dealType);
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
      sellerName = details?.sellerName || null;
      sellerListingsUrl = details?.sellerListingsUrl || null;
    } catch (err) {
      console.warn(`[${sourceLabel}] не удалось получить текст объявления ${item.url}:`, err.message);
    }

    const phoneMatch = rawText.match(PHONE_REGEX);
    const phoneFromText = phoneMatch ? phoneMatch[1] : null;
    const phoneFromApi = item.phone_from_api || null;

    // Жёсткое правило (без ИИ, бесплатно): если у продавца много других
    // объявлений о недвижимости — это агентство, точка. Работает
    // независимо от USE_AI_CLASSIFICATION.
    let sellerListingsCount = null;
    let isConfirmedAgentByProfile = false;
    if (fetchSellerCount && sellerListingsUrl) {
      sellerListingsCount = await fetchSellerCount(sellerListingsUrl);
      if (sellerListingsCount !== null && sellerListingsCount > SELLER_LISTINGS_AGENT_THRESHOLD) {
        isConfirmedAgentByProfile = true;
        console.log(
          `[${sourceLabel}] продавец "${sellerName || '?'}" имеет ${sellerListingsCount} объявлений → агентство, в мусорку: ${item.title}`
        );
      }
    }

    let classification;
    let label;

    if (isConfirmedAgentByProfile) {
      classification = {
        seller_type: 'agent',
        confidence: 'high',
        district: null,
        rooms: null,
        area: null,
        phone: null,
      };
      label = { text: `Агентство (${sellerListingsCount} объявлений)`, kind: 'agent' };
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

    const listing = {
      ...item,
      raw_text: rawText,
      seller_name: sellerName,
      seller_listings_count: sellerListingsCount,
      district: classification.district,
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

    await saveListing(listing);

    const shouldSend = isConfirmedAgentByProfile
      ? false
      : USE_AI_CLASSIFICATION
        ? shouldNotify(classification)
        : true;

    if (shouldSend) {
      try {
        await notifyNewListing(listing);
        await markNotified(listing.id);
        console.log(`[${sourceLabel}] уведомление отправлено (${label.kind}): ${listing.title}`);
      } catch (err) {
        console.error('Ошибка отправки в Telegram:', err.message);
      }
    }

    await new Promise((r) => setTimeout(r, 1200));
  }
}

async function main() {
  // Продажа — в приоритете, проверяем её первой в каждом цикле
  await processSource(fetchOlxListings, fetchOlxDetails, 'olx', 'sale', fetchOlxSellerListingsCount);
  await processSource(fetchUyborListings, fetchUyborDetails, 'uybor', 'sale');
  await processSource(fetchOlxListings, fetchOlxDetails, 'olx', 'rent', fetchOlxSellerListingsCount);
  await processSource(fetchUyborListings, fetchUyborDetails, 'uybor', 'rent');
  console.log('Проверка завершена.');
}

main().catch((err) => {
  console.error('Критическая ошибка:', err);
  process.exit(1);
});
