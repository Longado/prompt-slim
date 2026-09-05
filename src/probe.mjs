// LLM judgment #2 of 3: design 1-3 user messages that would expose whether a rule is followed.
// The model proposes the criterion; code decides whether that criterion is actually measurable.

import { callMessages, toolInputOf, usageOf } from "./api.mjs";
import { loadPrompt } from "./prompts.mjs";
import { SUBMIT_PROBES, validate } from "./schemas.mjs";
import { MEASURE_SATISFIED_WHEN, REGEX_MEASURES } from "./measure.mjs";

const MAX_TOKENS = 4096;
export const CONTEXT_RADIUS = 300;

/** The quote plus CONTEXT_RADIUS characters on each side, so the probe writer sees the branch. */
export function contextAround(text, quote, radius = CONTEXT_RADIUS) {
  if (typeof text !== "string" || typeof quote !== "string") return "";
  const at = text.indexOf(quote);
  if (at < 0) return quote;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + quote.length + radius);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

/**
 * A "code" criterion is only usable if a measure exists and satisfied_when means something for it.
 * Returns null when usable, otherwise the reason it is not.
 */
function codeCriterionProblem(criterion) {
  const { measure: name, arg, satisfied_when: when } = criterion;
  if (!name) return "code criterion has no measure";
  const allowed = MEASURE_SATISFIED_WHEN[name];
  if (!allowed) return `unknown measure "${name}"`;
  if (!when) return `measure "${name}" has no satisfied_when`;
  if (!allowed.includes(when)) {
    return `satisfied_when "${when}" does not fit measure "${name}" (expected ${allowed.join(" or ")})`;
  }
  if (REGEX_MEASURES.includes(name) && (typeof arg !== "string" || arg === "")) {
    return `measure "${name}" needs a regex arg`;
  }
  return null;
}

/** Rewrite an unmeasurable code probe as a judge probe, recording why in criterion.note. */
function downgrade(probe) {
  if (probe.criterion?.kind !== "code") return probe;
  const problem = codeCriterionProblem(probe.criterion);
  if (!problem) return probe;
  return {
    ...probe,
    criterion: {
      ...probe.criterion,
      kind: "judge",
      note: `downgraded from code to judge: ${problem}`,
    },
  };
}

function userContent({ rule, contextWindow }) {
  return [
    `Rule (verbatim): ${rule.quote}`,
    `Category: ${rule.category}`,
    rule.why ? `Why it was extracted: ${rule.why}` : null,
    "",
    "Surrounding text from the system prompt:",
    contextWindow,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/**
 * genProbes({ rule, contextWindow, apiKey, model, provider, baseUrl, signal })
 *   -> { reasoning, probes, promptVersion, model, usage }
 */
export async function genProbes({
  rule,
  contextWindow,
  apiKey,
  model = "claude-opus-5",
  provider = "anthropic",
  baseUrl,
  signal,
}) {
  if (!rule?.quote) throw new Error("genProbes: rule.quote is required");

  const { text: system, version: promptVersion } = await loadPrompt("probe_gen");

  const response = await callMessages({
    provider,
    baseUrl,
    apiKey,
    signal,
    body: {
      model,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: userContent({ rule, contextWindow: contextWindow ?? "" }) }],
      tools: [SUBMIT_PROBES],
      tool_choice: { type: "tool", name: SUBMIT_PROBES.name },
    },
  });

  const input = toolInputOf(response, SUBMIT_PROBES.name);
  if (!input) throw new Error(`probe generation returned no submit_probes tool call for ${rule.id ?? rule.quote}`);

  const errs = validate(input, SUBMIT_PROBES.input_schema);
  if (errs.length) throw new Error(`submit_probes failed validation: ${errs.join("; ")}`);

  return {
    reasoning: input.reasoning,
    probes: input.probes.map(downgrade),
    promptVersion,
    model,
    usage: usageOf(response),
  };
}
