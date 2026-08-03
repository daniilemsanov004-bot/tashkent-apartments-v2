import axios from 'axios';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `Ты помогаешь анализировать объявления о квартирах в Ташкенте.
По тексту объявления определи:
1) seller_type: "owner" (похоже на собственника), "agent" (похоже на риелтора/агентство) или "unknown" (непонятно).
   Признаки агента: упоминания "агентство", "комиссия", "риелтор", "показы по записи",
   слишком гладкий рекламный текст, несколько похожих объявлений в одном стиле.
   Признаки собственника: разговорный тон, конкретные бытовые детали, "мой", "моя квартира",
   личный номер телефона без указания компании.
   Если сомневаешься — ставь "unknown", а не угадывай.
2) confidence: "high" | "medium" | "low" — насколько ты уверен в seller_type.
3) district: район города, если упомянут
4) rooms: количество комнат (число или null)
5) area: площадь в м², если указана (число или null)
6) phone: номер телефона, если продавец указал его прямо в тексте объявления
   (в формате как в тексте, например "+998 90 123 45 67"), иначе null.
   Не выдумывай номер — только если он реально есть в тексте.

Отвечай СТРОГО в формате JSON, без пояснений и без markdown-разметки:
{"seller_type": "...", "confidence": "...", "district": "...", "rooms": ..., "area": ..., "phone": ...}`;

export async function classifyListing(rawText) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY не задан в .env');
  }

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: rawText.slice(0, 3000) }],
    },
    {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 20000,
    }
  );

  const text = response.data.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim();

  const cleaned = text.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('Не удалось распарсить ответ модели:', text);
    return {
      seller_type: 'unknown',
      confidence: 'low',
      district: null,
      rooms: null,
      area: null,
      phone: null,
    };
  }
}

/**
 * Решает, стоит ли отправлять объявление в уведомления.
 * Приоритет — не упустить ничего: пропускаем ТОЛЬКО те объявления,
 * где модель уверенно (high) распознала агента. Всё остальное —
 * включая "unknown" и агентов с низкой/средней уверенностью —
 * отправляем, но помечаем как сомнительные.
 */
export function shouldNotify(classification) {
  const isConfidentAgent =
    classification.seller_type === 'agent' && classification.confidence === 'high';
  return !isConfidentAgent;
}

/**
 * Метка для уведомления — чтобы сразу было видно, доверять объявлению
 * или проверять самостоятельно.
 */
export function labelFor(classification) {
  if (classification.seller_type === 'owner' && classification.confidence === 'high') {
    return { text: 'Собственник', kind: 'owner' };
  }
  return { text: 'Сомнительно — проверьте сами', kind: 'uncertain' };
}
