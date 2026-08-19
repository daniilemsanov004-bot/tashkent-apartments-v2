import axios from 'axios';

const AI_FALLBACK_ENABLED = process.env.AI_FALLBACK_ENABLED === 'true';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
// llama-3.3-70b-versatile официально задепрекейчен Groq 17.06.2026
// (см. console.groq.com/docs/deprecations) — вызовы к нему теперь
// падают с 404 model_decommissioned. Актуальная замена по
// рекомендации Groq — openai/gpt-oss-120b.
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const CEREBRAS_MODEL = process.env.CEREBRAS_MODEL || 'gpt-oss-120b';
// openai/gpt-4o-mini — платная модель, на аккаунте без пополнения
// упадёт с 402 (Payment Required), как это уже было с Cerebras.
// openrouter/free — встроенный авто-роутер OpenRouter: сам подбирает
// бесплатную модель из текущего живого списка (список :free-моделей
// у OpenRouter регулярно меняется, поэтому жёстко прибивать
// конкретный id вроде "meta-llama/llama-3.3-70b:free" рискованно —
// такие id периодически снимают с бесплатного тарифа без предупреждения).
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';

const DEFAULT_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 15000;
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

function isRetryableError(err) {
  const status = err?.response?.status;
  if (status && !RETRYABLE_STATUSES.has(status)) return false;
  return true;
}

async function callGemini({ model, systemPrompt, userText, timeoutMs, maxTokens = 300 }) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userText }] }],
          // temperature/top_p/top_k официально задепрекейчены для
          // текущих Gemini flash-моделей — не отправляем их.
          // thinkingConfig.thinkingLevel: 'low' — по умолчанию у этих
          // моделей thinkingLevel medium (модель "размышляет" перед
          // ответом), что для простых задач извлечения полей избыточно
          // и было реальной причиной таймаутов (см. историю проекта).
          generationConfig: {
            responseMimeType: 'application/json',
            maxOutputTokens: maxTokens,
            thinkingConfig: { thinkingLevel: 'low' },
          },
        },
        {
          headers: { 'content-type': 'application/json' },
          params: { key: GEMINI_API_KEY },
          timeout: timeoutMs,
        }
      );
      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
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
  const response = await axios.post(
    `${baseUrl.replace(/\/$/, '')}/chat/completions`,
    {
      model,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText },
      ],
      ...extraBody,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        ...extraHeaders,
      },
      timeout: timeoutMs,
    }
  );
  const text = response.data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('empty response');
  return parseJsonResponse(text);
}

export function providerPlan() {
  const plan = [];
  if (GEMINI_API_KEY) plan.push({ name: 'gemini', enabled: true });
  if (AI_FALLBACK_ENABLED && GROQ_API_KEY) plan.push({ name: 'groq', enabled: true });
  if (AI_FALLBACK_ENABLED && CEREBRAS_API_KEY) plan.push({ name: 'cerebras', enabled: true });
  if (AI_FALLBACK_ENABLED && OPENROUTER_API_KEY) plan.push({ name: 'openrouter', enabled: true });
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
      if (provider.name === 'gemini') {
        return {
          ok: true,
          provider: 'gemini',
          data: await callGemini({ model: GEMINI_MODEL, systemPrompt, userText, timeoutMs, maxTokens }),
        };
      }
      if (provider.name === 'groq') {
        return {
          ok: true,
          provider: 'groq',
          data: await callOpenAICompatible({
            baseUrl: 'https://api.groq.com/openai/v1',
            apiKey: GROQ_API_KEY,
            model: GROQ_MODEL,
            systemPrompt,
            userText,
            timeoutMs,
            maxTokens,
            // openai/gpt-oss-* — reasoning-модели: без этого параметра
            // они по умолчанию тратят "medium" количество токенов на
            // размышления ДО финального ответа, и при небольшом
            // max_tokens (300 для извлечения полей) итоговый content
            // приходит пустым — именно это давало "empty response".
            extraBody: /gpt-oss/.test(GROQ_MODEL) ? { reasoning_effort: 'low' } : {},
          }),
        };
      }
      if (provider.name === 'cerebras') {
        return {
          ok: true,
          provider: 'cerebras',
          data: await callOpenAICompatible({
            baseUrl: 'https://api.cerebras.ai/v1',
            apiKey: CEREBRAS_API_KEY,
            model: CEREBRAS_MODEL,
            systemPrompt,
            userText,
            timeoutMs,
            maxTokens,
          }),
        };
      }
      if (provider.name === 'openrouter') {
        return {
          ok: true,
          provider: 'openrouter',
          data: await callOpenAICompatible({
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
            // openrouter/free сам выбирает бесплатную модель, и часто
            // это тоже reasoning-модель (DeepSeek/GLM/Qwen-thinking и
            // т.п.) — тот же "empty response", что и с gpt-oss на Groq.
            // effort:'low' + exclude:true просит минимум размышлений и
            // не возвращать их в ответе, оставляя токены под сам JSON.
            extraBody: { reasoning: { effort: 'low', exclude: true } },
          }),
        };
      }
    } catch (err) {
      lastError = err;
      console.warn(`${taskName}: provider ${provider.name} failed (${err.response?.status || err.message})`);
      if (!AI_FALLBACK_ENABLED && provider.name === 'gemini') break;
      if (!isRetryableError(err) && provider.name === 'gemini' && !AI_FALLBACK_ENABLED) break;
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
