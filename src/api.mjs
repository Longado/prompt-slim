// Anthropic Messages API client. No SDK, no deps: one fetch() call, same code in Node >= 20
// and in the browser (the browser-access header below is what makes the direct call legal).

const BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

// Total tries, first attempt included. 3 = the Anthropic SDKs' own default (max_retries: 2
// on top of the initial request); we copy the SDK convention rather than invent a number.
export const MAX_ATTEMPTS = 3;

// Retried statuses: 429 rate limit, 529 overloaded, and any 5xx.
const RETRY_STATUS = (s) => s === 429 || s === 529 || (s >= 500 && s < 600);

function headers(apiKey) {
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

/** Pull the most useful message out of an Anthropic error envelope. */
function messageFrom(status, text) {
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON error body; fall through to the raw text */
  }
  const detail = parsed?.error?.message ?? parsed?.message ?? text?.slice(0, 500) ?? "";
  return { message: `anthropic ${status}: ${detail || "request failed"}`, body: parsed ?? text };
}

async function post(path, { apiKey, body, signal }) {
  if (!apiKey) throw new Error("missing API key");
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw abortError();

    let res;
    try {
      res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: headers(apiKey),
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
    const { message, body: parsedBody } = messageFrom(res.status, text);

    if (!RETRY_STATUS(res.status) || attempt === MAX_ATTEMPTS) {
      throw apiError(res.status, message, parsedBody);
    }
    lastError = apiError(res.status, message, parsedBody);
    await sleep(retryAfterMs(res) ?? backoffMs(attempt), signal);
  }

  throw lastError ?? new Error("request failed");
}

/** POST /v1/messages. Returns the parsed response JSON. */
export async function callMessages({ apiKey, body, signal }) {
  return post("/v1/messages", { apiKey, body, signal });
}

/** POST /v1/messages/count_tokens. Returns the token count as a number. */
export async function countTokens({ apiKey, model, system, messages, signal }) {
  const body = { model, messages };
  if (system != null) body.system = system;
  const data = await post("/v1/messages/count_tokens", { apiKey, body, signal });
  return data.input_tokens;
}

/**
 * Concatenate only the text blocks. `thinking` blocks are dropped on purpose:
 * Fable 5.1 thinks adaptively by default and that cannot be turned off, so thinking
 * text would otherwise leak into every probe measurement.
 */
export function textOf(response) {
  const content = response?.content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("");
}

/**
 * Normalised usage. `thinking` comes from `usage.output_tokens_details.thinking_tokens`
 * (fable 5.1 reports it there; it is a subset of `output`, not additional).
 */
export function usageOf(response) {
  const u = response?.usage ?? {};
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cache_creation: u.cache_creation_input_tokens ?? 0,
    cache_read: u.cache_read_input_tokens ?? 0,
    thinking: u.output_tokens_details?.thinking_tokens ?? 0, // fable 5.1 reports it here (verified 2026-09-04)
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
  };
}

export const ZERO_USAGE = Object.freeze({ input: 0, output: 0, cache_creation: 0, cache_read: 0, thinking: 0 });

/** First tool_use block with the given name, or null. */
export function toolUseOf(response, name) {
  const content = response?.content;
  if (!Array.isArray(content)) return null;
  return content.find((b) => b?.type === "tool_use" && b.name === name) ?? null;
}
