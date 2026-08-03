import axios from 'axios';

/**
 * Делает GET-запрос с повторными попытками — на случай временного
 * сбоя сети или блокировки сайтом (429/503). Без этого одна неудачная
 * попытка = пропущенная проверка и потенциально упущенное объявление.
 */
export async function getWithRetry(url, options = {}, retries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await axios.get(url, options);
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      console.warn(
        `Попытка ${attempt}/${retries} не удалась (${url})${status ? `, статус ${status}` : ''}: ${err.message}`
      );
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, attempt * 2000)); // 2с, 4с, 6с...
      }
    }
  }
  throw lastError;
}
