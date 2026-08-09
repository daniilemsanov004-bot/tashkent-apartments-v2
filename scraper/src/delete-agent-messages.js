import 'dotenv/config';
import { cleanAgentBacklog } from './cleanAgentMessages.js';

// Разовый ручной запуск "почистить весь накопившийся мусор от риэлторов".
// Сама логика теперь в cleanAgentMessages.js — эта же функция вызывается
// автоматически в конце каждого прогона scraper/src/run.js (значит,
// раз в 15 минут через cron-job.org), так что запускать этот файл
// руками нужно в основном для больших разовых чисток (например, сразу
// после backfill-from-telegram-export.js) или если хочется посмотреть
// подробный вывод.
//
// ВАЖНО — прочитать перед запуском:
//  1. Нужна выполненная supabase/migration_message_tracking.sql — без
//     неё telegram_chat_id/telegram_message_id нигде не сохраняются и
//     удалять просто нечего.
//  2. Сообщения, отправленные ДО того, как эта миграция появилась, не
//     имеют сохранённого id — этот скрипт их найти не может (Telegram
//     Bot API не даёт искать историю чата по содержимому). Для них
//     нужен отдельный backfill-from-telegram-export.js (по экспорту
//     истории из Telegram Desktop) или удаление вручную в самом
//     Telegram.
//  3. Некоторые сообщения (обычно самые старые в чате, ещё до
//     превращения группы в супергруппу/включения тем) Telegram не даёт
//     удалить вообще, даже админу с правом "удалять сообщения" — это
//     ограничение самого Telegram, не баг здесь. Такие тоже попадут в
//     список "вручную" ниже.
//
// Запуск:
//   cd scraper
//   node src/delete-agent-messages.js

function buildTopicLink(chatId, messageThreadId) {
  if (!chatId) return null;
  const internalId = String(chatId).replace(/^-100/, '');
  return messageThreadId ? `https://t.me/c/${internalId}/${messageThreadId}` : `https://t.me/c/${internalId}`;
}

async function main() {
  console.log('Ищу агентские объявления с сохранённым id сообщения...');
  const { totalCandidates, deleted, failed, manualWithId, withoutIdCount } = await cleanAgentBacklog();

  console.log(`Объявлений-агентов, ещё не отмеченных как удалённые: ${totalCandidates}`);
  console.log(`\nГотово. Удалено автоматически: ${deleted}. Не получилось автоматически: ${failed}.`);

  if (manualWithId.length > 0) {
    console.log(`\nID был, но удалить не получилось (${manualWithId.length}) — сообщение либо старше 48ч/старше миграции чата, либо бот без прав:`);
    for (const listing of manualWithId) {
      console.log(`  - ${listing.title}\n    объявление: ${listing.url}`);
    }
  }

  if (withoutIdCount > 0) {
    console.log(
      `\n${withoutIdCount} объявлений отправлены ДО того, как заработало сохранение id — автоматически их найти ` +
        `и удалить нечем (Telegram Bot API не даёт искать историю чата по содержимому). Варианты:\n` +
        `  1) node src/backfill-from-telegram-export.js <путь до result.json> — сопоставит их по экспорту истории чата\n` +
        `  2) Вручную очистить историю темы/супергруппы в самом Telegram, если старые объявления больше не нужны\n` +
        `  3) Жить с тем, что старый мусор останется, а новые сообщения будут чиститься сами`
    );
  }
}

main().catch((err) => {
  console.error('Критическая ошибка:', err);
  process.exit(1);
});
