import 'dotenv/config';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { notifyToTopicGroup } from './telegram.js';

// Разовый скрипт: старые объявления уже лежат в Supabase (их когда-то
// отправили только в общий чат без тем), тут они рассылаются ЗАНОВО —
// уже правильно, по темам районов в тематические супергруппы. Это не
// "перенос" старых сообщений (Bot API так не умеет), а создание новых
// сообщений на основе данных из базы.
//
// Запуск:
//   cd scraper
//   node src/resend-backlog.js                  — за вчерашний день (по умолчанию)
//   node src/resend-backlog.js 2026-08-05        — за конкретную дату
//   node src/resend-backlog.js 2026-08-05 2026-08-06   — диапазон [от, до)
//
// Скрипт МОЖНО прерывать (Ctrl+C) и запускать заново — уже отправленные
// объявления не отправятся повторно (прогресс пишется в
// resend-backlog.progress.json рядом со скриптом).
//
// Скорость: Telegram не даёт слать чаще ~1 сообщения в секунду в один
// чат — тут стоит пауза 1.2с между КАЖДЫМ сообщением (как и в обычном
// scraper/src/run.js), т.е. на 5000 объявлений уйдёт ~1.5-2 часа. Это
// нормально, просто оставьте скрипт работать в фоне.

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  realtime: { transport: WebSocket },
});

const PROGRESS_FILE = new URL('./resend-backlog.progress.json', import.meta.url);

function loadProgress() {
  try {
    const raw = fs.readFileSync(PROGRESS_FILE, 'utf-8');
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

function saveProgress(doneIds) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify([...doneIds]));
}

// По умолчанию — вчерашний календарный день по Ташкенту (UTC+5).
function defaultRange() {
  const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
  const nowTashkent = new Date(Date.now() + TASHKENT_OFFSET_MS);
  const todayTashkent = new Date(
    Date.UTC(nowTashkent.getUTCFullYear(), nowTashkent.getUTCMonth(), nowTashkent.getUTCDate())
  );
  const from = new Date(todayTashkent.getTime() - 24 * 60 * 60 * 1000 - TASHKENT_OFFSET_MS);
  const to = new Date(todayTashkent.getTime() - TASHKENT_OFFSET_MS);
  return { from: from.toISOString(), to: to.toISOString() };
}

function parseArgs() {
  const [fromArg, toArg] = process.argv.slice(2);
  if (!fromArg) return defaultRange();
  const from = new Date(`${fromArg}T00:00:00+05:00`).toISOString();
  const to = toArg
    ? new Date(`${toArg}T00:00:00+05:00`).toISOString()
    : new Date(`${fromArg}T00:00:00+05:00`);
  const toIso = toArg ? to : new Date(new Date(from).getTime() + 24 * 60 * 60 * 1000).toISOString();
  return { from, to: toIso };
}

async function fetchBacklog(from, to) {
  const PAGE_SIZE = 1000;
  let all = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('listings')
      .select('*')
      .gte('created_at', from)
      .lt('created_at', to)
      .neq('label_kind', 'agent') // агентства не рассылаем — так же, как в обычном run.js
      .order('created_at', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`Supabase: ${error.message}`);
    all = all.concat(data);
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

async function main() {
  const { from, to } = parseArgs();
  console.log(`Диапазон: ${from} → ${to}`);

  const listings = await fetchBacklog(from, to);
  console.log(`Найдено объявлений (без агентств): ${listings.length}`);

  const done = loadProgress();
  const remaining = listings.filter((l) => !done.has(l.id));
  console.log(`Уже отправлено ранее (прогресс из ${PROGRESS_FILE.pathname}): ${done.size}`);
  console.log(`Осталось отправить: ${remaining.length}`);
  if (remaining.length === 0) {
    console.log('Нечего отправлять — либо всё уже разослано, либо за этот период ничего нет.');
    return;
  }

  const etaMin = Math.ceil((remaining.length * 1.2) / 60);
  console.log(`Ориентировочное время: ~${etaMin} мин. Можно прервать (Ctrl+C) и продолжить позже — прогресс сохраняется.`);

  let sent = 0;
  let failed = 0;
  for (const listing of remaining) {
    try {
      await notifyToTopicGroup(listing);
      done.add(listing.id);
      sent++;
      if (sent % 20 === 0) saveProgress(done); // не пишем файл на каждое сообщение — раз в 20
      console.log(`[${sent}/${remaining.length}] ${listing.property_type} · ${listing.district || 'без района'} · ${listing.title}`);
    } catch (err) {
      failed++;
      console.error(`Ошибка на "${listing.title}" (${listing.id}):`, err.message);
      // Не добавляем в done — при следующем запуске попробуется снова.
    }
    await new Promise((r) => setTimeout(r, 1200));
  }

  saveProgress(done);
  console.log(`Готово. Отправлено: ${sent}. Ошибок: ${failed}.`);
}

main().catch((err) => {
  console.error('Скрипт упал:', err);
  process.exit(1);
});
