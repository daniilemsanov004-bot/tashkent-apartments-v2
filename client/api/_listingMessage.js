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
  if (listing.flagged_agent) return `🏢 Отмечено агентом как агентство (${listing.flagged_by || '—'})`;
  if (listing.label_kind === 'owner') return '✅ Собственник';
  if (listing.label_kind === 'unchecked') return `🙂 ${listing.label_text || 'Собственник'}`;
  if (listing.label_kind === 'agent') return `🏢 ${listing.label_text || 'Похоже на агентство'}`;
  return '❓ Сомнительно — проверьте сами';
}

function dealScoreBlock(listing) {
  if (!listing?.deal_candidate && !(listing?.deal_score >= 70)) return '';

  const tier =
    listing.deal_score >= 90
      ? '🔥 очень выгодное'
      : listing.deal_score >= 80
        ? '⚡ выгодное'
        : listing.deal_score >= 70
          ? '💡 потенциально выгодное'
          : null;
  const marketLine =
    listing.below_market_pct != null
      ? `Цена ниже рынка: ${Math.max(0, Number(listing.below_market_pct)).toFixed(1).replace(/\.0$/, '')}%\n`
      : 'Цена ниже рынка: данных мало\n';
  const ownerLine =
    listing.owner_score != null ? `Owner Score: ${Math.round(Number(listing.owner_score))}/100\n` : '';
  const historyLine =
    listing.price_history_count > 1
      ? `Цена снижалась: ${Math.max(0, Number(listing.price_drop_count) || 0)} раз\n`
      : '';
  const lastDropLine =
    listing.last_price_change_pct != null
      ? `Последнее изменение: ${Number(listing.last_price_change_pct).toFixed(1).replace(/\.0$/, '')}%\n`
      : '';
  const urgencyLine = listing.urgency_signal ? `Срочность: ${listing.urgency_phrase || 'есть сигнал'}\n` : '';

  return (
    `💎 Deal Score: ${Math.round(Number(listing.deal_score) || 0)}/100${tier ? ` · ${tier}` : ''}\n` +
    marketLine +
    ownerLine +
    historyLine +
    lastDropLine +
    urgencyLine +
    '\n'
  );
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
  if (listing.notes) statusBlock += `\n📝 Заметка: ${listing.notes}`;

  return (
    `🏠 Новое объявление (${listing.source})\n` +
    `${badgeText(listing)}\n\n` +
    dealScoreBlock(listing) +
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
    // Кнопку "Позвонить" через url: 'tel:...' убрали — в Bot API
    // официально поддерживаются только http(s):// и tg:// (см. доки
    // InlineKeyboardButton), 'tel:' работает "на птичьих правах" и
    // иногда Telegram отвечает 400 Bad Request ("Wrong port number
    // specified in the URL") на конкретных номерах, роняя отправку
    // всего сообщения целиком. Номер телефона у нас и так есть текстом
    // в сообщении (phoneLine выше) — Telegram сам подсвечивает номера
    // кликабельными в тексте, кнопка для этого не нужна.
    buttons.push([{ text: '💬 Написать в WhatsApp', url: `https://wa.me/${digits}` }]);
  }
  buttons.push([{ text: '🔗 Открыть объявление', url: listing.url }]);
  buttons.push([
    { text: listing.contacted ? '↩️ Снять «Связался»' : '✅ Связался', callback_data: `ct:${listing.id}` },
    { text: listing.assigned_to ? '↩️ Освободить' : '👤 Беру в работу', callback_data: `as:${listing.id}` },
  ]);
  buttons.push([
    { text: listing.flagged_agent ? '↩️ Вернуть как собственника' : '🚫 Это агент', callback_data: `fl:${listing.id}` },
    { text: '📝 Заметка', callback_data: `nt:${listing.id}` },
  ]);
  return buttons;
}
