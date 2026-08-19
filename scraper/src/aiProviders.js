import axios from 'axios';

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
// (см. console.groq.com/docs/deprecations) — вызовы к нему теперь
// падают с 404 model_decommissioned. Актуальная замена по
// рекомендации Groq — openai/gpt-oss-120b.
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
// Cerebras убран из цепочки (19.08.2026) — их бесплатный тариф стал
// разовым $5-кредитом вместо постоянного free tier, на аккаунте
// проекта исчерпан (стабильные 402 Payment Required), без привязки
// карты не восстановится. Раз не работает и чинить нечем — выпилен
// целиком, а не оставлен как мёртвое звено, которое сначала падает на
// каждом объявлении и только потом идёт дальше по цепочке (даже с
// circuit breaker'ом это лишние 3 неудачных запроса в начале КАЖДОГО
// прогона, пока breaker снова не сработает).
// openai/gpt-4o-mini — платная модель, на аккаунте без пополнения
// упадёт с 402 (Payment Required). openrouter/free — встроенный
// авто-роутер OpenRouter: сам подбирает
// бесплатную модель из текущего живого списка (список :free-моделей
// у OpenRouter регулярно меняется, поэтому жёстко прибивать
// конкретный id вроде "meta-llama/llama-3.3-70b:free" рискованно —
// такие id периодически снимают с бесплатного тарифа без предупреждения).
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';
// Mistral Experiment tier — 1 млрд токенов/мес бесплатно, самый
// щедрый постоянный (не разовый) лимит из всех провайдеров в цепочке.
// mistral-small-latest — не reasoning-модель, поэтому reasoning_effort
// ей не нужен и "empty response" из-за исчерпанного лимита токенов
// на размышления ей не грозит.
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || 'mistral-small-latest';
// SambaNova Cloud free developer tier — без карты, 600 RPM.
// Llama-3.3-70B-Instruct — не reasoning-модель (в отличие от их же
// gpt-oss на этом провайдере), так что reasoning_effort ей не нужен и
// пустых ответов из-за токенов на размышления можно не бояться.
// Независимая от остальных провайдеров инфраструктура — свои чипы
// (RDU), не переиспользует чужие GPU-облака, как многие агрегаторы.
const SAMBANOVA_MODEL = process.env.SAMBANOVA_MODEL || 'Meta-Llama-3.3-70B-Instruct';
// Cloudflare Workers AI free tier — 10 000 "нейронов"/день (это
// порядка 1000+ ответов в день для 8B-модели), без привязки карты.
// Требует ДВА значения, не один ключ: CLOUDFLARE_ACCOUNT_ID (виден в
// дашборде Cloudflare) и CLOUDFLARE_API_TOKEN. Инфраструктура —
// edge-сеть Cloudflare, ещё один независимый источник отказа.
// llama-3.1-8b-instruct взят вместо 3.3-70b намеренно: 8B почти не
// расходует нейроны/день, а этот провайдер и так самый последний в
// цепочке (subject to остальные уже упали) — важнее продержаться на
// нём подольше, чем выжать максимум качества из одного запроса.
const CLOUDFLARE_MODEL = process.env.CLOUDFLARE_MODEL || '@cf/meta/llama-3.1-8b-instruct';

const DEFAULT_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 15000;

// Мини circuit breaker на весь прогон: если провайдер падает по
// 429 (квота/рейт-лимит) или 402 (нет денег на счету) несколько раз
// подряд, это почти наверняка не восстановится до следующего запуска
// через 15 минут — нет смысла ходить к нему на КАЖДОМ объявлении и
// ждать таймаут/ретрай. Отключаем его до конца текущего прогона, и
// цепочка сразу идёт к следующему провайдеру, экономя секунды на
// каждое объявление (при 40+ объявлениях за прогон это минуты).
const CIRCUIT_BREAKER_STATUSES = new Set([429, 402]);
const CIRCUIT_BREAKER_THRESHOLD = 3;
const providerFailureStreak = new Map();
const providerDisabledForRun = new Set();

function noteProviderResult(name, err) {
  const status = err?.response?.status;
  if (status && CIRCUIT_BREAKER_STATUSES.has(status)) {
    const streak = (providerFailureStreak.get(name) || 0) + 1;
    providerFailureStreak.set(name, streak);
    if (streak >= CIRCUIT_BREAKER_THRESHOLD) {
      providerDisabledForRun.add(name);
    }
  } else {
    providerFailureStreak.set(name, 0);
  }
}
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
  if (GEMINI_API_KEY && !providerDisabledForRun.has('gemini')) plan.push({ name: 'gemini', enabled: true });
  if (AI_FALLBACK_ENABLED && GROQ_API_KEY && !providerDisabledForRun.has('groq')) plan.push({ name: 'groq', enabled: true });
  if (AI_FALLBACK_ENABLED && OPENROUTER_API_KEY && !providerDisabledForRun.has('openrouter')) plan.push({ name: 'openrouter', enabled: true });
  if (AI_FALLBACK_ENABLED && MISTRAL_API_KEY && !providerDisabledForRun.has('mistral')) plan.push({ name: 'mistral', enabled: true });
  if (AI_FALLBACK_ENABLED && SAMBANOVA_API_KEY && !providerDisabledForRun.has('sambanova')) plan.push({ name: 'sambanova', enabled: true });
  if (AI_FALLBACK_ENABLED && CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_API_TOKEN && !providerDisabledForRun.has('cloudflare')) plan.push({ name: 'cloudflare', enabled: true });
  return plan;
}

// Нужно снаружи (run.js), чтобы решить, нужна ли ещё длинная пауза
// между объявлениями — она существует только ради лимита Gemini
// (см. LLM_EXTRACT_DELAY_MS), и как только Gemini отключён circuit
// breaker'ом на этот прогон, держать её длинной уже незачем.
export function isProviderActiveThisRun(name) {
  return !providerDisabledForRun.has(name);
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
          // они по умолчанию тратят "medium" количество токенов на
          // размышления ДО финального ответа, и при небольшом
          // max_tokens (300 для извлечения полей) итоговый content
          // приходит пустым — именно это давало "empty response".
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
          // openrouter/free сам выбирает бесплатную модель, и часто
          // это тоже reasoning-модель (DeepSeek/GLM/Qwen-thinking и
          // т.п.) — тот же "empty response", что и с gpt-oss на Groq.
          // effort:'low' + exclude:true просит минимум размышлений и
          // не возвращать их в ответе, оставляя токены под сам JSON.
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
      // Раньше успех вообще ничего не логировал — в логах было видно
      // только падения, из-за чего казалось, что groq/openrouter/
      // mistral не пробуются вообще, хотя на деле они
      // отвечали с первого раза и просто молчали. Теперь видно, кто
      // именно ответил на каждое объявление.
      console.log(`${taskName}: provider ${provider.name} ok`);
      return { ok: true, provider: provider.name, data };
    } catch (err) {
      lastError = err;
      console.warn(`${taskName}: provider ${provider.name} failed (${err.response?.status || err.message})`);
      noteProviderResult(provider.name, err);
      if (providerDisabledForRun.has(provider.name)) {
        console.warn(`${taskName}: provider ${provider.name} отключён до конца прогона (повторный 429/402)`);
      }
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
