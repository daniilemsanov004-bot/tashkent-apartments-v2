import 'dotenv/config';
import fs from 'fs';
import TelegramBot from 'node-telegram-bot-api';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

// Достаёт старые сообщения-агентства, которые delete-agent-messages.js
// не смог найти (у них никогда не сохранялся telegram_message_id —
// они отправлены до миграции). Bot API не даёт спросить у Telegram
// "какие сообщения ты вообще отправлял в этот чат" — но САМ Telegram
// Desktop умеет выгрузить полную историю чата в JSON, и там для
// каждого сообщения есть настоящий id. Дальше просто сопоставляем
// текст сообщения (там всегда есть ссылка на объявление, см.
// buildMessagePayload в telegram.js) с записью в базе по url.
//
// ⚠️ Ограничение "нельзя удалить сообщение старше 48 часов" в
// Telegram Bot API действует ТОЛЬКО когда бот не администратор чата.
// Если бот — админ супергруппы с правом удалять сообщения (а он им
// быть должен, раз создаёт темы через setup-topics.js) — возраст
// сообщения роли не играет, можно удалить хоть годовалое.
//
// КАК ПОЛУЧИТЬ ЭКСПОРТ (один раз на каждую супергруппу):
//   1. Telegram Desktop → открыть супергруппу → кнопка "⋮" (три точки)
//      сверху → "Export chat history".
//   2. В настройках экспорта: формат — JSON (не HTML!), достаточно
//      только текстовых сообщений (фото/видео можно выключить —
//      сильно быстрее и без лишнего веса на диске).
//   3. Дождаться экспорта — Telegram создаст папку с файлом result.json
//      внутри.
//
// ЗАПУСК (на каждую супергруппу отдельно):
//   cd scraper
//   node src/backfill-from-telegram-export.js "C:\путь\до\ChatExport\result.json"

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  realtime: { transport: WebSocket },
});

const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN не задан в .env');
  process.exit(1);
}
const bot = new TelegramBot(token, { polling: false });

const URL_RE = /https?:\/\/\S+/;

// Поле "text" в экспорте Telegram бывает то простой строкой, то
// массивом кусков (обычная часть — просто строка, форматированная —
// объект вида {type, text}). Склеиваем всё в одну строку.
function flattenText(text) {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) {
    return text.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  return '';
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Использование: node src/backfill-from-telegram-export.js <путь до result.json>');
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const exportData = JSON.parse(raw);

  // "id" в экспорте — те же цифры, что в ссылках t.me/c/<id>/... и в
  // internalId из buildTopicLink в других скриптах проекта. Настоящий
  // chat_id для Bot API — это "-100" + эти цифры.
  const chatId = `-100${exportData.id}`;
  console.log(`Чат: "${exportData.name}" → chat_id ${chatId}`);

  const me = await bot.getMe();
  const botFromId = `user${me.id}`;
  console.log(`Бот: @${me.username} (${botFromId})`);

  const botMessages = (exportData.messages || []).filter(
    (m) => m.type === 'message' && m.from_id === botFromId
  );
  console.log(`Сообщений от бота в экспорте: ${botMessages.length}`);

  let matched = 0;
  let notAgent = 0;
  let notFoundInDb = 0;
  let alreadyDeleted = 0;
  let deleted = 0;
  let deleteFailed = 0;

  for (const msg of botMessages) {
    const text = flattenText(msg.text);
    const urlMatch = text.match(URL_RE);
    if (!urlMatch) continue; // сообщение без ссылки на объявление (например, служебный алерт) — не трогаем

    const url = urlMatch[0];
    const { data: listing, error } = await supabase
      .from('listings')
      .select('id, label_kind, flagged_agent, telegram_deleted')
      .eq('url', url)
      .maybeSingle();

    if (error) {
      console.error(`Ошибка запроса к базе (${url}):`, error.message);
      continue;
    }
    if (!listing) {
      notFoundInDb++;
      continue;
    }
    matched++;

    if (listing.telegram_deleted) {
      alreadyDeleted++;
      continue;
    }
    if (!(listing.label_kind === 'agent' || listing.flagged_agent)) {
      notAgent++;
      continue; // собственник или непроверенное — не трогаем, оставляем в чате
    }

    const ok = await bot.deleteMessage(chatId, msg.id).then(
      () => true,
      (err) => {
        console.error(`Не удалось удалить сообщение ${msg.id} (${url}):`, err.message);
        return false;
      }
    );
    if (ok) {
      deleted++;
      await supabase
        .from('listings')
        .update({ telegram_chat_id: chatId, telegram_message_id: msg.id, telegram_deleted: true })
        .eq('id', listing.id);
      console.log(`✅ удалено: ${url}`);
    } else {
      deleteFailed++;
    }
    await new Promise((r) => setTimeout(r, 250)); // не долбим Telegram API слишком часто
  }

  console.log(
    `\nГотово.\n` +
      `Сопоставлено с базой: ${matched} из ${botMessages.length}.\n` +
      `Удалено сейчас: ${deleted}.\n` +
      `Не удалось удалить (ошибка Telegram): ${deleteFailed}.\n` +
      `Уже были помечены удалёнными: ${alreadyDeleted}.\n` +
      `Не агентства — оставлены как есть: ${notAgent}.\n` +
      `Не нашлись в базе (например, объявление почистили из БД раньше) — оставлены как есть: ${notFoundInDb}.`
  );
}

main().catch((err) => {
  console.error('Критическая ошибка:', err);
  process.exit(1);
});
