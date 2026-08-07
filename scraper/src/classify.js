// ⚠️ Этот файл сейчас НЕ используется — ИИ-классификация отключена в
// scraper/src/run.js (USE_AI_CLASSIFICATION жёстко = false). Файл
// оставлен как есть на случай, если понадобится вернуть ИИ-проверку
// в будущем — просто ничего отсюда сейчас не вызывается в основном
// потоке. Собственник/агент сейчас определяется только жёсткими
// правилами (см. run.js: количество объявлений у продавца, метка
// "организация"/"риелтор" от самого сайта, метка Realting.uz).

import axios from 'axios';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `Ты помогаешь анализировать объявления о квартирах в Ташкенте.
Тебе дают текст объявления и, отдельной строкой, имя продавца (может
отсутствовать). По этим данным определи:
1) seller_type: "owner" (похоже на собственника), "agent" (похоже на риелтора/агентство) или "unknown" (непонятно).
   Признаки агента в тексте: упоминания "агентство", "комиссия", "риелтор", "показы по записи",
   слишком гладкий рекламный текст, канцелярские формулировки ("кадастр есть", "ор.р.").
   Признаки агента в ИМЕНИ продавца: название компании вместо имени человека —
   например содержит "Group", "Estate", "Real Estate", "Tower", "Avenue", "Company",
   "Agency", "Недвижимость", "риелт", или просто звучит как бренд/ЖК, а не как имя
   человека (например "Tashkent Avenue", "City Real Estate").
   Признаки собственника: разговорный тон, конкретные бытовые детали, "мой", "моя квартира",
   личный номер телефона без указания компании, обычное человеческое имя продавца.
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

export async function classifyListing(rawText, sellerName) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY не задан в .env');
  }

  const content = sellerName
    ? `Имя продавца: ${sellerName}\n\nТекст объявления:\n${rawText.slice(0, 3000)}`
    : rawText.slice(0, 3000);

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
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
  if (classification.seller_type === 'agent' && classification.confidence === 'high') {
    return { text: 'Агентство (по тексту объявления)', kind: 'agent' };
  }
  return { text: 'Сомнительно — проверьте сами', kind: 'uncertain' };
}

/**
 * Жёсткое правило, отдельное от ИИ: если у продавца много других
 * объявлений о недвижимости — это почти наверняка агентство, даже
 * если сам текст звучит по-человечески. Работает независимо от того,
 * включена ли ИИ-классификация — не требует API-ключа и денег.
 */
export const SELLER_LISTINGS_AGENT_THRESHOLD = 2; // больше 2 объявлений у продавца = агент
