// Разбирает уже готовую текстовую цену объявления (как её вернул
// скрапер, например "800 315 000 сум", "45 000 $", "500 у.е.") в
// число + валюту — нужно, чтобы фильтр по цене в Telegram-боте мог
// сравнивать цены между собой, а не просто хранить их как текст.
//
// ВАЖНО: копия этой логики есть в client/api/_priceParser.js (парсит
// произвольный ввод пользователя вида "300-800 млн", а не готовую
// строку цены объявления) — они решают разные задачи, но используют
// одну и ту же логику определения валюты. Если меняете эвристику
// определения валюты — проверьте оба файла.

const USD_MARKERS = /\$|у\.?\s?е\.?|\busd\b/i;
const UZS_MARKERS = /сум|so'?m|\buzs\b/i;

/**
 * @param {string} rawPrice текст цены, как есть у скрапера
 * @returns {{ value: number|null, currency: 'USD'|'UZS'|null }}
 */
export function parsePrice(rawPrice) {
  if (!rawPrice) return { value: null, currency: null };

  const text = String(rawPrice);
  const digits = text.match(/\d+/g);
  if (!digits || digits.length === 0) return { value: null, currency: null };

  const value = Number(digits.join(''));
  if (!Number.isFinite(value) || value <= 0) return { value: null, currency: null };

  let currency = null;
  if (USD_MARKERS.test(text)) currency = 'USD';
  else if (UZS_MARKERS.test(text)) currency = 'UZS';
  else {
    // Валюта не указана явно (редко, но бывает) — определяем по
    // порядку величины: суммы в сумах на рынке Ташкента почти всегда
    // 6+ значные (сотни млн/млрд), суммы в у.е./$ — обычно до 6 знаков.
    // Эвристика приблизительная, работает как fallback.
    currency = value < 100000 ? 'USD' : 'UZS';
  }

  return { value, currency };
}

/**
 * Переводит цену в сумы для сравнения "яблок с яблоками" при фильтрации.
 * Курс — ПРИБЛИЗИТЕЛЬНЫЙ, задаётся через .env (EXCHANGE_RATE_USD_UZS),
 * т.к. у скрапера нет доступа к живому курсу ЦБ. Стоит время от
 * времени сверять с реальным курсом и обновлять .env.
 */
export function toUzs({ value, currency }, exchangeRateUsdUzs) {
  if (value === null) return null;
  if (currency === 'USD') return value * exchangeRateUsdUzs;
  return value;
}
