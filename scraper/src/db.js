import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

// Supabase-клиент по умолчанию создаёт Realtime-подключение (даже если
// оно нам не нужно — мы им не пользуемся), а для этого ему нужен
// глобальный WebSocket. В Node.js < 22 его нет, поэтому передаём
// реализацию из пакета ws явно — так не зависим от того, какую версию
// Node.js фактически использует раннер GitHub Actions.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY, // service_role ключ — обходит RLS, только для бэкенда, никогда не светить на фронтенде
  {
    realtime: { transport: WebSocket },
  }
);

export async function isKnown(id) {
  const { data, error } = await supabase.from('listings').select('id').eq('id', id).maybeSingle();
  if (error) {
    console.error('Supabase (isKnown) ошибка:', error.message);
    return false; // при сбое лучше перепроверить объявление ещё раз, чем потерять его
  }
  return !!data;
}

/**
 * @returns {Promise<boolean>} true, если запись реально сохранилась.
 * ВАЖНО: раньше эта функция ничего не возвращала, а ошибку просто
 * логировала — вызывающий код (run.js) не знал, что сохранение не
 * удалось, и всё равно слал уведомление в Telegram и пытался
 * отметить notified=true. Если строки в базе на самом деле не было,
 * markNotified молча обновлял 0 строк (без ошибки), и на следующем
 * прогоне isKnown() снова возвращал false — объявление уходило в
 * Telegram ПОВТОРНО. Теперь вызывающий код обязан проверять результат
 * и не слать уведомление, если сохранение не удалось.
 */
export async function saveListing(listing) {
  const { error } = await supabase
    .from('listings')
    .upsert({ ...listing, contacted: false }, { onConflict: 'id', ignoreDuplicates: true });
  if (error) {
    console.error('Supabase (saveListing) ошибка:', error.message);
    return false;
  }
  return true;
}

export async function markNotified(id) {
  const { error } = await supabase.from('listings').update({ notified: true }).eq('id', id);
  if (error) {
    console.error('Supabase (markNotified) ошибка:', error.message);
  }
}

/**
 * Возвращает message_thread_id темы для пары (groupKey, district),
 * или null, если такой темы ещё нет (тогда сообщение уйдёт в общую
 * тему группы без привязки к теме).
 */
export async function getTopicId(groupKey, district) {
  if (!district) return null;
  const { data, error } = await supabase
    .from('forum_topics')
    .select('message_thread_id')
    .eq('group_key', groupKey)
    .eq('district', district)
    .maybeSingle();
  if (error) {
    console.error('Supabase (getTopicId) ошибка:', error.message);
    return null;
  }
  return data?.message_thread_id ?? null;
}

/**
 * Сохраняет ID темы после того, как она создана в Telegram
 * (см. scraper/src/setup-topics.js).
 */
export async function saveTopicId(groupKey, district, messageThreadId) {
  const { error } = await supabase
    .from('forum_topics')
    .upsert({ group_key: groupKey, district, message_thread_id: messageThreadId }, { onConflict: 'group_key,district' });
  if (error) {
    console.error('Supabase (saveTopicId) ошибка:', error.message);
  }
}
