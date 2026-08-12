// Считает медианную цену за м² по группам (тип недвижимости + тип
// сделки + район) и решает, является ли конкретное объявление "ниже
// рынка". Полностью на статистике, без ИИ и без внешних API — см.
// обсуждение в чате (варианты "только статистика" vs "статистика +
// ИИ", выбран первый + ключевые слова срочности, см. urgencySignals.js).

import {
  getStatsSourceListings,
  upsertMarketStats,
  getAllMarketStats,
} from './db.js';
import { toUsd } from './priceParser.js';

// Общегородская группа-fallback, когда по конкретному району данных
// слишком мало для надёжной медианы (см. MIN_SAMPLE ниже). Обёрнуто в
// подчёркивания и кириллицей специально — не должно случайно
// совпасть с настоящим названием района из districts.js.
export const CITY_WIDE = '__город__';

// Меньше 5 объявлений в группе — медиана слишком шумная, её колебания
// от одного нового объявления к другому дают ложные "ниже рынка".
const MIN_SAMPLE = 5;

// На сколько % цена/м² объявления должна быть ниже медианы группы,
// чтобы считать его "ниже рынка". 15% — заметно больше типичного
// разброса из-за этажа/ремонта/состояния, но не настолько много,
// чтобы отсекать реальные выгодные варианты.
const BELOW_MARKET_THRESHOLD_PCT = 15;

// За сколько последних дней брать объявления в выборку для медианы.
// Достаточно большой охват, чтобы группы по районам набирали
// MIN_SAMPLE, но не настолько большой, чтобы в медиану попадали
// сильно устаревшие цены.
const STATS_LOOKBACK_DAYS = 45;

// Курс для приведения UZS->USD при расчёте статистики (см. toUsd в
// priceParser.js). Тот же .env-курс, что и у остального проекта —
// НЕ живой курс ЦБ, стоит время от времени сверять и обновлять.
const EXCHANGE_RATE_USD_UZS = Number(process.env.EXCHANGE_RATE_USD_UZS) || 12700;

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Валюта больше НЕ часть ключа группировки — см. пояснение от
// 12.08.2026 ниже. Раньше objявления в $ и в сумах на одном и том же
// рынке (например Чиланзар, продажа квартир) попадали в РАЗНЫЕ
// группы (...|Чиланзар|USD и ...|Чиланзар|UZS), из-за чего выборка
// искусственно делилась пополам и MIN_SAMPLE набирался вдвое дольше.
// Теперь всё приводится к USD (см. toUsd ниже) ДО группировки, а
// исходная валюта конкретного объявления в листинге не меняется —
// unify касается только расчёта статистики.
export function groupKey(propertyType, dealType, district) {
  return `${propertyType}|${dealType}|${district}`;
}

/**
 * Пересчитывает market_stats на каждом прогоне (см. комментарий ниже
 * про то, почему не реже). Вызывать один раз в начале прогона (см.
 * run.js main()), ДО обработки объявлений — сами объявления этого же
 * прогона используют уже свежую статистику.
 */
// БЫЛО ограничение "не пересчитывать чаще раза в N часов" — убрано
// 12.08.2026: оказалось багом, а не оптимизацией. Расчёт медианы —
// дешёвая операция (выборка из базы + сортировка чисел в памяти), а
// ограничение по времени давало обратный эффект: если ПЕРВЫЙ прогон
// после деплоя посчитал статистику по почти пустой базе (буквально
// 0-1 группа), эта скудная статистика "замораживалась" как последняя
// свежая на много часов вперёд — все следующие прогоны видели её как
// "ещё свежую" и пропускали пересчёт, ДАЖЕ КОГДА за это время
// накопились уже сотни новых объявлений. Снаружи это выглядело как
// "статистика не растёт всю ночь", хотя сам скрапер работал нормально.
// Пересчитываем теперь на каждом прогоне без всяких условий.
export async function refreshMarketStatsIfStale() {
  console.log('Пересчитываю рыночную статистику цены за м²...');
  const rows = await getStatsSourceListings(STATS_LOOKBACK_DAYS);

  // group_key -> массив price_per_sqm (все уже в USD, см. toUsd ниже)
  const groups = new Map();
  function addTo(key, value) {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }

  for (const r of rows) {
    if (!r.price_per_sqm || !r.property_type || !r.deal_type || !r.price_currency) continue;

    // Приводим к USD ДО группировки — именно это объединяет объявления
    // в $ и в сумах в одну общую выборку (см. пояснение у groupKey).
    const pricePerSqmUsd = toUsd({ value: r.price_per_sqm, currency: r.price_currency }, EXCHANGE_RATE_USD_UZS);
    if (!pricePerSqmUsd) continue;

    // Группа по конкретному району (если он известен)
    if (r.district) {
      addTo(groupKey(r.property_type, r.deal_type, r.district), pricePerSqmUsd);
    }
    // Общегородская группа — считаем всегда, независимо от того, есть
    // ли район, это и есть fallback для районов с малой выборкой.
    addTo(groupKey(r.property_type, r.deal_type, CITY_WIDE), pricePerSqmUsd);
  }

  const stats = [];
  for (const [key, values] of groups) {
    const [propertyType, dealType, district] = key.split('|');
    stats.push({
      group_key: key,
      property_type: propertyType,
      deal_type: dealType,
      district,
      currency: 'USD', // статистика всегда в USD после unify — см. пояснение у groupKey
      median_price_per_sqm: median(values),
      sample_size: values.length,
    });
  }

  if (stats.length > 0) {
    await upsertMarketStats(stats);
  }
  console.log(`Рыночная статистика обновлена: ${stats.length} групп (из ${rows.length} объявлений за ${STATS_LOOKBACK_DAYS} дн).`);
}

/**
 * Загружает всю таблицу market_stats один раз за прогон в Map —
 * дешевле, чем отдельный запрос к базе на каждое объявление.
 * @returns {Promise<Map<string, {median_price_per_sqm:number, sample_size:number}>>}
 */
export async function loadMarketStatsMap() {
  const rows = await getAllMarketStats();
  const map = new Map();
  for (const r of rows) {
    map.set(r.group_key, { median_price_per_sqm: r.median_price_per_sqm, sample_size: r.sample_size });
  }
  return map;
}

/**
 * @param {Map} statsMap результат loadMarketStatsMap()
 * @param {{propertyType:string, dealType:string, district:string|null, currency:string|null, pricePerSqm:number|null}} listingInfo
 * @returns {{belowMarket:boolean, belowMarketPct:number|null, sampleSize:number|null}}
 */
export function evaluateDeal(statsMap, { propertyType, dealType, district, currency, pricePerSqm }) {
  if (!pricePerSqm || !currency) {
    return { belowMarket: false, belowMarketPct: null, sampleSize: null };
  }

  // Статистика в group_key больше не хранится по валюте (см. groupKey
  // выше) — сама медиана в statsMap уже в USD, поэтому конкретное
  // объявление тоже приводим к USD перед сравнением, независимо от
  // того, в чём оно выставлено у продавца.
  const pricePerSqmUsd = toUsd({ value: pricePerSqm, currency }, EXCHANGE_RATE_USD_UZS);
  if (!pricePerSqmUsd) {
    return { belowMarket: false, belowMarketPct: null, sampleSize: null };
  }

  let stat = district ? statsMap.get(groupKey(propertyType, dealType, district)) : null;
  if (!stat || stat.sample_size < MIN_SAMPLE) {
    // Fallback на весь город, если по району данных мало/нет.
    const cityStat = statsMap.get(groupKey(propertyType, dealType, CITY_WIDE));
    if (cityStat && cityStat.sample_size >= MIN_SAMPLE) {
      stat = cityStat;
    }
  }

  if (!stat || stat.sample_size < MIN_SAMPLE || !stat.median_price_per_sqm) {
    return { belowMarket: false, belowMarketPct: null, sampleSize: stat?.sample_size ?? null };
  }

  const pct = Math.round((1 - pricePerSqmUsd / stat.median_price_per_sqm) * 1000) / 10; // 1 знак после запятой
  return {
    belowMarket: pct >= BELOW_MARKET_THRESHOLD_PCT,
    belowMarketPct: pct,
    sampleSize: stat.sample_size,
  };
}
