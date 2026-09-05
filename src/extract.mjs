// LLM judgment #1 of 3: split a system prompt into individually testable rules.
// One call, forced tool, then every claim it makes about the source text is checked in code.

import { callMessages, toolInputOf, usageOf, stopReasonOf } from "./api.mjs";
import { loadPrompt } from "./prompts.mjs";
import { SUBMIT_RULES, validate, assertQuotesExact } from "./schemas.mjs";

const MAX_TOKENS = 32000;
const QUOTE_MISS_NOTE = "quote not found verbatim";

/**
 * extractRules({ promptText, apiKey, model, provider, baseUrl, signal })
 *   -> { reasoning, rules, promptVersion, model, usage }
 * Each rule gets an id "R1".."Rn" in document order.
 * A quote that is not an exact substring of promptText keeps its rule but forces testable:false —
 * we cannot probe a rule whose text we cannot locate.
 */
export async function extractRules({
  promptText,
  apiKey,
  model = "claude-opus-5",
  provider = "anthropic",
  baseUrl,
  signal,
}) {
  if (typeof promptText !== "string" || promptText.trim() === "") {
    throw new Error("extractRules: promptText is empty");
  }

  const { text: system, version: promptVersion } = await loadPrompt("extract");

  const response = await callMessages({
    provider,
    baseUrl,
    apiKey,
    signal,
    body: {
      model,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: promptText }],
      tools: [SUBMIT_RULES],
      tool_choice: { type: "tool", name: SUBMIT_RULES.name },
    },
  });

  if (stopReasonOf(response) === "max_tokens") {
    throw new Error("extraction truncated: prompt too long for one-pass extraction");
  }

  const input = toolInputOf(response, SUBMIT_RULES.name);
  if (!input) throw new Error("extraction returned no submit_rules tool call");

  const errs = validate(input, SUBMIT_RULES.input_schema);
  if (errs.length) throw new Error(`submit_rules failed validation: ${errs.join("; ")}`);

  const checked = assertQuotesExact(input.rules, promptText);
  const rules = checked.map((r, i) => {
    const withId = { ...r, id: `R${i + 1}` };
    if (r.quoteFound) return withId;
    return { ...withId, testable: false, why: `${r.why} (${QUOTE_MISS_NOTE})` };
  });

  return {
    reasoning: input.reasoning,
    rules,
    promptVersion,
    model,
    usage: usageOf(response),
  };
}
