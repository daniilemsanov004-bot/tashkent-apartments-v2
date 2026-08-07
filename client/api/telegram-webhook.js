// Webhook для интерактивного поиска прямо в Telegram-группе.
// Доступен ВСЕМ участникам группы (не только админам), полный фильтр
// сразу (район + комнаты + цена + тип сделки), в виде кнопок —
// как и просил пользователь.
//
// НАСТРОЙКА (сделать один раз после деплоя на Vercel):
//  1. В Vercel → Project Settings → Environment Variables добавить:
//     TELEGRAM_WEBHOOK_SECRET — любая случайная строка, придумайте сами
//       (напр. openssl rand -hex 24 в терминале).
//     EXCHANGE_RATE_USD_UZS — опционально, курс $ к суму для сравнения
//       цен в разных валютах при фильтрации (по умолчанию ~11990,
//       актуально на 04.08.2026 — стоит периодически сверять с
//       реальным курсом ЦБ РУз и обновлять).
//  2. У бота в @BotFather выполнить /setprivacy → Disable для этого
//     бота — БЕЗ этого бот не будет видеть обычные текстовые
//     сообщения в группе (только команды), и шаг "введите цену
//     текстом" не будет работать.
//  3. Зарегистрировать сам webhook (один раз, из терминала, замените
//     значения на свои):
//     curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
//       -d "url=https://<ваш-домен>.vercel.app/api/telegram-webhook" \
//       -d "secret_token=<тот же TELEGRAM_WEBHOOK_SECRET>"
//  4. Проверить: curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
//     — там должен появиться ваш URL без pending_update_count ошибок.
//
// Как пользоваться в группе: любой участник пишет /find (или жмёт
// кнопку "🔍 Найти" в приветственном сообщении бота) и проходит
// короткий мастер из кнопок.

import { supabase } from './_supabase.js';
import { sendMessage, editMessageText, answerCallbackQuery, escapeHtml } from './_telegramApi.js';
import { DISTRICTS, districtSlug, districtFromSlug } from './_districts.js';
import { parsePriceRange } from './_priceParser.js';
import { buildListingText, buildListingButtons } from './_listingMessage.js';

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const EXCHANGE_RATE_USD_UZS = Number(process.env.EXCHANGE_RATE_USD_UZS) || 11990;
const RESULTS_PAGE_SIZE = 5;
const SEARCH_WINDOW_DAYS = 14; // не тащим совсем старые объявления в поиск

// ---------- session (bot_sessions table) ----------

async function getSession(chatId, userId) {
  const { data } = await supabase
    .from('bot_sessions')
    .select('state')
    .eq('chat_id', chatId)
    .eq('user_id', userId)
    .maybeSingle();
  return data?.state || null;
}

async function saveSession(chatId, userId, state) {
  await supabase
    .from('bot_sessions')
    .upsert({ chat_id: chatId, user_id: userId, state, updated_at: new Date().toISOString() });
}

function displayName(from) {
  if (!from) return 'Агент';
  if (from.username) return `@${from.username}`;
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Агент';
}

// ---------- кнопки "Связался" / "Беру в работу" на карточках объявлений ----------
// Не часть мастера поиска (bot_sessions) — работают на самих
// сообщениях-объявлениях в супергруппах, независимо от сессии.

async function refreshListingMessage(chatId, messageId, listingId) {
  const { data: listing, error } = await supabase.from('listings').select('*').eq('id', listingId).maybeSingle();
  if (error || !listing) {
    console.error('Не удалось перечитать объявление для обновления карточки:', error?.message || 'не найдено');
    return null;
  }
  // editMessageText по умолчанию просит Telegram парсить текст как
  // HTML — а в тексте карточки есть "сырая" ссылка на объявление, в
  // которой почти всегда есть символ "&" (разделитель параметров
  // URL). Для HTML это служебный символ, из-за него Telegram
  // отказывается парсить текст и правка тихо не применяется. Текст
  // карточки и так без HTML-разметки (как и при первой отправке из
  // scraper/telegram.js), поэтому здесь явно отключаем HTML-режим.
  await editMessageText(chatId, messageId, buildListingText(listing), {
    parse_mode: undefined,
    reply_markup: { inline_keyboard: buildListingButtons(listing) },
  });
  return listing;
}

async function toggleContacted(chatId, messageId, listingId, agentName, callbackId) {
  const { data: current } = await supabase.from('listings').select('contacted').eq('id', listingId).maybeSingle();
  const next = !current?.contacted;
  await supabase
    .from('listings')
    .update({
      contacted: next,
      contacted_by: next ? agentName : null,
      contacted_at: next ? new Date().toISOString() : null,
    })
    .eq('id', listingId);
  await refreshListingMessage(chatId, messageId, listingId);
  await answerCallbackQuery(callbackId, next ? '✅ Отмечено' : 'Отметка снята');
}

async function toggleAssigned(chatId, messageId, listingId, agentName, callbackId) {
  const { data: current } = await supabase.from('listings').select('assigned_to').eq('id', listingId).maybeSingle();
  if (current?.assigned_to && current.assigned_to !== agentName) {
    // Уже кто-то другой взял в работу — не перехватываем молча, а
    // показываем всплывающее уведомление, чтобы не звонили вдвоём.
    await answerCallbackQuery(callbackId, `Уже взял в работу: ${current.assigned_to}`);
    return;
  }
  const next = current?.assigned_to ? null : agentName; // повторное нажатие тем же агентом — освобождает
  await supabase
    .from('listings')
    .update({ assigned_to: next, assigned_at: next ? new Date().toISOString() : null })
    .eq('id', listingId);
  await refreshListingMessage(chatId, messageId, listingId);
  await answerCallbackQuery(callbackId, next ? '👤 Взято в работу' : 'Освобождено');
}



function dealTypeKeyboard() {
  return [[{ text: '🔑 Аренда', callback_data: 'dt:rent' }, { text: '🏷️ Продажа', callback_data: 'dt:sale' }]];
}

function propertyTypeKeyboard() {
  return [
    [{ text: '🏢 Квартиры', callback_data: 'pt:apartment' }, { text: '🏡 Дома', callback_data: 'pt:house' }],
    [{ text: '🏬 Коммерция', callback_data: 'pt:commercial' }, { text: '🤷 Неважно', callback_data: 'pt:any' }],
  ];
}

function districtKeyboard(selected) {
  const rows = [];
  for (let i = 0; i < DISTRICTS.length; i += 2) {
    const row = DISTRICTS.slice(i, i + 2).map((d) => {
      const slug = districtSlug(d.canonical);
      const mark = selected.includes(d.canonical) ? '✅ ' : '';
      return { text: `${mark}${d.canonical}`, callback_data: `d:${slug}` };
    });
    rows.push(row);
  }
  rows.push([{ text: '🌆 Любой район', callback_data: 'd:any' }]);
  rows.push([{ text: '➡️ Далее', callback_data: 'd:done' }]);
  return rows;
}

function roomsKeyboard() {
  return [
    [
      { text: '1', callback_data: 'r:1' },
      { text: '2', callback_data: 'r:2' },
      { text: '3', callback_data: 'r:3' },
      { text: '4', callback_data: 'r:4' },
      { text: '5+', callback_data: 'r:5plus' },
    ],
    [{ text: '🤷 Неважно', callback_data: 'r:any' }],
  ];
}

function priceKeyboard() {
  return [[{ text: '💸 Без ограничений по цене', callback_data: 'p:any' }]];
}

function resultsKeyboard(hasMore) {
  const row = [];
  if (hasMore) row.push({ text: '➡️ Ещё', callback_data: 'more' });
  row.push({ text: '🔄 Новый поиск', callback_data: 'new' });
  return [row];
}

async function toggleFlaggedAgent(chatId, messageId, listingId, agentName, callbackId) {
  const { data: current } = await supabase.from('listings').select('flagged_agent').eq('id', listingId).maybeSingle();
  const next = !current?.flagged_agent;
  await supabase
    .from('listings')
    .update({ flagged_agent: next, flagged_by: next ? agentName : null, flagged_at: next ? new Date().toISOString() : null })
    .eq('id', listingId);
  await refreshListingMessage(chatId, messageId, listingId);
  await answerCallbackQuery(callbackId, next ? '🚫 Отмечено как агентство' : 'Пометка снята');
}

// Заметки не пишутся мастером/кнопками (Telegram не даёт открыть
// текстовое поле по кнопке) — вместо этого просим агента ОТВЕТИТЬ
// (Reply) на специальное сообщение-приглашение, которое бот отправляет
// сам. Так надёжнее, чем "просто следующее сообщение в чате" — в
// групповом чате между нажатием кнопки и ответом агента может
// проскочить сообщение от кого-то другого.
async function promptForNote(chatId, cardMessageId, listingId, userId) {
  const res = await sendMessage(chatId, '✏️ Напишите заметку ОТВЕТОМ (Reply) на это сообщение.', {
    reply_to_message_id: cardMessageId,
  });
  const promptMessageId = res?.result?.message_id;
  if (!promptMessageId) return;
  await saveSession(chatId, userId, { mode: 'awaiting_note', listingId, cardMessageId, promptMessageId });
}

async function tryHandleNoteReply(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const session = await getSession(chatId, userId);
  if (session?.mode !== 'awaiting_note') return false;
  if (!message.text || message.reply_to_message?.message_id !== session.promptMessageId) return false;

  await supabase.from('listings').update({ notes: message.text.slice(0, 500) }).eq('id', session.listingId);
  await refreshListingMessage(chatId, session.cardMessageId, session.listingId);
  await saveSession(chatId, userId, {});
  await sendMessage(chatId, '📝 Заметка сохранена.');
  return true;
}

// ---------- text helpers ----------

const DEAL_LABEL = { rent: '🔑 Аренда', sale: '🏷️ Продажа' };
const PROPERTY_LABEL = { apartment: '🏢 Квартиры', house: '🏡 Дома', commercial: '🏬 Коммерция', any: 'любой тип' };

function roomsLabel(rooms) {
  if (!rooms || rooms === 'any') return 'неважно';
  if (rooms === '5plus') return '5+';
  return String(rooms);
}

function filtersSummary(filters) {
  const parts = [
    DEAL_LABEL[filters.dealType] || '',
    PROPERTY_LABEL[filters.propertyType] || '',
    filters.districts?.length ? filters.districts.join(', ') : 'любой район',
    `комнат: ${roomsLabel(filters.rooms)}`,
  ];
  if (filters.priceRange) {
    const { min, max, currency } = filters.priceRange;
    const unit = currency === 'USD' ? '$' : 'сум';
    if (min && max) parts.push(`цена: ${min.toLocaleString('ru')}–${max.toLocaleString('ru')} ${unit}`);
    else if (min) parts.push(`цена: от ${min.toLocaleString('ru')} ${unit}`);
    else if (max) parts.push(`цена: до ${max.toLocaleString('ru')} ${unit}`);
  }
  return parts.filter(Boolean).join(' · ');
}

function listingLine(l) {
  const badge = l.label_kind === 'owner' ? '✅' : l.label_kind === 'agent' ? '🏢' : '📋';
  const roomsPart = l.rooms ? `${l.rooms}-комн. ` : '';
  const areaPart = l.area ? `, ${l.area} м²` : '';
  const districtPart = l.district ? ` · 📍 ${l.district}` : '';
  return (
    `${badge} <b>${roomsPart}${escapeHtml(l.title)}${areaPart}</b>\n` +
    `💰 ${escapeHtml(l.price || 'цена не указана')}${districtPart}\n` +
    `${escapeHtml(l.url)}`
  );
}

// ---------- price range in UZS for comparison ----------

function toUzs(value, currency) {
  if (value === null || value === undefined) return null;
  return currency === 'USD' ? value * EXCHANGE_RATE_USD_UZS : value;
}

function listingPriceUzs(l) {
  return toUzs(l.price_value, l.price_currency);
}

// ---------- search ----------

async function runSearch(filters) {
  let query = supabase.from('listings').select('*').order('created_at', { ascending: false }).range(0, 999);

  // Агентства (label_kind='agent') не показываем — как и на сайте/в
  // push-уведомлениях, их снова полностью скрываем.
  query = query.neq('label_kind', 'agent');

  if (filters.dealType) query = query.eq('deal_type', filters.dealType);
  if (filters.propertyType && filters.propertyType !== 'any') query = query.eq('property_type', filters.propertyType);
  if (filters.districts?.length) query = query.in('district', filters.districts);
  if (filters.rooms && filters.rooms !== 'any') {
    if (filters.rooms === '5plus') query = query.gte('rooms', 5);
    else query = query.eq('rooms', Number(filters.rooms));
  }

  const cutoff = new Date(Date.now() - SEARCH_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  query = query.gte('created_at', cutoff);

  const { data, error } = await query;
  if (error) {
    console.error('Ошибка поиска в Supabase:', error.message);
    return [];
  }

  let results = data || [];

  if (filters.priceRange) {
    const minUzs = toUzs(filters.priceRange.min, filters.priceRange.currency);
    const maxUzs = toUzs(filters.priceRange.max, filters.priceRange.currency);
    results = results.filter((l) => {
      const priceUzs = listingPriceUzs(l);
      if (priceUzs === null) return false; // без цены — не знаем, попадает ли в диапазон
      if (minUzs !== null && priceUzs < minUzs) return false;
      if (maxUzs !== null && priceUzs > maxUzs) return false;
      return true;
    });
  }

  // Собственники сверху, дальше новые сверху — та же логика, что и на сайте.
  const rank = { owner: 0, unchecked: 1, uncertain: 2, agent: 3 };
  results.sort((a, b) => {
    const rd = (rank[a.label_kind] ?? 1) - (rank[b.label_kind] ?? 1);
    if (rd !== 0) return rd;
    return new Date(b.created_at) - new Date(a.created_at);
  });

  // В сессию кладём только компактные поля — полная строка на 100+
  // объявлений в jsonb не нужна и раздувает таблицу.
  return results.slice(0, 100).map((l) => ({
    title: l.title,
    price: l.price,
    district: l.district,
    rooms: l.rooms,
    area: l.area,
    url: l.url,
    label_kind: l.label_kind,
  }));
}

async function renderResultsPage(chatId, messageId, state) {
  const { results, offset, filters } = state;
  const page = results.slice(offset, offset + RESULTS_PAGE_SIZE);
  const hasMore = offset + RESULTS_PAGE_SIZE < results.length;

  let text;
  if (results.length === 0) {
    text = `😕 По фильтру ничего не нашлось за последние ${SEARCH_WINDOW_DAYS} дней.\n\n<i>${filtersSummary(filters)}</i>`;
  } else {
    const header = `🔎 Найдено: ${results.length}\n<i>${filtersSummary(filters)}</i>\n\n`;
    text = header + page.map(listingLine).join('\n\n');
  }

  await editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: resultsKeyboard(hasMore) } });
}

// ---------- main step handlers ----------

async function startWizard(chatId, userId, existingMessageId) {
  const text = 'Выберите тип сделки:';
  const markup = { reply_markup: { inline_keyboard: dealTypeKeyboard() } };

  let messageId = existingMessageId;
  if (existingMessageId) {
    await editMessageText(chatId, existingMessageId, text, markup);
  } else {
    const res = await sendMessage(chatId, text, markup);
    messageId = res?.result?.message_id;
  }

  await saveSession(chatId, userId, {
    step: 'deal_type',
    menuMessageId: messageId,
    filters: { districts: [] },
  });
}

async function handleCallback(update) {
  const cb = update.callback_query;
  const data = cb.data || '';
  const chatId = cb.message.chat.id;
  const userId = cb.from.id;
  const messageId = cb.message.message_id;

  // Кнопки на карточках объявлений ("Связался"/"Беру в работу") — не
  // часть мастера поиска, обрабатываем сразу и выходим, до всей
  // остальной логики сессий ниже.
  if (data.startsWith('ct:')) {
    await toggleContacted(chatId, messageId, data.slice(3), displayName(cb.from), cb.id);
    return;
  }
  if (data.startsWith('as:')) {
    await toggleAssigned(chatId, messageId, data.slice(3), displayName(cb.from), cb.id);
    return;
  }
<<<<<<< HEAD
  if (data.startsWith('fl:')) {
    await toggleFlaggedAgent(chatId, messageId, data.slice(3), displayName(cb.from), cb.id);
    return;
  }
  if (data.startsWith('nt:')) {
    await promptForNote(chatId, messageId, data.slice(3), userId);
    await answerCallbackQuery(cb.id);
    return;
  }
=======
>>>>>>> a8eaa5b875f521546dcdd801445f7f0dbe1ecab0

  await answerCallbackQuery(cb.id);

  if (data === 'new') {
    await startWizard(chatId, userId, messageId);
    return;
  }

  const session = await getSession(chatId, userId);
  if (!session) {
    // Сессия потерялась (истекла/сброшена) — начинаем заново на этом же сообщении.
    await startWizard(chatId, userId, messageId);
    return;
  }
  const filters = session.filters;

  if (data.startsWith('dt:')) {
    filters.dealType = data.slice(3);
    session.step = 'property_type';
    await editMessageText(chatId, messageId, 'Тип недвижимости:', {
      reply_markup: { inline_keyboard: propertyTypeKeyboard() },
    });
  } else if (data.startsWith('pt:')) {
    filters.propertyType = data.slice(3);
    session.step = 'district';
    await editMessageText(chatId, messageId, 'Район (можно выбрать несколько):', {
      reply_markup: { inline_keyboard: districtKeyboard(filters.districts) },
    });
  } else if (data.startsWith('d:')) {
    const slug = data.slice(2);
    if (slug === 'any') {
      filters.districts = [];
      session.step = 'rooms';
      await editMessageText(chatId, messageId, 'Сколько комнат?', {
        reply_markup: { inline_keyboard: roomsKeyboard() },
      });
    } else if (slug === 'done') {
      session.step = 'rooms';
      await editMessageText(chatId, messageId, 'Сколько комнат?', {
        reply_markup: { inline_keyboard: roomsKeyboard() },
      });
    } else {
      const canonical = districtFromSlug(slug);
      if (canonical) {
        const idx = filters.districts.indexOf(canonical);
        if (idx === -1) filters.districts.push(canonical);
        else filters.districts.splice(idx, 1);
      }
      await editMessageText(chatId, messageId, 'Район (можно выбрать несколько):', {
        reply_markup: { inline_keyboard: districtKeyboard(filters.districts) },
      });
    }
  } else if (data.startsWith('r:')) {
    filters.rooms = data.slice(2);
    session.step = 'price';
    await editMessageText(
      chatId,
      messageId,
      'Диапазон цены?\n\nОтветьте (Reply) на это сообщение, например: <code>300-800 млн</code>, <code>от 2 млрд</code>, <code>500-1500$</code> — или нажмите кнопку ниже, если цена неважна.',
      { reply_markup: { inline_keyboard: priceKeyboard() } }
    );
  } else if (data === 'p:any') {
    filters.priceRange = null;
    const results = await runSearch(filters);
    session.step = 'results';
    session.results = results;
    session.offset = 0;
    await renderResultsPage(chatId, messageId, session);
  } else if (data === 'more') {
    session.offset = (session.offset || 0) + RESULTS_PAGE_SIZE;
    await renderResultsPage(chatId, messageId, session);
  }

  await saveSession(chatId, userId, session);
}

async function handlePriceTextReply(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const session = await getSession(chatId, userId);
  if (!session || session.step !== 'price') return false; // не наш случай, игнорируем

  const parsed = parsePriceRange(message.text);
  if (!parsed) {
    await sendMessage(chatId, '🤔 Не понял диапазон. Попробуйте, например: <code>300-800 млн</code> или <code>от 500$</code>.');
    return true;
  }

  session.filters.priceRange = parsed;
  const results = await runSearch(session.filters);
  session.step = 'results';
  session.results = results;
  session.offset = 0;
  await renderResultsPage(chatId, session.menuMessageId, session);
  await saveSession(chatId, userId, session);
  return true;
}

// Мастер поиска /find отключён (07.08.2026) — теперь объявления сами
// разлетаются по тематическим супергруппам/темам (см.
// notifyToTopicGroup в scraper/src/telegram.js), поэтому отдельный
// поиск через бота стал не нужен. Код мастера (startWizard и всё,
// что использует bot_sessions) НЕ удалён — оставлен на случай, если
// понадобится вернуть или переделать под другую команду (например
// "мои объявления"). Чтобы включить обратно — верните в true.
const FIND_WIZARD_ENABLED = false;

function commandName(message) {
  const entity = (message.entities || []).find((e) => e.type === 'bot_command' && e.offset === 0);
  if (!entity) return null;
  return message.text.slice(0, entity.length).split('@')[0]; // срезаем @имя_бота, если есть
}

async function handleMessage(message) {
  if (await tryHandleNoteReply(message)) return;

  const cmd = commandName(message);
  if (cmd === '/start' || cmd === '/find') {
    if (!FIND_WIZARD_ENABLED) {
      await sendMessage(
        message.chat.id,
        'Поиск через бота сейчас не нужен — объявления сами приходят в свою тему группы по типу и району.'
      );
      return;
    }
    await startWizard(message.chat.id, message.from.id, null);
    return;
  }
  if (message.text && !cmd) {
    await handlePriceTextReply(message);
  }
}

// ---------- entrypoint ----------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  if (WEBHOOK_SECRET) {
    const got = req.headers['x-telegram-bot-api-secret-token'];
    if (got !== WEBHOOK_SECRET) {
      res.status(401).json({ error: 'bad secret token' });
      return;
    }
  }

  const update = req.body;
  try {
    if (update?.callback_query) {
      await handleCallback(update);
    } else if (update?.message) {
      await handleMessage(update.message);
    }
  } catch (err) {
    console.error('Ошибка обработки Telegram-апдейта:', err);
  }

  // Telegram ждёт 200 OK независимо от результата обработки — иначе
  // будет повторять доставку того же апдейта.
  res.status(200).json({ ok: true });
}
