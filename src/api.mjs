// Model API client. No SDK, no deps: one fetch() call, same code in Node >= 20 and in the
// browser (the browser-access header below is what makes the direct Anthropic call legal).
//
// Two providers behind one shape. Callers always speak the Anthropic request shape
// ({ system, messages, tools:[{name,description,input_schema}], tool_choice }); when
// provider === "openai" it is translated to chat/completions on the way out and the
// response is normalised on the way back, so nothing above this file branches on provider
// except where the two APIs genuinely differ (token counting, cache control).

const DEFAULT_BASE = Object.freeze({
  anthropic: "https://api.anthropic.com",
  openai: "https://api.deepseek.com", // first OpenAI-compatible target; any other one needs --base-url
});
const ANTHROPIC_VERSION = "2023-06-01";

// deepseek-chat caps max_tokens at 8192. Asking for more is a 400, so we clamp instead.
export const OPENAI_MAX_TOKENS = 8192;

// Total tries, first attempt included. 3 = the Anthropic SDKs' own default (max_retries: 2
// on top of the initial request); we copy the SDK convention rather than invent a number.
export const MAX_ATTEMPTS = 3;

// Retried statuses: 429 rate limit, 529 overloaded, and any 5xx.
const RETRY_STATUS = (s) => s === 429 || s === 529 || (s >= 500 && s < 600);

// Injectable fetch, for tests. Module-local on purpose: never patch globalThis.
let fetchImpl = null;

/** setFetch(fn) to stub, setFetch(null) to go back to the platform fetch. */
export function setFetch(fn) {
  fetchImpl = fn ?? null;
}

function doFetch(...args) {
  return (fetchImpl ?? globalThis.fetch)(...args);
}

export function resolveBaseUrl(provider, baseUrl) {
  const base = baseUrl ?? DEFAULT_BASE[provider];
  if (!base) throw new Error(`unknown provider: ${provider}`);
  return String(base).replace(/\/+$/, "");
}

export function isProvider(p) {
  return p === "anthropic" || p === "openai";
}

function headers(provider, apiKey) {
  if (provider === "openai") {
    return { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
  }
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

function abortError(reason = "aborted") {
  const e = new Error(reason);
  e.name = "AbortError";
  return e;
}

/** Sleep that rejects instead of hanging when the caller aborts. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(abortError());
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/**
 * `retry-after` is seconds or an HTTP-date. Returns ms, or null when unusable.
 * Capped at 60s so a hostile header cannot park the run forever.
 */
function retryAfterMs(res) {
  const raw = res.headers?.get?.("retry-after");
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000);
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), 60_000);
  return null;
}

function backoffMs(attempt) {
  return Math.min(1000 * 2 ** (attempt - 1), 8000);
}

function apiError(status, message, body) {
  const e = new Error(message);
  e.status = status;
  e.body = body;
  return e;
}

/** Pull the most useful message out of a provider error envelope. Both use {error:{message}}. */
function messageFrom(provider, status, text) {
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON error body; fall through to the raw text */
  }
  const detail = parsed?.error?.message ?? parsed?.message ?? text?.slice(0, 500) ?? "";
  return { message: `${provider} ${status}: ${detail || "request failed"}`, body: parsed ?? text };
}

/** Shared retry loop. Provider only decides the URL, the headers and the error prefix. */
async function post(url, { provider, apiKey, body, signal }) {
  if (!apiKey) throw new Error("missing API key");
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw abortError();

    let res;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: headers(provider, apiKey),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err?.name === "AbortError" || signal?.aborted) throw err;
      // Network-level failure: same retry budget as a 5xx.
      lastError = err;
      if (attempt === MAX_ATTEMPTS) throw err;
      await sleep(backoffMs(attempt), signal);
      continue;
    }

    if (res.ok) return await res.json();

    const text = await res.text().catch(() => "");
    const { message, body: parsedBody } = messageFrom(provider, res.status, text);

    if (!RETRY_STATUS(res.status) || attempt === MAX_ATTEMPTS) {
      throw apiError(res.status, message, parsedBody);
    }
    lastError = apiError(res.status, message, parsedBody);
    await sleep(retryAfterMs(res) ?? backoffMs(attempt), signal);
  }

  throw lastError ?? new Error("request failed");
}

// ---------------------------------------------------------------- request mapping

function blocksToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text" || typeof b?.text === "string").map((b) => b.text ?? "").join("");
}

/**
 * Anthropic request shape -> OpenAI chat/completions.
 * cache_control is dropped: OpenAI-compatible endpoints have no such field (DeepSeek caches
 * server-side by prefix, with nothing for the client to declare).
 */
export function toOpenAIBody(body, toolChoice = "forced") {
  const messages = [];
  const systemText = blocksToText(body?.system);
  if (systemText) messages.push({ role: "system", content: systemText });
  for (const m of body?.messages ?? []) {
    messages.push({ role: m.role, content: blocksToText(m.content) });
  }

  const out = { model: body?.model, messages };
  if (body?.max_tokens != null) out.max_tokens = Math.min(body.max_tokens, OPENAI_MAX_TOKENS);
  if (Array.isArray(body?.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
    const forcedName = body?.tool_choice?.type === "tool" ? body.tool_choice.name : null;
    if (toolChoice === "forced" && forcedName) {
      out.tool_choice = { type: "function", function: { name: forcedName } };
    } else {
      // deepseek-reasoner rejects any forced tool_choice; it still calls the tool on "auto".
      out.tool_choice = "auto";
    }
  }
  return out;
}

const TOOL_CHOICE_UNSUPPORTED = /does not support this tool_choice/i;

function rejectsForcedToolChoice(err) {
  if (err?.status !== 400) return false;
  const detail = `${err.message ?? ""} ${typeof err.body === "string" ? err.body : JSON.stringify(err.body ?? "")}`;
  return TOOL_CHOICE_UNSUPPORTED.test(detail);
}

/**
 * POST the messages request. Returns the parsed response JSON in the provider's own shape;
 * read it through textOf / toolInputOf / usageOf / stopReasonOf, never by hand.
 *
 * toolChoice: "forced" (default) or "auto", openai only. A model that refuses a forced
 * tool_choice (deepseek-reasoner in thinking mode) is retried once on "auto" — one extra
 * request, not a loop, and only for that one 400.
 */
export async function callMessages({ provider = "anthropic", baseUrl, apiKey, body, signal, toolChoice = "forced" }) {
  if (provider === "anthropic") {
    return post(`${resolveBaseUrl(provider, baseUrl)}/v1/messages`, { provider, apiKey, body, signal });
  }
  if (provider !== "openai") throw new Error(`unknown provider: ${provider}`);

  const url = `${resolveBaseUrl(provider, baseUrl)}/chat/completions`;
  try {
    return await post(url, { provider, apiKey, body: toOpenAIBody(body, toolChoice), signal });
  } catch (err) {
    if (toolChoice !== "forced" || !rejectsForcedToolChoice(err)) throw err;
    return post(url, { provider, apiKey, body: toOpenAIBody(body, "auto"), signal });
  }
}

/**
 * Prompt token count as { promptTokens, source }.
 * anthropic: the real count_tokens endpoint. openai: no such endpoint anywhere in the
 * compatible surface, so chars/4 — flagged "estimate" and reported as such.
 */
export async function countTokens({ provider = "anthropic", baseUrl, apiKey, model, system, messages, signal }) {
  if (provider === "openai") {
    const chars = blocksToText(system).length + (messages ?? []).reduce((n, m) => n + blocksToText(m.content).length, 0);
    return { promptTokens: Math.round(chars / 4), source: "estimate" };
  }
  const body = { model, messages };
  if (system != null) body.system = system;
  const data = await post(`${resolveBaseUrl(provider, baseUrl)}/v1/messages/count_tokens`, {
    provider,
    apiKey,
    body,
    signal,
  });
  return { promptTokens: data.input_tokens, source: "count_tokens" };
}

// ---------------------------------------------------------------- response normalisation

/** OpenAI responses carry `choices`; Anthropic ones carry `content`. */
function isOpenAIResponse(response) {
  return Array.isArray(response?.choices);
}

/**
 * Concatenate only the text. `thinking` blocks (anthropic) and `reasoning_content`
 * (deepseek-reasoner) are dropped on purpose: Fable 5.1 thinks adaptively by default and
 * that cannot be turned off, so thinking text would otherwise leak into every measurement.
 */
export function textOf(response) {
  if (isOpenAIResponse(response)) return response.choices[0]?.message?.content ?? "";
  const content = response?.content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("");
}

const STOP_REASON = Object.freeze({ stop: "end_turn", length: "max_tokens", tool_calls: "tool_use" });

/** Normalised stop reason. OpenAI's finish_reason is mapped onto the Anthropic vocabulary. */
export function stopReasonOf(response) {
  if (isOpenAIResponse(response)) {
    const fr = response.choices[0]?.finish_reason ?? null;
    return fr == null ? null : (STOP_REASON[fr] ?? fr);
  }
  return response?.stop_reason ?? null;
}

/**
 * Normalised usage. `thinking` comes from `usage.output_tokens_details.thinking_tokens`
 * (fable 5.1 reports it there; it is a subset of `output`, not additional).
 * `reasoningChars` is a character count, not tokens: deepseek-reasoner bills its reasoning
 * inside completion_tokens and gives no separate count, so this is only a size signal.
 */
export function usageOf(response) {
  if (isOpenAIResponse(response)) {
    const u = response.usage ?? {};
    return {
      input: u.prompt_tokens ?? 0,
      output: u.completion_tokens ?? 0,
      // No client-declared cache on OpenAI-compatible endpoints: hits are reported, creation is not.
      cache_creation: 0,
      cache_read: u.prompt_cache_hit_tokens ?? 0,
      thinking: 0,
      reasoningChars: (response.choices[0]?.message?.reasoning_content ?? "").length,
    };
  }
  const u = response?.usage ?? {};
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cache_creation: u.cache_creation_input_tokens ?? 0,
    cache_read: u.cache_read_input_tokens ?? 0,
    thinking: u.output_tokens_details?.thinking_tokens ?? 0, // fable 5.1 reports it here (verified 2026-09-04)
    reasoningChars: 0,
  };
}

/** Sum usage objects into a running total. Pure. */
export function addUsage(a, b) {
  return {
    input: (a?.input ?? 0) + (b?.input ?? 0),
    output: (a?.output ?? 0) + (b?.output ?? 0),
    cache_creation: (a?.cache_creation ?? 0) + (b?.cache_creation ?? 0),
    cache_read: (a?.cache_read ?? 0) + (b?.cache_read ?? 0),
    thinking: (a?.thinking ?? 0) + (b?.thinking ?? 0),
    reasoningChars: (a?.reasoningChars ?? 0) + (b?.reasoningChars ?? 0),
  };
}

export const ZERO_USAGE = Object.freeze({
  input: 0,
  output: 0,
  cache_creation: 0,
  cache_read: 0,
  thinking: 0,
  reasoningChars: 0,
});

/** First tool_use block with the given name, or null. Anthropic shape only. */
export function toolUseOf(response, name) {
  const content = response?.content;
  if (!Array.isArray(content)) return null;
  return content.find((b) => b?.type === "tool_use" && b.name === name) ?? null;
}

/**
 * The structured arguments of the tool call, whichever provider produced it, or null when
 * the response has no tool block at all.
 * Throws when the model answered in prose under tool_choice:"auto" (openai), and when the
 * arguments are not parseable JSON — a silently-empty object here would classify as a real
 * verdict downstream.
 */
export function toolInputOf(response, name) {
  if (isOpenAIResponse(response)) {
    const calls = response.choices[0]?.message?.tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) throw new Error("model did not call the tool");
    const call = (name ? calls.find((c) => c?.function?.name === name) : null) ?? calls[0];
    const raw = call?.function?.arguments;
    if (typeof raw !== "string") throw new Error("tool call has no arguments string");
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(`tool arguments are not valid JSON (${err.message}): ${raw.slice(0, 200)}`);
    }
  }
  const block = name ? toolUseOf(response, name) : (response?.content ?? []).find?.((b) => b?.type === "tool_use");
  return block ? (block.input ?? null) : null;
}
