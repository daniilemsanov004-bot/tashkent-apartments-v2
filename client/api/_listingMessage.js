// Собирает текст и кнопки карточки объявления для Telegram — версия
// для webhook (Vercel), используется, чтобы ПЕРЕСОБРАТЬ сообщение
// заново после нажатия кнопки "Связался"/"Беру в работу" (редактируем
// существующее сообщение целиком, а не просто дописываем строку —
// так не бывает дублей, если нажать кнопку несколько раз).
//
// ВАЖНО: это копия логики форматирования из scraper/src/telegram.js
// (та используется при ПЕРВОЙ отправке объявления из GitHub Actions).
// client/ и scraper/ — разные deployable-проекты без общего
// import-пути (см. также _districts.js, _priceParser.js) — если
// меняете формат сообщения в одном месте, проверьте и второе.

function badgeText(listing) {
<<<<<<< HEAD
  if (listing.flagged_agent) return `🏢 Отмечено агентом как агентство (${listing.flagged_by || '—'})`;
=======
>>>>>>> a8eaa5b875f521546dcdd801445f7f0dbe1ecab0
  if (listing.label_kind === 'owner') return '✅ Собственник';
  if (listing.label_kind === 'unchecked') return `🙂 ${listing.label_text || 'Собственник'}`;
  if (listing.label_kind === 'agent') return `🏢 ${listing.label_text || 'Похоже на агентство'}`;
  return '❓ Сомнительно — проверьте сами';
}

export function buildListingText(listing) {
  const roomsLine = listing.rooms ? `${listing.rooms}-комн. ` : '';
  const areaLine = listing.area ? `, ${listing.area} м²` : '';
  const districtLine = listing.district ? `📍 ${listing.district}\n` : '';
  const phoneLine = listing.phone ? `📞 ${listing.phone}\n` : '';
  const dealLine = listing.deal_type === 'sale' ? '🏷️ Продажа\n' : listing.deal_type === 'rent' ? '🔑 Аренда\n' : '';
  const typeLine =
    listing.property_type === 'house' ? '🏡 Дом\n' : listing.property_type === 'commercial' ? '🏢 Коммерция\n' : '';

  let statusBlock = '';
  if (listing.assigned_to) statusBlock += `\n👤 Взял в работу: ${listing.assigned_to}`;
  if (listing.contacted) statusBlock += `\n✅ Связался: ${listing.contacted_by || '—'}`;
<<<<<<< HEAD
  if (listing.notes) statusBlock += `\n📝 Заметка: ${listing.notes}`;
=======
>>>>>>> a8eaa5b875f521546dcdd801445f7f0dbe1ecab0

  return (
    `🏠 Новое объявление (${listing.source})\n` +
    `${badgeText(listing)}\n\n` +
    dealLine +
    typeLine +
    `${roomsLine}${listing.title}${areaLine}\n` +
    `💰 ${listing.price || 'цена не указана'}\n` +
    districtLine +
    phoneLine +
    `\n${listing.url}` +
    statusBlock
  );
}

export function buildListingButtons(listing) {
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
  buttons.push([
    { text: listing.contacted ? '↩️ Снять «Связался»' : '✅ Связался', callback_data: `ct:${listing.id}` },
    { text: listing.assigned_to ? '↩️ Освободить' : '👤 Беру в работу', callback_data: `as:${listing.id}` },
  ]);
<<<<<<< HEAD
  buttons.push([
    { text: listing.flagged_agent ? '↩️ Вернуть как собственника' : '🚫 Это агент', callback_data: `fl:${listing.id}` },
    { text: '📝 Заметка', callback_data: `nt:${listing.id}` },
  ]);
=======
>>>>>>> a8eaa5b875f521546dcdd801445f7f0dbe1ecab0
  return buttons;
}
