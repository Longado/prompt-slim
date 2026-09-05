// The target model under test. Two calls, never a judgment: bare (no system prompt at all)
// and full (your prompt as a system block, cached where the provider supports it).

import { callMessages, textOf, usageOf, stopReasonOf } from "./api.mjs";

const MAX_TOKENS = 4096;

function shape(response) {
  const stop_reason = stopReasonOf(response);
  return {
    text: textOf(response),
    usage: usageOf(response),
    stop_reason,
    truncated: stop_reason === "max_tokens",
  };
}

/**
 * The `full` system block. Anthropic gets an explicit ephemeral cache breakpoint; an
 * OpenAI-compatible endpoint has no client-declared cache, so it gets the plain text
 * (which toOpenAIBody turns into one {role:"system"} message).
 */
function systemFor(provider, promptText) {
  if (provider === "openai") return promptText;
  return [{ type: "text", text: promptText, cache_control: { type: "ephemeral" } }];
}

/**
 * runProbe({ message, promptText, apiKey, targetModel, provider, baseUrl, signal }) -> { bare, full }
 * The two calls are serial on purpose: on Anthropic, `full` reuses the ephemeral cache written
 * by the previous rule's `full` call, which only survives a 5-minute window. The caller must not
 * fan these out in parallel or the cache hit rate collapses.
 * `bare` carries no system prompt at all on either provider — that is the whole experiment.
 */
export async function runProbe({
  message,
  promptText,
  apiKey,
  targetModel,
  provider = "anthropic",
  baseUrl,
  signal,
}) {
  if (typeof message !== "string" || message === "") throw new Error("runProbe: message is empty");
  if (!targetModel) throw new Error("runProbe: targetModel is required");

  const bareResponse = await callMessages({
    provider,
    baseUrl,
    apiKey,
    signal,
    body: {
      model: targetModel,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: message }],
    },
  });

  const fullResponse = await callMessages({
    provider,
    baseUrl,
    apiKey,
    signal,
    body: {
      model: targetModel,
      max_tokens: MAX_TOKENS,
      system: systemFor(provider, promptText),
      messages: [{ role: "user", content: message }],
    },
  });

  return { bare: shape(bareResponse), full: shape(fullResponse) };
}
