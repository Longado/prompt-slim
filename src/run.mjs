// The target model under test. Two calls, never a judgment: bare (no system prompt at all)
// and full (your prompt as a cached system block).

import { callMessages, textOf, usageOf } from "./api.mjs";

const MAX_TOKENS = 4096;

function shape(response) {
  const stop_reason = response?.stop_reason ?? null;
  return {
    text: textOf(response),
    usage: usageOf(response),
    stop_reason,
    truncated: stop_reason === "max_tokens",
  };
}

/**
 * runProbe({ message, promptText, apiKey, targetModel, signal }) -> { bare, full }
 * The two calls are serial on purpose: `full` reuses the ephemeral cache written by the
 * previous rule's `full` call, which only survives a 5-minute window. The caller must not
 * fan these out in parallel or the cache hit rate collapses.
 */
export async function runProbe({ message, promptText, apiKey, targetModel, signal }) {
  if (typeof message !== "string" || message === "") throw new Error("runProbe: message is empty");
  if (!targetModel) throw new Error("runProbe: targetModel is required");

  const bareResponse = await callMessages({
    apiKey,
    signal,
    body: {
      model: targetModel,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: message }],
    },
  });

  const fullResponse = await callMessages({
    apiKey,
    signal,
    body: {
      model: targetModel,
      max_tokens: MAX_TOKENS,
      system: [{ type: "text", text: promptText, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: message }],
    },
  });

  return { bare: shape(bareResponse), full: shape(fullResponse) };
}
