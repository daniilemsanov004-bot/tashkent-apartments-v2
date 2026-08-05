// Тонкая обёртка над Telegram Bot API через обычный fetch — отдельная
// от scraper/src/telegram.js (та работает в GitHub Actions и только
// ОТПРАВЛЯЕТ уведомления). Эта — для интерактивного бота на Vercel,
// который ОТВЕЧАЕТ на команды и нажатия кнопок через webhook.

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const API = `https://api.telegram.org/bot${TOKEN}`;

function assertConfigured() {
  if (!TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN не задан в переменных окружения Vercel');
  }
}

async function call(method, payload) {
  assertConfigured();
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`Telegram API ошибка (${method}):`, data.description);
  }
  return data;
}

export function sendMessage(chatId, text, extra = {}) {
  return call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

export function editMessageText(chatId, messageId, text, extra = {}) {
  return call('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

export function answerCallbackQuery(callbackQueryId, text = '') {
  return call('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
