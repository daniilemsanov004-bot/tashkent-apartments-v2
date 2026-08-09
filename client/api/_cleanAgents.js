import { supabase } from './_supabase.js';
import { deleteMessage } from './_telegramApi.js';

// Serverless-функции на Vercel ограничены по времени выполнения
// (обычно 10-60 сек в зависимости от плана) — поэтому, в отличие от
// scraper/src/cleanAgentMessages.js (который гоняется в GitHub
// Actions без такого лимита), эта версия чистит НЕ весь бэклог сразу,
// а батчами по `limit` штук за один вызов и говорит, остался ли ещё
// хвост (hasMore), чтобы вызывающий код (кнопка в дашборде, команда
// /clean в боте) мог повторить запрос сам.

export async function cleanAgentMessagesBatch(limit = 60) {
  const { data, error } = await supabase
    .from('listings')
    .select('id, telegram_chat_id, telegram_message_id')
    .or('label_kind.eq.agent,flagged_agent.eq.true')
    .neq('telegram_deleted', true)
    .not('telegram_chat_id', 'is', null)
    .not('telegram_message_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(limit + 1);

  if (error) throw new Error(`Supabase: ${error.message}`);

  const hasMore = data.length > limit;
  const batch = data.slice(0, limit);

  let deleted = 0;
  let failed = 0;
  for (const listing of batch) {
    const ok = await deleteMessage(listing.telegram_chat_id, listing.telegram_message_id);
    if (ok) {
      await supabase.from('listings').update({ telegram_deleted: true }).eq('id', listing.id);
      deleted++;
    } else {
      failed++;
      // Не получилось — скорее всего сообщение старше 48ч/старше
      // миграции чата (см. scraper/src/cleanAgentMessages.js). Чтобы
      // не пытаться удалить его заново на каждый клик кнопки/каждую
      // команду /clean, помечаем его тоже как telegram_deleted —
      // цена ошибки минимальна (просто пропустим при следующей чистке),
      // а плюс большой (не тратим время и не долбим Telegram API одним
      // и тем же безнадёжным запросом раз за разом).
      await supabase.from('listings').update({ telegram_deleted: true }).eq('id', listing.id);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  return { processed: batch.length, deleted, failed, hasMore };
}
