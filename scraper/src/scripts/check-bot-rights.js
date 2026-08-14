// Проверка реальных прав бота в чате через getChatMember.
// Запуск: node check-bot-rights.js <BOT_TOKEN> <CHAT_ID>
// Пример: node check-bot-rights.js 123456:AA... -1004439617987

const [,, token, chatId] = process.argv;
if (!token || !chatId) {
  console.error('Использование: node check-bot-rights.js <BOT_TOKEN> <CHAT_ID>');
  process.exit(1);
}

async function main() {
  const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const me = await meRes.json();
  if (!me.ok) {
    console.error('Не удалось получить getMe:', me.description);
    process.exit(1);
  }
  const botId = me.result.id;
  console.log(`Бот: @${me.result.username} (id ${botId})`);

  const res = await fetch(
    `https://api.telegram.org/bot${token}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${botId}`
  );
  const data = await res.json();
  if (!data.ok) {
    console.error('Ошибка getChatMember:', data.description);
    process.exit(1);
  }

  const m = data.result;
  console.log(`Статус бота в чате: ${m.status}`);
  if (m.status !== 'administrator') {
    console.log('❗ Бот НЕ администратор этого чата — именно поэтому удаление старых чужих/групповых сообщений падает.');
    return;
  }
  console.log('Права администратора:');
  console.log(`  can_delete_messages: ${m.can_delete_messages}`);
  console.log(`  can_manage_topics:   ${m.can_manage_topics}`);
  console.log(`  can_post_messages:   ${m.can_post_messages}`);
  console.log(`  can_pin_messages:    ${m.can_pin_messages}`);
  if (!m.can_delete_messages) {
    console.log('\n❗ Вот и причина: бот админ, но право "Удаление сообщений" (can_delete_messages) выключено.');
    console.log('   Исправление: Настройки группы → Администраторы → [твой бот] → включить "Удаление сообщений".');
  } else {
    console.log('\n✅ Право на удаление есть. Ошибка "can\'t be deleted" тогда, скорее всего, значит, что');
    console.log('   конкретные сообщения уже удалены (например, вместе с темой) — не проблема прав.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
