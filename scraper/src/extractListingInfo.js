// ИИ-извлечение полей объявления — заменяет regex из listingDetails.js
// там, где регекс путается (площадь дома vs площадь участка, ремонт,
// юр.риски и т.п.). Поддерживает ДВА способа подключения:
//
// СПОСОБ 1 — Google Gemini напрямую (рекомендуется, официальный
// бесплатный тир с документированными лимитами, без посредников):
//   GEMINI_API_KEY — ключ с https://aistudio.google.com/apikey
//   GEMINI_MODEL — например "gemini-3.6-flash" (необязательно,
//     по умолчанию используется именно эта модель)
//
// СПОСОБ 2 — любой OpenAI-совместимый роутер (OrcaRouter, TokenRouter
// и т.п.) — оставлен как запасной вариант, но на практике у бесплатных
// тарифов таких роутеров лимиты непрозрачны (см. обсуждение в чате —
// 429 без деталей в логах роутера):
//   LLM_API_BASE_URL, LLM_API_KEY, LLM_MODEL
//
// Если задан GEMINI_API_KEY — используется способ 1 (приоритет).
// Иначе, если задан LLM_API_BASE_URL — способ 2.
// Если не задано ничего — тихий откат на regex.
//
// В любом случае: если запрос падает/висит/отвечает не-JSON'ом,
// extractListingInfo() откатывается на старый regex-парсер
// (parseArea/parseRooms) и возвращает partial=true, чтобы это было
// видно в логах — скрапер не должен падать из-за нестабильности
// внешнего API.

import axios from 'axios';
import { parseArea, parseRooms } from './listingDetails.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// "-latest" — плавающий алиас от Google, всегда указывает на текущую
// актуальную Flash-модель, не привязан к конкретной версии (2.5, 3.5
// и т.п.) — так что не протухнет, когда Google выпустит следующую.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

const LLM_API_BASE_URL = process.env.LLM_API_BASE_URL;
const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_MODEL = process.env.LLM_MODEL;
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

  // СПОСОБ 1 — Gemini напрямую, приоритетный вариант.
  if (GEMINI_API_KEY) {
    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: rawText.slice(0, 3000) }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        },
        {
          headers: { 'content-type': 'application/json' },
          params: { key: GEMINI_API_KEY },
          timeout: LLM_TIMEOUT_MS,
        }
      );

      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        console.warn('extractListingInfo: пустой ответ от Gemini, откат на regex');
        return regexFallback();
      }
      return { ...parseModelJson(text), source: 'llm_gemini' };
    } catch (err) {
      console.warn(`extractListingInfo: ошибка Gemini (${err.message}), откат на regex`);
      return regexFallback();
    }
  }

  // СПОСОБ 2 — запасной вариант, любой OpenAI-совместимый роутер.
  if (LLM_API_BASE_URL && LLM_API_KEY && LLM_MODEL) {
    try {
      const response = await axios.post(
        `${LLM_API_BASE_URL.replace(/\/$/, '')}/chat/completions`,
        {
          model: LLM_MODEL,
          max_tokens: 300,
          temperature: 0,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: rawText.slice(0, 3000) },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${LLM_API_KEY}`,
            'content-type': 'application/json',
          },
          timeout: LLM_TIMEOUT_MS,
        }
      );

      const text = response.data?.choices?.[0]?.message?.content;
      if (!text) {
        console.warn('extractListingInfo: пустой ответ от роутера, откат на regex');
        return regexFallback();
      }
      return { ...parseModelJson(text), source: 'llm_router' };
    } catch (err) {
      console.warn(`extractListingInfo: ошибка роутера (${err.message}), откат на regex`);
      return regexFallback();
    }
  }

  return regexFallback();
}