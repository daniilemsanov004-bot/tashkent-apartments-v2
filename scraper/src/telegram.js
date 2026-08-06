import TelegramBot from 'node-telegram-bot-api';
import { getTopicId } from './db.js';

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

// Хештеги в тексте сообщения — не отдельная функция бота, а просто
// слова вида #Чиланзар в самом сообщении. Telegram делает такие слова
// кликабельными и учитывает их во встроенном поиске по чату (можно
// набрать "#Чиланзар" в поиске чата и увидеть только эти объявления).
// Хештег не может содержать пробелы/дефисы/цифры-в-начале — чистим.
function toHashtag(word) {
  if (!word) return null;
  const cleaned = String(word)
    .replace(/['".,()]/g, '')
    .replace(/[\s\-]+/g, '');
  if (!cleaned) return null;
  return `#${cleaned}`;
}

function buildHashtags(listing) {
  const tags = [];
  const dealTag = listing.deal_type === 'sale' ? 'продажа' : listing.deal_type === 'rent' ? 'аренда' : null;
  if (dealTag) tags.push(toHashtag(dealTag));

  const typeTag =
    listing.property_type === 'house' ? 'дом' : listing.property_type === 'commercial' ? 'коммерция' : 'квартира';
  tags.push(toHashtag(typeTag));

  if (listing.district) tags.push(toHashtag(listing.district));
  if (listing.rooms) tags.push(toHashtag(`${listing.rooms}комн`));

  return tags.filter(Boolean).join(' ');
}

/**
 * Собирает текст сообщения и кнопки — общая логика для обоих
 * назначений (основная группа с /find и тематические супергруппы).
 */
function buildMessagePayload(listing) {
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
        ? '🙂 Скорее всего собственник'
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

  return { message, buttons };
}

export async function notifyNewListing(listing) {
  if (!bot || !chatId) {
    console.warn('Telegram не настроен — пропускаю уведомление');
    return;
  }

  const { message, buttons } = buildMessagePayload(listing);

  await bot.sendMessage(chatId, message, {
    disable_web_page_preview: false,
    reply_markup: { inline_keyboard: buttons },
  });
}

// Соответствие property_type (+ deal_type для аренды квартир — у неё
// отдельная супергруппа) → переменная окружения с chat_id группы.
const TOPIC_GROUPS = {
  apartment: (process.env.TELEGRAM_GROUP_APARTMENT || '').trim(),
  apartment_rent: (process.env.TELEGRAM_GROUP_APARTMENT_RENT || '').trim(),
  commercial: (process.env.TELEGRAM_GROUP_COMMERCIAL || '').trim(),
  house: (process.env.TELEGRAM_GROUP_HOUSE || '').trim(),
};

/**
 * Аренда квартир — единственный случай, где группа зависит не только
 * от property_type, но и от deal_type (продажа квартир остаётся в
 * обычной группе "Квартиры"). Если TELEGRAM_GROUP_APARTMENT_RENT ещё
 * не настроена — просто уходит в общую группу "Квартиры", как раньше,
 * ничего не ломается.
 */
function resolveGroupKey(listing) {
  if (listing.property_type === 'apartment' && listing.deal_type === 'rent' && TOPIC_GROUPS.apartment_rent) {
    return 'apartment_rent';
  }
  return listing.property_type || 'apartment';
}

/**
 * Отправляет объявление в тему нужного района внутри одной из
 * супергрупп (Квартиры/Аренда квартир/Коммерция/Дома). Если группа для
 * этого типа не настроена (нет в .env) — просто ничего не делает,
 * молча. Если район неизвестен/тема ещё не создана (setup-topics.js не
 * запускали для него) — уходит в общую тему группы.
 */
export async function notifyToTopicGroup(listing) {
  const groupKey = resolveGroupKey(listing);
  const targetChatId = TOPIC_GROUPS[groupKey];
  if (!bot || !targetChatId) return;

  const { message, buttons } = buildMessagePayload(listing);
  const messageThreadId = await getTopicId(groupKey, listing.district);

  try {
    await bot.sendMessage(targetChatId, message, {
      disable_web_page_preview: false,
      reply_markup: { inline_keyboard: buttons },
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    });
  } catch (err) {
    console.error(`Не удалось отправить в тематическую супергруппу (${groupKey}):`, err.message);
  }
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
