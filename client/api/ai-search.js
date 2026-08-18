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
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 25000;

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
          // temperature/top_p/top_k официально задепрекейчены для
          // gemini-3.6-flash/3.7-flash (см. миграционную памятку Google,
          // обновлена 13.08.2026) — раньше тут был temperature:0, но раз
          // модель его больше не поддерживает, убрал совсем, вместо того
          // чтобы гадать, ломает это запрос целиком или тихо игнорируется.
          //
          // thinkingConfig.thinkingLevel: "low" — по умолчанию у этих
          // моделей medium (модель "размышляет" перед ответом), что для
          // задачи "разложить короткую фразу по 8 полям" явно избыточно
          // и добавляет секунды задержки без пользы для качества. low
          // снижает время ответа для latency-критичных задач именно
          // такого рода (см. документацию Gemini 3.7 Flash) — это и
          // была вероятная причина таймаута, а не сеть/лимиты сами по
          // себе.
          generationConfig: {
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingLevel: 'low' },
          },
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      }
    );

    if (!geminiRes.ok) {
      // Печатаем ПОЛНОЕ тело ответа Gemini, а не только статус — иначе
      // в логах Vercel не видно, ЧТО именно не понравилось API
      // (неверный формат параметров, лимит бесплатного тира, неверный
      // ключ и т.п. выглядят как одна и та же 502-ошибка для
      // пользователя на сайте, но текст сильно разный).
      const errBody = await geminiRes.text().catch(() => '');
      console.warn(`ai-search: Gemini ответил ${geminiRes.status}: ${errBody.slice(0, 500)}`);
      res.status(502).json({ error: 'ai_search_failed' });
      return;
    }

    const data = await geminiRes.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) {
      console.warn('ai-search: пустой ответ от Gemini, полный data:', JSON.stringify(data).slice(0, 500));
      res.status(502).json({ error: 'empty_ai_response' });
      return;
    }

    const cleaned = raw.replace(/^```json\s*|```$/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      // Отдельный catch именно на JSON.parse — чтобы в логе было видно,
      // что запрос к Gemini прошёл успешно, но сам текст ответа не JSON
      // (например, модель всё-таки что-то дописала словами вокруг) —
      // это другая причина сбоя, чем ошибка сети/лимита выше.
      console.warn(`ai-search: ответ Gemini не распарсился как JSON: ${cleaned.slice(0, 300)}`);
      res.status(502).json({ error: 'unparseable_ai_response' });
      return;
    }

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