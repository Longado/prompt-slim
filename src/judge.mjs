// LLM judgment #3 of 3: does each of two responses follow one rule.
// Presented as a blind pair in random order, answered as two independent binaries.

import { callMessages, toolUseOf, usageOf, ZERO_USAGE } from "./api.mjs";
import { loadPrompt } from "./prompts.mjs";
import { SUBMIT_VERDICT, validate } from "./schemas.mjs";

const MAX_TOKENS = 2048;

function usable(text, truncated) {
  return typeof text === "string" && text.trim() !== "" && !truncated;
}

function userContent({ rule, criterion, message, aText, bText }) {
  return [
    `Rule: ${rule.quote}`,
    `What following it looks like: ${criterion?.description ?? "(none given)"}`,
    "",
    "User message:",
    message,
    "",
    "Response A:",
    aText,
    "",
    "Response B:",
    bText,
  ].join("\n");
}

const UNKNOWN = (note) => ({
  bareExhibits: "unknown",
  fullExhibits: "unknown",
  reasoning: "",
  note,
  order: null,
  usage: { ...ZERO_USAGE },
  skipped: true,
});

/**
 * judgePair({ rule, criterion, message, bareText, fullText, bareTruncated, fullTruncated,
 *             apiKey, judgeModel, signal })
 *   -> { bareExhibits, fullExhibits, reasoning, note, order, usage }
 * Either side empty or cut off -> no call at all, straight to unknown: a judge asked about a
 * truncated response answers confidently and wrongly.
 */
export async function judgePair({
  rule,
  criterion,
  message,
  bareText,
  fullText,
  bareTruncated = false,
  fullTruncated = false,
  apiKey,
  judgeModel,
  signal,
}) {
  if (!usable(bareText, bareTruncated)) return UNKNOWN("bare response empty or truncated; not judged");
  if (!usable(fullText, fullTruncated)) return UNKNOWN("full response empty or truncated; not judged");

  const { text: system } = await loadPrompt("judge");

  // Random A/B assignment so the judge cannot learn a position habit.
  const bareIsA = Math.random() < 0.5;
  const order = bareIsA ? { a: "bare", b: "full" } : { a: "full", b: "bare" };

  const response = await callMessages({
    apiKey,
    signal,
    body: {
      model: judgeModel,
      max_tokens: MAX_TOKENS,
      system,
      messages: [
        {
          role: "user",
          content: userContent({
            rule,
            criterion,
            message,
            aText: bareIsA ? bareText : fullText,
            bText: bareIsA ? fullText : bareText,
          }),
        },
      ],
      tools: [SUBMIT_VERDICT],
      tool_choice: { type: "tool", name: SUBMIT_VERDICT.name },
    },
  });

  const block = toolUseOf(response, SUBMIT_VERDICT.name);
  if (!block) throw new Error("judge returned no submit_verdict tool call");

  const errs = validate(block.input, SUBMIT_VERDICT.input_schema);
  if (errs.length) throw new Error(`submit_verdict failed validation: ${errs.join("; ")}`);

  const { a_exhibits, b_exhibits, reasoning, note } = block.input;

  return {
    bareExhibits: bareIsA ? a_exhibits : b_exhibits,
    fullExhibits: bareIsA ? b_exhibits : a_exhibits,
    reasoning,
    note: note ?? "",
    order,
    usage: usageOf(response),
  };
}
