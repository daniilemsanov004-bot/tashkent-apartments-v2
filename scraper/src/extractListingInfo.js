// ИИ-извлечение полей объявления — заменяет regex из listingDetails.js
// там, где регекс путается (площадь дома vs площадь участка, ремонт,
// юр.риски и т.п.). Использует единый AIProvider-chain:
// Gemini → Groq → Cerebras → OpenRouter, если включён AI_FALLBACK_ENABLED.
//
// Если все провайдеры недоступны или ответ не распарсился как JSON,
// функция не падает, а откатывается на старый regex-парсер
// (parseArea/parseRooms) и возвращает partial=true, чтобы это было
// видно в логах — скрапер не должен ломать весь прогон из-за
// нестабильности внешнего API.

import { parseArea, parseRooms } from './listingDetails.js';
import { runAiJsonChain } from './aiProviders.js';
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 15000;

const SYSTEM_PROMPT = `Ты извлекаешь структурированные данные из текста объявления о недвижимости в Ташкенте.

Отвечай СТРОГО валидным JSON без markdown-разметки и без пояснений, вот таким объектом:
{
  "area_living": число или null,   // жилая площадь в м², если явно указана
  "area_total": число или null,    // общая/площадь постройки в м² (для домов часто отличается от жилой)
  "area_land_sotka": число или null, // площадь участка в сотках (только для домов/участков)
  "rooms": число или null,
  "floor": число или null,
  "floor_total": число или null,   // этажность дома
  "condition": одно из "черновая" | "косметика" | "евроремонт" | "дизайнерский" | null,
  "market_segment": одно из "new_build" | "secondary" | null,
  "legal_risk": строка кратко (например "продажа по доверенности") или null
}

Правила:
- Если в тексте несколько чисел с "кв.м" — определи по контексту, какое из них area_living,
  а какое area_total (например "дом 180 кв.м, жилая 120 кв.м" -> area_total=180, area_living=120).
  Если в тексте только одно число площади без уточнения — запиши его в area_living.
- area_land_sotka заполняй ТОЛЬКО для домов/участков, для квартир всегда null.
- Не выдумывай значения — если не уверен, ставь null.`;

/**
 * @param {string|null|undefined} rawText
 * @returns {Promise<{area_living:number|null, area_total:number|null, area_land_sotka:number|null,
 *   rooms:number|null, floor:number|null, floor_total:number|null, condition:string|null,
 *   market_segment:string|null, legal_risk:string|null, partial:boolean, source:'llm'|'regex_fallback'}>}
 */
export async function extractListingInfo(rawText) {
  const regexFallback = () => ({
    area_living: parseArea(rawText),
    area_total: null,
    area_land_sotka: null,
    rooms: parseRooms(rawText),
    floor: null,
    floor_total: null,
    condition: null,
    market_segment: null,
    legal_risk: null,
    partial: true,
    source: 'regex_fallback',
  });

  if (!rawText) {
    return regexFallback();
  }

  // Общий парсинг ответа модели в наш формат — переиспользуется обоими
  // способами подключения ниже, чтобы не дублировать валидацию полей.
  function parseModelJson(text) {
    const cleaned = text.replace(/^```json\s*|```$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      area_living: Number.isFinite(parsed.area_living) ? parsed.area_living : null,
      area_total: Number.isFinite(parsed.area_total) ? parsed.area_total : null,
      area_land_sotka: Number.isFinite(parsed.area_land_sotka) ? parsed.area_land_sotka : null,
      rooms: Number.isFinite(parsed.rooms) ? parsed.rooms : null,
      floor: Number.isFinite(parsed.floor) ? parsed.floor : null,
      floor_total: Number.isFinite(parsed.floor_total) ? parsed.floor_total : null,
      condition: parsed.condition ?? null,
      market_segment: parsed.market_segment ?? null,
      legal_risk: parsed.legal_risk ?? null,
      partial: false,
    };
  }

  try {
    const result = await runAiJsonChain({
      taskName: 'extractListingInfo',
      systemPrompt: SYSTEM_PROMPT,
      userText: rawText.slice(0, 3000),
      timeoutMs: LLM_TIMEOUT_MS,
      maxTokens: 300,
    });

    if (!result.ok) {
      console.warn(`extractListingInfo: AI chain exhausted (${result.reason}), откат на regex`);
      return regexFallback();
    }

    return { ...parseModelJson(JSON.stringify(result.data)), source: `llm_${result.provider}` };
  } catch (err) {
    console.warn(`extractListingInfo: ошибка AI chain (${err.message}), откат на regex`);
    return regexFallback();
  }
}
