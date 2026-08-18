const AI_FALLBACK_ENABLED = process.env.AI_FALLBACK_ENABLED === 'true';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const CEREBRAS_MODEL = process.env.CEREBRAS_MODEL || 'gpt-oss-120b';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

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

async function callOpenAICompatible({ baseUrl, apiKey, model, systemPrompt, userText, timeoutMs, maxTokens = 300, extraHeaders = {} }) {
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
  if (AI_FALLBACK_ENABLED && CEREBRAS_API_KEY) plan.push({ name: 'cerebras' });
  if (AI_FALLBACK_ENABLED && OPENROUTER_API_KEY) plan.push({ name: 'openrouter' });
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
          }),
        };
      }
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
