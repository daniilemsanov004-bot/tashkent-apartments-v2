import { requireAuth } from './_auth.js';
import { parseSearchQuery } from './_aiSearch.js';

// Этот эндпоинт НЕ ищет объявления сам — он только переводит свободный
// текст запроса в те же query-параметры, что уже понимает GET
// client/api/listings.js (district, deal, type, priceMax, priceMin,
// currency, badge, q). Вся логика поиска/фильтрации остаётся там, в
// одном месте — тут не дублируем ни query к Supabase, ни валидацию.
//
// Сам разбор текста (промпт, вызов Gemini, валидация) — в _aiSearch.js,
// используется и Telegram-ботом (см. /search в telegram-webhook.js),
// чтобы не держать два промпта, которые могут разъехаться.
//
// Ответ — просто объект параметров: фронтенд подставляет их в уже
// существующий filter state (App.jsx) и обычный useEffect сам сходит
// в listings.js, как при ручном выборе фильтров.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const email = await requireAuth(req, res);
  if (!email) return;

  const { text } = req.body || {};
  if (!text || !text.trim()) {
    res.status(400).json({ error: 'text is required' });
    return;
  }

  const result = await parseSearchQuery(text);

  if (!result.ok) {
    // Статус-коды — best-effort ориентир для сторонних клиентов этого
    // API, но НЕ единственный источник истины для нашего же фронтенда:
    // App.jsx читает reason из тела ответа напрямую (см. там) — так
    // надёжнее, чем полагаться на то, что 503 всегда означает именно
    // "unavailable", а не "rate_limited" (оба сейчас 503, но это две
    // разные, отдельно показываемые пользователю причины).
    const statusByReason = {
      unavailable: 503,
      rate_limited: 503,
      timeout_or_network: 504,
      bad_response: 502,
      unparseable: 422,
    };
    res.status(statusByReason[result.reason] || 502).json({ error: `ai_search_${result.reason}`, reason: result.reason });
    return;
  }

  res.status(200).json(result.filters);
}