import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

// Прокси для запросов к olx.uz (см. диагностику 11.08.2026: 403 на
// категории "продажа" держится всю ночь при неизменных заголовках и
// с паузами между запросами — похоже на блок IP-диапазона GitHub
// Actions runner'ов на уровне WAF/антибота, а не на детект паттерна
// запросов). Заголовки/паузы такое не лечат — нужен другой IP, не из
// датацентра. Если задать переменную окружения OLX_PROXY_URL (формат
// http://user:pass@host:port, обычная резидентная/мобильная прокси),
// все запросы к OLX пойдут через неё. Если переменная не задана — код
// работает как раньше, напрямую, без изменений в поведении.
const olxProxyAgent = process.env.OLX_PROXY_URL
  ? new HttpsProxyAgent(process.env.OLX_PROXY_URL)
  : null;

/**
 * Делает GET-запрос с повторными попытками — на случай временного
 * сбоя сети или блокировки сайтом (429/503). Без этого одна неудачная
 * попытка = пропущенная проверка и потенциально упущенное объявление.
 *
 * useProxy: true — использовать OLX_PROXY_URL (если задан) для этого
 * конкретного запроса. По умолчанию false, чтобы прокси не молча не
 * применялся ко ВСЕМ запросам (например, к Uybor/Realting/Supabase),
 * если он вдруг понадобится только для OLX.
 */
export async function getWithRetry(url, options = {}, retries = 3, useProxy = false) {
  let lastError;
  const requestOptions =
    useProxy && olxProxyAgent
      ? { ...options, httpsAgent: olxProxyAgent, proxy: false }
      : options;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await axios.get(url, requestOptions);
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      console.warn(
        `Попытка ${attempt}/${retries} не удалась (${url})${status ? `, статус ${status}` : ''}: ${err.message}`
      );
      if (attempt < retries) {
        // 403 обычно значит "сайт распознал бота и временно блокирует
        // этот IP/паттерн запросов" — а не разовый сетевой сбой.
        // Долбить его снова через 2 секунды бессмысленно (скорее
        // продлит блокировку, чем поможет) — ждём заметно дольше,
        // с небольшим случайным разбросом, чтобы не быть настолько
        // предсказуемыми.
        const isBlocked = status === 403 || status === 429;
        const baseDelay = isBlocked ? attempt * 15000 : attempt * 2000; // блок: 15с,30с... / обычный сбой: 2с,4с,6с...
        const jitter = Math.floor(Math.random() * 2000);
        await new Promise((r) => setTimeout(r, baseDelay + jitter));
      }
    }
  }
  throw lastError;
}
