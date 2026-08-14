import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { fetchOlxDetails, fetchOlxSellerListingsCount } from '../scrapers/olx.js';
import { SELLER_LISTINGS_AGENT_THRESHOLD } from '../classify.js';
import { TOPIC_GROUPS, resolveGroupKey, deleteTelegramMessage } from '../telegram.js';
import { getTopicId, getTelegramMessageInfo, markTelegramDeleted } from '../db.js';

// Разовый скрипт: сегодняшние OLX-объявления, которые прошли под видом
// "не агент" по СТАРОЙ логике (фильтр по категории объявлений продавца,
// либо порог >2), перепроверяются по НОВОЙ логике (все категории,
// порог >3). Всё, что теперь распознаётся как агентство — помечается
// в базе (label_kind='agent'), чтобы:
//   - не мешать статистике/поиску в боте /find;
//   - было видно, что уже перепроверено (не будет повторной путаницы).
//
// ⚠️ Сообщения, УЖЕ отправленные в Telegram, этот скрипт НЕ удаляет —
// технически не может: id отправленных сообщений нигде не сохраняется,
// а Bot API не даёt боту читать историю чужого чата задним числом.
// В конце скрипт печатает список ссылок на объявления, которые он
// перепометил в агентов — их придётся найти и удалить в Telegram
// вручную (проще всего — по ссылке на объявление, она есть в тексте
// каждого сообщения, через поиск в самом Telegram).
//
// Запуск:
//   cd scraper
//   node src/recheck-owners.js                 — за сегодня (по умолчанию)
//   node src/recheck-owners.js 2026-08-06       — за конкретную дату
//
// Можно прерывать (Ctrl+C) — прогресс не сохраняется между запусками
// (в отличие от resend-backlog.js), но повторный прогон безвреден:
// уже помеченные agent просто не попадут в выборку повторно.

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  realtime: { transport: WebSocket },
});

function dayRangeTashkent(dateArg) {
  const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
  let dayStartUtc;
  if (dateArg) {
    dayStartUtc = new Date(`${dateArg}T00:00:00+05:00`);
  } else {
    const nowTashkent = new Date(Date.now() + TASHKENT_OFFSET_MS);
    const todayTashkent = new Date(
      Date.UTC(nowTashkent.getUTCFullYear(), nowTashkent.getUTCMonth(), nowTashkent.getUTCDate())
    );
    dayStartUtc = new Date(todayTashkent.getTime() - TASHKENT_OFFSET_MS);
  }
  const dayEndUtc = new Date(dayStartUtc.getTime() + 24 * 60 * 60 * 1000);
  return { from: dayStartUtc.toISOString(), to: dayEndUtc.toISOString() };
}

async function fetchCandidates(from, to) {
  const PAGE_SIZE = 1000;
  let all = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('listings')
      .select('id, url, title, district, property_type, deal_type, seller_listings_count, label_kind')
      .eq('source', 'olx')
      .neq('label_kind', 'agent') // уже помеченные агентом — не трогаем повторно
      .gte('created_at', from)
      .lt('created_at', to)
      .order('created_at', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`Supabase: ${error.message}`);
    all = all.concat(data);
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

// Прямая ссылка на конкретную ТЕМУ (не сообщение — id сообщения для
// старых записей не сохранён, см. миграцию migration_message_tracking.sql).
// Всё равно резко сужает ручной поиск: сразу открывается нужный чат
// И нужная тема, а не "куда-то из 4 супергрупп".
function buildTopicLink(chatId, messageThreadId) {
  if (!chatId) return null;
  // Приватные супергруппы: -100XXXXXXXXXX → внутренний id без "-100".
  const internalId = String(chatId).replace(/^-100/, '');
  return messageThreadId ? `https://t.me/c/${internalId}/${messageThreadId}` : `https://t.me/c/${internalId}`;
}

async function main() {
  const dateArg = process.argv[2];
  const { from, to } = dayRangeTashkent(dateArg);
  console.log(`Диапазон: ${from} → ${to}`);

  const candidates = await fetchCandidates(from, to);
  console.log(`OLX-объявлений на перепроверку: ${candidates.length}`);
  if (candidates.length === 0) {
    console.log('Нечего перепроверять.');
    return;
  }

  const reclassified = [];
  let checked = 0;
  let errors = 0;

  for (const listing of candidates) {
    checked++;
    try {
      const details = await fetchOlxDetails(listing.url, { skipPhone: true });
      if (!details?.sellerListingsUrl) {
        console.log(`[${checked}/${candidates.length}] нет ссылки на профиль продавца — пропуск: ${listing.title}`);
        continue;
      }
      const count = await fetchOlxSellerListingsCount(details.sellerListingsUrl);
      if (count !== null && count > SELLER_LISTINGS_AGENT_THRESHOLD) {
        const { error } = await supabase
          .from('listings')
          .update({
            label_kind: 'agent',
            label_text: `Агентство (перепроверено задним числом, ${count} объявл.)`,
            seller_listings_count: count,
          })
          .eq('id', listing.id);
        if (error) throw new Error(error.message);

        // Пробуем удалить сообщение автоматически — сработает только
        // для того, что отправлено ПОСЛЕ этого обновления (у старых
        // записей chat_id/message_id ещё не сохранены).
        const msgInfo = await getTelegramMessageInfo(listing.id);
        let autoDeleted = false;
        if (msgInfo?.telegram_chat_id && msgInfo?.telegram_message_id && !msgInfo.telegram_deleted) {
          autoDeleted = await deleteTelegramMessage(msgInfo.telegram_chat_id, msgInfo.telegram_message_id);
          if (autoDeleted) await markTelegramDeleted(listing.id);
        }

        let topicLink = null;
        if (!autoDeleted) {
          const groupKey = resolveGroupKey(listing);
          const groupChatId = TOPIC_GROUPS[groupKey];
          const threadId = await getTopicId(groupKey, listing.district);
          topicLink = buildTopicLink(groupChatId, threadId);
        }

        reclassified.push({ ...listing, count, autoDeleted, topicLink });
        console.log(
          `[${checked}/${candidates.length}] → АГЕНТ (${count} объявл.)${autoDeleted ? ' — сообщение удалено автоматически' : ''}: ${listing.title}`
        );
      } else {
        console.log(`[${checked}/${candidates.length}] ок, не агент (${count ?? '?'} объявл.): ${listing.title}`);
      }
    } catch (err) {
      errors++;
      console.error(`[${checked}/${candidates.length}] ошибка на "${listing.title}":`, err.message);
    }
    await new Promise((r) => setTimeout(r, 1000)); // не долбим OLX слишком часто
  }

  console.log(`\nГотово. Проверено: ${checked}. Ошибок: ${errors}. Перепомечено в агентов: ${reclassified.length}.`);
  const autoDeletedCount = reclassified.filter((l) => l.autoDeleted).length;
  const manual = reclassified.filter((l) => !l.autoDeleted);
  console.log(`Удалено автоматически: ${autoDeletedCount}. Осталось удалить вручную: ${manual.length}.`);
  if (manual.length > 0) {
    console.log(
      '\n⚠️  У этих сообщений не сохранён id (отправлены до обновления с сохранением message_id) —' +
        ' удалить автоматически нельзя. Вот прямая ссылка на нужную ТЕМУ (не само сообщение) —' +
        ' откроется сразу нужный чат и раздел, дальше ищите по названию/ссылке через 🔍 в Telegram:'
    );
    for (const l of manual) {
      console.log(`  [${l.district || 'без района'}] ${l.title}`);
      console.log(`    Объявление: ${l.url}`);
      console.log(`    Тема в Telegram: ${l.topicLink || '(не удалось определить чат/тему)'}`);
    }
  }
}

main().catch((err) => {
  console.error('Скрипт упал:', err);
  process.exit(1);
});