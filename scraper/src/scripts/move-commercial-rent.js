import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { deleteTelegramMessage, notifyToTopicGroup, TOPIC_GROUPS } from '../telegram.js';
import { markNotified } from '../db.js';

// Разовый скрипт: раньше "Коммерция + Аренда" уходила в ту же
// супергруппу, что и "Коммерция + Продажа" (отдельного чата для
// аренды коммерции не было — см. resolveGroupKey в telegram.js до
// добавления commercial_rent). Теперь, когда TELEGRAM_GROUP_COMMERCIAL_RENT
// настроена, этот скрипт:
//   1. Находит в базе все объявления property_type=commercial +
//      deal_type=rent, у которых сохранён telegram_chat_id/message_id
//      (т.е. реально были отправлены) и они ещё не удалены.
//   2. Удаляет старое сообщение из чата "Коммерция" (Bot API не умеет
//      "переносить" сообщения между чатами — только удалить в одном
//      и создать новое в другом).
//   3. Отправляет заново через notifyToTopicGroup — она сама подберёт
//      правильный чат по resolveGroupKey (для commercial+rent это
//      теперь TELEGRAM_GROUP_COMMERCIAL_RENT).
//   4. Сохраняет новый chat_id/message_id и сбрасывает telegram_deleted
//      обратно в false (это НЕ "объявление удалено навсегда", а
//      "старое сообщение удалено, потому что уехало в другой чат").
//
// ВАЖНО — прочитать перед запуском:
//  1. TELEGRAM_GROUP_COMMERCIAL_RENT должна быть уже настроена в .env
//     (и в самой группе включены "Темы" + добавлен бот-админ) — иначе
//     resolveGroupKey просто отправит объявление обратно в ту же
//     группу "Коммерция", и весь смысл переноса потеряется. Скрипт
//     сам проверяет это перед стартом и останавливается, если группа
//     не настроена.
//  2. Объявления БЕЗ сохранённого telegram_chat_id/telegram_message_id
//     (отправленные до того, как это стало сохраняться в базу) скрипт
//     найти и перенести не может — Telegram Bot API не даёт искать
//     историю чата по содержимому. Такие останутся висеть в старом
//     чате "Коммерция" — почистить их можно только вручную в самом
//     Telegram (или через backfill-from-telegram-export.js, если есть
//     экспорт истории чата).
//  3. Некоторые совсем старые сообщения Telegram не даёт удалить вообще
//     (ограничение самого Bot API, не баг этого скрипта) — такие
//     попадут в список "не получилось удалить" в конце.
//
// Запуск:
//   cd scraper
//   node src/move-commercial-rent.js            — переносит по-настоящему
//   node src/move-commercial-rent.js --dry-run   — только считает и
//                                                   показывает, ничего
//                                                   не трогая в Telegram

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  realtime: { transport: WebSocket },
});

const DRY_RUN = process.argv.includes('--dry-run');

async function fetchCommercialRentBacklog() {
  const PAGE_SIZE = 1000;
  let all = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('listings')
      .select('*')
      .eq('property_type', 'commercial')
      .eq('deal_type', 'rent')
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

async function main() {
  if (!TOPIC_GROUPS.commercial_rent) {
    console.error(
      '❌ TELEGRAM_GROUP_COMMERCIAL_RENT не задана в .env — переносить некуда.\n' +
        '   Сначала создайте супергруппу, добавьте бота админом, впишите её chat_id\n' +
        '   в .env как TELEGRAM_GROUP_COMMERCIAL_RENT, запустите node src/setup-topics.js,\n' +
        '   и только потом запускайте этот скрипт.'
    );
    process.exit(1);
  }

  console.log('Ищу объявления "Коммерция + Аренда" в базе...');
  const backlog = await fetchCommercialRentBacklog();

  const withId = backlog.filter((l) => l.telegram_chat_id && l.telegram_message_id);
  const withoutId = backlog.filter((l) => !(l.telegram_chat_id && l.telegram_message_id));

  console.log(`Всего найдено: ${backlog.length}`);
  console.log(`  - с сохранённым id сообщения (можно перенести автоматически): ${withId.length}`);
  console.log(`  - без сохранённого id (перенести нечем, см. комментарий в шапке файла): ${withoutId.length}`);

  if (withId.length === 0) {
    console.log('\nНечего переносить.');
    return;
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: ничего не отправляю и не удаляю, просто список того, что было бы перенесено:');
    for (const listing of withId) {
      console.log(`  - ${listing.title} (${listing.district || 'без района'}) — chat=${listing.telegram_chat_id} msg=${listing.telegram_message_id}`);
    }
    return;
  }

  console.log(`\nПереношу ${withId.length} объявлений из "Коммерция" в "Коммерция (аренда)"...`);

  let moved = 0;
  let deleteFailed = 0;
  let sendFailed = 0;
  const deleteFailedList = [];
  const sendFailedList = [];

  for (const listing of withId) {
    // Сначала удаляем старое сообщение из чата "Коммерция". Если
    // удалить не получилось (например, сообщение старше 48ч или бот
    // потерял права) — всё равно отправляем в новый чат, чтобы
    // объявление хотя бы появилось там, где нужно; старое просто
    // останется висеть в "Коммерции" на память, почистить его тогда
    // придётся вручную.
    const deletedOk = await deleteTelegramMessage(listing.telegram_chat_id, listing.telegram_message_id);
    if (!deletedOk) {
      deleteFailed++;
      deleteFailedList.push(listing);
    }
    await new Promise((r) => setTimeout(r, 400));

    try {
      const sent = await notifyToTopicGroup(listing);
      if (!sent) {
        // notifyToTopicGroup сама молчит (return null), если группа не
        // настроена или бот не смог отправить — тут это уже не должно
        // случиться (проверили TOPIC_GROUPS.commercial_rent выше), но
        // на всякий случай считаем как ошибку отправки.
        throw new Error('notifyToTopicGroup вернула null');
      }
      await markNotified(listing.id, { chatId: sent.chatId, messageId: sent.messageId });
      // markNotified не трогает telegram_deleted — сбрасываем отдельно,
      // т.к. в базе у объявления мог остаться true с прошлых попыток.
      await supabase.from('listings').update({ telegram_deleted: false }).eq('id', listing.id);
      moved++;
      console.log(`✅ [${moved}/${withId.length}] ${listing.title} (${listing.district || 'без района'}) — перенесено`);
    } catch (err) {
      sendFailed++;
      sendFailedList.push(listing);
      console.error(`❌ Не удалось отправить в новый чат "${listing.title}" (${listing.id}):`, err.message);
    }

    await new Promise((r) => setTimeout(r, 1200)); // тот же лимит, что и в resend-backlog.js / run.js
  }

  console.log(`\nГотово. Перенесено: ${moved}.`);
  if (deleteFailed > 0) {
    console.log(
      `\n⚠️  Не удалось удалить старое сообщение из "Коммерции" у ${deleteFailed} объявлений (новое сообщение при этом ` +
        `всё равно отправлено в "Коммерция (аренда)") — старые придётся почистить в Telegram вручную:`
    );
    for (const listing of deleteFailedList) {
      console.log(`  - ${listing.title}\n    ${listing.url}`);
    }
  }
  if (sendFailed > 0) {
    console.log(`\n❌ Не удалось отправить в новый чат ${sendFailed} объявлений — попробуйте запустить скрипт ещё раз, он их подхватит снова:`);
    for (const listing of sendFailedList) {
      console.log(`  - ${listing.title}\n    ${listing.url}`);
    }
  }
  if (withoutId.length > 0) {
    console.log(
      `\nℹ️  ${withoutId.length} объявлений "Коммерция + Аренда" были отправлены до того, как заработало сохранение id, ` +
        `и остались висеть в старом чате "Коммерция" — автоматически их найти нечем (см. комментарий в шапке файла).`
    );
  }
}

main().catch((err) => {
  console.error('Скрипт упал:', err);
  process.exit(1);
});
