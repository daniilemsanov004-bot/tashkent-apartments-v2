// Общая логика приоритета для сайта и Telegram-бота: собственники
// показываются первыми, дальше непроверенные/сомнительные, агентства —
// в самом конце (но НЕ скрываются — просто ниже по списку).

const RANK = {
  owner: 0,
  unchecked: 1,
  uncertain: 2,
  agent: 3,
};

export function priorityRank(listing) {
  return RANK[listing.label_kind] ?? 1;
}

/**
 * Сортирует по приоритету (собственники сверху), при равном приоритете —
 * по дате (новые сверху). Не мутирует исходный массив.
 */
export function sortByPriority(listings) {
  return [...listings].sort((a, b) => {
    const rankDiff = priorityRank(a) - priorityRank(b);
    if (rankDiff !== 0) return rankDiff;
    return new Date(b.created_at) - new Date(a.created_at);
  });
}
