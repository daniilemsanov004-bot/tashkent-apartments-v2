import 'dotenv/config';
import { fetchOlxListings, fetchOlxDetails } from './scrapers/olx.js';
import { fetchUyborListings, fetchUyborDetails } from './scrapers/uybor.js';
import { classifyListing, shouldNotify, labelFor } from './classify.js';
import { notifyNewListing, notifyAlert } from './telegram.js';
import { isKnown, saveListing, markNotified } from './db.js';

const PHONE_REGEX = /(\+?998[\s\-]?\d{2}[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2})/;
const USE_AI_CLASSIFICATION = process.env.USE_AI_CLASSIFICATION === 'true';

async function processSource(fetchList, fetchDetails, sourceName, dealType) {
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
    try {
      const details = await fetchDetails(item.url);
      if (details) rawText = `${item.title}\n${details}`;
    } catch (err) {
      console.warn(`[${sourceLabel}] не удалось получить текст объявления ${item.url}:`, err.message);
    }

    const phoneMatch = rawText.match(PHONE_REGEX);
    const phoneFromText = phoneMatch ? phoneMatch[1] : null;
    const phoneFromApi = item.phone_from_api || null;

    let classification;
    if (!USE_AI_CLASSIFICATION) {
      classification = {
        seller_type: 'unknown',
        confidence: 'n/a',
        district: null,
        rooms: null,
        area: null,
        phone: null,
      };
    } else {
      try {
        classification = await classifyListing(rawText);
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
    }

    const label = USE_AI_CLASSIFICATION
      ? labelFor(classification)
      : { text: 'Без проверки ИИ', kind: 'unchecked' };

    const listing = {
      ...item,
      raw_text: rawText,
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

    const shouldSend = USE_AI_CLASSIFICATION ? shouldNotify(classification) : true;

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
  await processSource(fetchOlxListings, fetchOlxDetails, 'olx', 'rent');
  await processSource(fetchOlxListings, fetchOlxDetails, 'olx', 'sale');
  await processSource(fetchUyborListings, fetchUyborDetails, 'uybor', 'rent');
  await processSource(fetchUyborListings, fetchUyborDetails, 'uybor', 'sale');
  console.log('Проверка завершена.');
}

main().catch((err) => {
  console.error('Критическая ошибка:', err);
  process.exit(1);
});
