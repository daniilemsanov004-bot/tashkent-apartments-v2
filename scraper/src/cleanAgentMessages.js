import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { deleteTelegramMessage } from './telegram.js';
import { markTelegramDeleted } from './db.js';

// Общая логика "удалить из Telegram все сообщения, помеченные как
// агентство, у которых уже известен telegram_chat_id/telegram_message_id".
// Раньше это было только внутри delete-agent-messages.js (разовый
// ручной запуск). Теперь это отдельная функция, чтобы её могли звать:
//   1. delete-agent-messages.js — как раньше, вручную из терминала
//   2. run.js — автоматически в конце каждого прогона скрапера (а он
//      уже и так запускается раз в 15 минут через cron-job.org), так
//      что очистка происходит "по расписанию" без отдельной настройки
//   3. клиентские api/clean-agents.js и api/telegram-webhook.js на
//      Vercel — но ТЕ используют свою версию на fetch (см.
//      client/api/_cleanAgents.js), т.к. этот файл тянет
//      node-telegram-bot-api и не предназначен для serverless-бандла.
//
// Никаких side-effects на модульном уровне (нет своего supabase-клиента
// с realtime) — просто создаём подключение здесь же, как и раньше в
// delete-agent-messages.js.

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  realtime: { transport: WebSocket },
});

async function fetchAgentBacklog() {
  const PAGE_SIZE = 1000;
  let all = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('listings')
      .select('id, url, title, telegram_chat_id, telegram_message_id, telegram_deleted, label_kind, flagged_agent')
      .or('label_kind.eq.agent,flagged_agent.eq.true')
      .neq('telegram_deleted', true)
      .order('created_at', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`Supabase: ${error.message}`);
    all = all.concat(data);
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

// Возвращает статистику + список объявлений, которые не получилось
// удалить (для печати ссылок вручную) и список без сохранённого id
// (старый мусор, отправленный до миграции message tracking).
export async function cleanAgentBacklog({ quiet = false } = {}) {
  const backlog = await fetchAgentBacklog();
  const withId = backlog.filter((l) => l.telegram_chat_id && l.telegram_message_id);
  const withoutId = backlog.filter((l) => !(l.telegram_chat_id && l.telegram_message_id));

  let deleted = 0;
  let failed = 0;
  const manualWithId = [];

  for (const listing of withId) {
    const ok = await deleteTelegramMessage(listing.telegram_chat_id, listing.telegram_message_id);
    if (ok) {
      await markTelegramDeleted(listing.id);
      deleted++;
      if (!quiet) console.log(`✅ удалено: ${listing.title}`);
    } else {
      failed++;
      manualWithId.push(listing);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  return {
    totalCandidates: backlog.length,
    deleted,
    failed,
    manualWithId, // не удалилось (скорее всего сообщения старше миграции/48ч) — ссылки для ручной чистки
    withoutIdCount: withoutId.length, // никогда не было id — автоматически недостижимо, см. backfill-from-telegram-export.js
  };
}
