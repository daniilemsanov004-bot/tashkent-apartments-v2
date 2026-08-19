// ВАЖНО: это отдельная копия цепочки ИИ-провайдеров от
// scraper/src/aiProviders.js — используется тут, на Vercel
// (client/api/_aiSearch.js: ИИ-поиск на сайте и команда /search в
// Telegram-боте), потому что это другой деплоймент-юнит без общего
// import-пути со scraper/. Если чините цепочку в одном месте —
// проверьте и второе (см. также замечание в scraper/src/aiProviders.js).
//
// 19.08.2026: синхронизировано с фиксами из scraper/src/aiProviders.js
// (актуальные модели вместо задепрекейченных/платных, reasoning_effort
// для reasoning-моделей) — до этого поиск тут тихо ходил по цепочке
// Gemini -> Groq(404, дохлая модель) -> Cerebras(402) -> OpenRouter(402
// на платной модели) и почти всегда падал сразу на Gemini без реального
// фолбэка, хотя AI_FALLBACK_ENABLED был включён.
//
// Cerebras убран из цепочки вообще (19.08.2026) — их бесплатный тариф
// в 2026 стал разовым $5-кредитом вместо постоянного free tier, на
// аккаунте проекта исчерпан, и без привязки карты не восстановится.
// Раз он не работает и чинить нечем — просто выпилен, а не оставлен
// как мёртвое звено, которое на каждый запрос сначала падает с 402 и
// только потом идёт дальше по цепочке.
//
// 19.08.2026: добавлены SambaNova и Cloudflare Workers AI пятым и
// шестым звеном (после Mistral) — при 4 провайдерах шанс, что упадут
// все одновременно, был ощутимо больше 10%; независимые от остальных
// провайдеров (свои чипы/edge-сеть) снижают этот риск.

const AI_FALLBACK_ENABLED = process.env.AI_FALLBACK_ENABLED === 'true';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const SAMBANOVA_API_KEY = process.env.SAMBANOVA_API_KEY;
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
// llama-3.3-70b-versatile официально задепрекейчен Groq 17.06.2026
// (см. console.groq.com/docs/deprecations) — вызовы к нему падают с
// 404 model_decommissioned. Актуальная замена — openai/gpt-oss-120b.
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
// openai/gpt-4o-mini — платная модель, на аккаунте без пополнения
// падает с 402. openrouter/free — авто-роутер, сам подбирает бесплатную
// модель из текущего живого списка (жёстко прибивать конкретный
// :free-id рискованно — такие модели периодически снимают с
// бесплатного тарифа без предупреждения).
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';
// Mistral Experiment tier — 1 млрд токенов/мес бесплатно, постоянный
// (не разовый) лимит. mistral-small-latest — не reasoning-модель.
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || 'mistral-small-latest';
// SambaNova Cloud free tier — без карты, независимые чипы (RDU), не
// reasoning-модель. См. подробное обоснование в scraper/src/aiProviders.js.
const SAMBANOVA_MODEL = process.env.SAMBANOVA_MODEL || 'Meta-Llama-3.3-70B-Instruct';
// Cloudflare Workers AI free tier — 10 000 нейронов/день, без карты.
// Требует CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (два значения,
// не один ключ). Edge-инфраструктура, независимая от остальных
// провайдеров в цепочке. -fast вариант (не обычный instruct) —
// Cloudflare задепрекейчила базовый 30.05.2026, см. подробности в
// scraper/src/aiProviders.js.
const CLOUDFLARE_MODEL = process.env.CLOUDFLARE_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast';

const DEFAULT_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 40000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const PROVIDER_DELAY_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanJsonText(text) {
  const raw = String(text || '').trim();
  const noFence = raw.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  const start = noFence.indexOf('{');
  const end = noFence.lastIndexOf('}');
  if (start >= 0 && end > start) return noFence.slice(start, end + 1).trim();
  return noFence;
}

function parseJsonResponse(text) {
  return JSON.parse(cleanJsonText(text));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const bodyText = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.response = { status: res.status, text: bodyText };
      throw err;
    }
    return JSON.parse(bodyText);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callGemini({ model, systemPrompt, userText, timeoutMs, maxTokens = 300 }) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const data = await fetchJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ parts: [{ text: userText }] }],
            // temperature/top_p/top_k задепрекейчены для текущих
            // Gemini flash-моделей — не отправляем. thinkingLevel:'low'
            // отключает лишнее "размышление" модели — ранее найденный
            // фикс таймаутов, см. историю проекта.
            generationConfig: {
              responseMimeType: 'application/json',
              maxOutputTokens: maxTokens,
              thinkingConfig: { thinkingLevel: 'low' },
            },
          }),
        },
        timeoutMs
      );
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('empty response');
      return parseJsonResponse(text);
    } catch (err) {
      lastError = err;
      const status = err?.response?.status;
      const retryable = !status || RETRYABLE_STATUSES.has(status);
      if (attempt === 2 || !retryable) break;
      await sleep(800);
    }
  }
  throw lastError || new Error('gemini failed');
}

async function callOpenAICompatible({ baseUrl, apiKey, model, systemPrompt, userText, timeoutMs, maxTokens = 300, extraHeaders = {}, extraBody = {} }) {
  const data = await fetchJson(
    `${baseUrl.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
        ...extraBody,
      }),
    },
    timeoutMs
  );
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('empty response');
  return parseJsonResponse(text);
}

function providerPlan() {
  const plan = [];
  if (GEMINI_API_KEY) plan.push({ name: 'gemini' });
  if (AI_FALLBACK_ENABLED && GROQ_API_KEY) plan.push({ name: 'groq' });
  if (AI_FALLBACK_ENABLED && OPENROUTER_API_KEY) plan.push({ name: 'openrouter' });
  if (AI_FALLBACK_ENABLED && MISTRAL_API_KEY) plan.push({ name: 'mistral' });
  if (AI_FALLBACK_ENABLED && SAMBANOVA_API_KEY) plan.push({ name: 'sambanova' });
  if (AI_FALLBACK_ENABLED && CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_API_TOKEN) plan.push({ name: 'cloudflare' });
  return plan;
}

export async function runAiJsonChain({
  taskName,
  systemPrompt,
  userText,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxTokens = 300,
}) {
  const plan = providerPlan();
  if (plan.length === 0) {
    return { ok: false, reason: 'unavailable', provider: null };
  }

  let lastError = null;
  for (const provider of plan) {
    try {
      let data;
      if (provider.name === 'gemini') {
        data = await callGemini({ model: GEMINI_MODEL, systemPrompt, userText, timeoutMs, maxTokens });
      } else if (provider.name === 'groq') {
        data = await callOpenAICompatible({
          baseUrl: 'https://api.groq.com/openai/v1',
          apiKey: GROQ_API_KEY,
          model: GROQ_MODEL,
          systemPrompt,
          userText,
          timeoutMs,
          maxTokens,
          // openai/gpt-oss-* — reasoning-модели: без этого параметра
          // они тратят токены на "размышления" до финального ответа и
          // при небольшом max_tokens content приходит пустым ("empty
          // response").
          extraBody: /gpt-oss/.test(GROQ_MODEL) ? { reasoning_effort: 'low' } : {},
        });
      } else if (provider.name === 'openrouter') {
        data = await callOpenAICompatible({
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: OPENROUTER_API_KEY,
          model: OPENROUTER_MODEL,
          systemPrompt,
          userText,
          timeoutMs,
          maxTokens,
          extraHeaders: {
            ...(process.env.OPENROUTER_HTTP_REFERER ? { 'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER } : {}),
            ...(process.env.OPENROUTER_APP_TITLE ? { 'X-Title': process.env.OPENROUTER_APP_TITLE } : {}),
          },
          // openrouter/free сам выбирает бесплатную модель, часто тоже
          // reasoning (DeepSeek/GLM/Qwen-thinking и т.п.) — тот же
          // "empty response", что и с gpt-oss на Groq.
          extraBody: { reasoning: { effort: 'low', exclude: true } },
        });
      } else if (provider.name === 'mistral') {
        data = await callOpenAICompatible({
          baseUrl: 'https://api.mistral.ai/v1',
          apiKey: MISTRAL_API_KEY,
          model: MISTRAL_MODEL,
          systemPrompt,
          userText,
          timeoutMs,
          maxTokens,
        });
      } else if (provider.name === 'sambanova') {
        data = await callOpenAICompatible({
          baseUrl: 'https://api.sambanova.ai/v1',
          apiKey: SAMBANOVA_API_KEY,
          model: SAMBANOVA_MODEL,
          systemPrompt,
          userText,
          timeoutMs,
          maxTokens,
        });
      } else if (provider.name === 'cloudflare') {
        data = await callOpenAICompatible({
          baseUrl: `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
          apiKey: CLOUDFLARE_API_TOKEN,
          model: CLOUDFLARE_MODEL,
          systemPrompt,
          userText,
          timeoutMs,
          maxTokens,
        });
      } else {
        continue;
      }
      console.log(`${taskName}: provider ${provider.name} ok`);
      return { ok: true, provider: provider.name, data };
    } catch (err) {
      lastError = err;
      console.warn(`${taskName}: provider ${provider.name} failed (${err?.response?.status || err.message})`);
      if (!AI_FALLBACK_ENABLED && provider.name === 'gemini') break;
      if (provider.name === 'gemini' && !AI_FALLBACK_ENABLED && !RETRYABLE_STATUSES.has(err?.response?.status)) break;
      await sleep(PROVIDER_DELAY_MS);
    }
  }

  return {
    ok: false,
    reason: AI_FALLBACK_ENABLED ? 'fallback_exhausted' : 'bad_response',
    provider: null,
    error: lastError?.message || 'all providers failed',
  };
}
