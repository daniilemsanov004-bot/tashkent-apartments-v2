import TelegramBot from 'node-telegram-bot-api';

const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();

let bot = null;
if (token) {
  // polling: false — боту не нужно ничего "слушать", он только отправляет
  bot = new TelegramBot(token, { polling: false });
}

/**
 * Проверка при старте — сразу видно в консоли, подключился ли бот
 * на самом деле, вместо того чтобы узнавать об этом только когда
 * первое уведомление не дойдёт.
 */
export async function checkTelegramConnection() {
  if (!token) {
    console.warn('⚠️  TELEGRAM_BOT_TOKEN не задан в .env — уведомления в Telegram работать не будут.');
    return;
  }
  if (!chatId) {
    console.warn('⚠️  TELEGRAM_CHAT_ID не задан в .env — уведомления в Telegram работать не будут.');
    return;
  }
  try {
    const me = await bot.getMe();
    console.log(`✅ Telegram-бот подключён: @${me.username}`);
  } catch (err) {
    console.error(`❌ Telegram-бот НЕ подключился: ${err.message}`);
    console.error('   Проверьте TELEGRAM_BOT_TOKEN в .env — возможно, скопирован не полностью.');
    return;
  }
  try {
    await bot.sendMessage(chatId, '✅ Бот подключён и готов присылать объявления.');
    console.log(`✅ Тестовое сообщение отправлено в chat_id ${chatId}`);
  } catch (err) {
    console.error(`❌ Не удалось отправить сообщение на chat_id "${chatId}": ${err.message}`);
    console.error('   Проверьте TELEGRAM_CHAT_ID в .env, и что вы нажали /start своему боту в Telegram.');
  }
}

export async function notifyNewListing(listing) {
  if (!bot || !chatId) {
    console.warn('Telegram не настроен — пропускаю уведомление');
    return;
  }

  const roomsLine = listing.rooms ? `${listing.rooms}-комн. ` : '';
  const areaLine = listing.area ? `, ${listing.area} м²` : '';
  const districtLine = listing.district ? `📍 ${listing.district}\n` : '';
  const phoneLine = listing.phone ? `📞 ${listing.phone}\n` : '';
  const dealLine = listing.deal_type === 'sale' ? '🏷️ Продажа\n' : listing.deal_type === 'rent' ? '🔑 Аренда\n' : '';
  const typeLine =
    listing.property_type === 'house' ? '🏡 Дом\n' : listing.property_type === 'commercial' ? '🏢 Коммерция\n' : '';

  const badge =
    listing.label_kind === 'owner'
      ? '✅ Собственник'
      : listing.label_kind === 'unchecked'
        ? '📋 Не проверено ИИ'
        : listing.label_kind === 'agent'
          ? '🏢 Похоже на агентство'
          : '❓ Сомнительно — проверьте сами';

  const message =
    `🏠 Новое объявление (${listing.source})\n` +
    `${badge}\n\n` +
    dealLine +
    typeLine +
    `${roomsLine}${listing.title}${areaLine}\n` +
    `💰 ${listing.price || 'цена не указана'}\n` +
    districtLine +
    phoneLine +
    `\n${listing.url}`;

  // Если номер удалось получить — добавляем кнопки для быстрой связи.
  // tel:-ссылка не терпит пробелов/дефисов — Telegram отклоняет всю
  // кнопку с ошибкой "Wrong port number specified in the URL".
  const buttons = [];
  if (listing.phone) {
    const digits = listing.phone.replace(/[^\d]/g, '');
    const national = digits.startsWith('998') ? digits.slice(3) : digits;
    const cleanPhone = `+998${national}`;
    buttons.push([
      { text: '💬 Написать в WhatsApp', url: `https://wa.me/${digits}` },
      { text: '📞 Позвонить', url: `tel:${cleanPhone}` },
    ]);
  }
  buttons.push([{ text: '🔗 Открыть объявление', url: listing.url }]);

  await bot.sendMessage(chatId, message, {
    disable_web_page_preview: false,
    reply_markup: { inline_keyboard: buttons },
  });
}

/**
 * Служебные алерты о сбоях парсера (сайт не открылся, селекторы
 * перестали находить объявления и т.п.) — чтобы вы узнали о проблеме
 * сразу, а не через неделю тишины, гадая, закончились ли объявления.
 */
export async function notifyAlert(text) {
  if (!bot || !chatId) return;
  try {
    await bot.sendMessage(chatId, text);
  } catch (err) {
    console.error('Не удалось отправить алерт в Telegram:', err.message);
  }
}
