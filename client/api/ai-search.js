import { requireAuth } from './_auth.js';
import { DISTRICTS } from '../src/districts.js';

// Этот эндпоинт НЕ ищет объявления сам — он только переводит свободный
// текст запроса в те же query-параметры, что уже понимает GET
// client/api/listings.js (district, deal, type, priceMax, priceMin,
// currency, badge, q). Вся логика поиска/фильтрации остаётся там, в
// одном месте — тут не дублируем ни query к Supabase, ни валидацию.
//
// Ответ — просто объект параметров: фронтенд подставляет их в уже
// существующий filter state (App.jsx) и обычный useEffect сам сходит
// в listings.js, как при ручном выборе фильтров.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 15000;

// Список районов передаём в промпт как закрытый enum — модель обязана
// вернуть район ТОЛЬКО из этого списка или null. Это и есть главная
// защита от "выдуманной инфы": она не может подставить район, которого
// нет в списке, даже если пользователь написал что-то похожее, но не
// совпадающее (например "Юнус" вместо "Юнусабадский") — в таком случае
// либо явно попросим уточнить, либо (проще и безопаснее) модель сама
// сопоставляет только явные, недвусмысленные варианты написания одного
// и того же района (алиасы/опечатки), а не разные районы.
const SYSTEM_PROMPT = `Ты переводишь свободный текст поискового запроса о недвижимости в Ташкенте в структурированные фильтры.

Отвечай СТРОГО валидным JSON без markdown-разметки и без пояснений, вот таким объектом:
{
  "district": массив строк или null,   // ТОЛЬКО из списка допустимых районов ниже
  "deal": "sale" | "rent" | null,
  "type": "apartment" | "house" | "commercial" | null,
  "priceMin": число или null,
  "priceMax": число или null,
  "currency": "USD" | "UZS" | null,
  "badge": "owner" | null,             // ставь "owner", если явно попросили "только от собственника"/"без риелторов"
  "q": строка или null                 // остаток свободного текста, который не удалось разложить по полям выше
    // (например конкретный ЖК, ориентир, пожелание по ремонту) — сохрани как есть, для текстового поиска по заголовку/описанию
}

Допустимые районы (используй ТОЛЬКО эти строки, ничего другого):
${DISTRICTS.map((d) => `"${d}"`).join(', ')}

Правила:
- Не выдумывай ничего, что не следует из текста. Если поле не упомянуто — null.
- Район подставляй, только если он явно назван (или это однозначно узнаваемое сокращение/опечатка ТОГО ЖЕ района,
  например "юнус" -> "Юнусабадский"). Если сомневаешься, между каким из двух районов выбрать — верни null, а не гадай.
- Если валюта не указана явно, но есть символ $ или слово "долларов"/"баксов" — currency="USD".
  Если "сум"/"сумов" — currency="UZS". Если денежная сумма вообще без указания валюты — currency=null (не гадай).
- "трёшка"/"3-комнатная"/"3-х комн" и т.п. НЕ являются district или type — это отдельный параметр rooms,
  которого в этой схеме нет: такие детали оставляй в поле q как есть, они попадут в текстовый поиск.
- priceMax/priceMin — только если явно назван диапазон или потолок цены ("до 80000", "от 500 в месяц").`;

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

  if (!GEMINI_API_KEY) {
    // Без ключа — честно говорим, что распознавание недоступно, а не
    // притворяемся, что что-то поняли. Фронтенд в этом случае должен
    // просто оставить как есть текст в обычном поле поиска (?q=).
    res.status(503).json({ error: 'ai_search_unavailable' });
    return;
  }

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: text.slice(0, 500) }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      }
    );

    if (!geminiRes.ok) {
      console.warn(`ai-search: Gemini ответил ${geminiRes.status}`);
      res.status(502).json({ error: 'ai_search_failed' });
      return;
    }

    const data = await geminiRes.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) {
      res.status(502).json({ error: 'empty_ai_response' });
      return;
    }

    const cleaned = raw.replace(/^```json\s*|```$/g, '').trim();
    const parsed = JSON.parse(cleaned);

    // Валидация ПОСЛЕ модели — не доверяем ей вслепую, даже с
    // responseMimeType: 'application/json'. Район ещё раз сверяем со
    // списком (если модель всё же вернула что-то не из enum —
    // отбрасываем именно этот район, а не всю выдачу).
    const district = Array.isArray(parsed.district)
      ? parsed.district.filter((d) => DISTRICTS.includes(d))
      : [];

    const result = {
      district,
      deal: parsed.deal === 'sale' || parsed.deal === 'rent' ? parsed.deal : null,
      type: ['apartment', 'house', 'commercial'].includes(parsed.type) ? parsed.type : null,
      priceMin: Number.isFinite(parsed.priceMin) ? parsed.priceMin : null,
      priceMax: Number.isFinite(parsed.priceMax) ? parsed.priceMax : null,
      currency: parsed.currency === 'USD' || parsed.currency === 'UZS' ? parsed.currency : null,
      badge: parsed.badge === 'owner' ? 'owner' : null,
      q: typeof parsed.q === 'string' ? parsed.q.slice(0, 200) : null,
    };

    res.status(200).json(result);
  } catch (err) {
    console.warn(`ai-search: ошибка Gemini (${err.message})`);
    res.status(502).json({ error: 'ai_search_failed' });
  }
}
