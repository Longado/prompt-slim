// Pure classification. The four-quadrant table from README.md, and vote aggregation.
// No LLM anywhere in this file: the model produces two binary observations, code does the rest.

export const QUADRANTS = Object.freeze(["redundant", "effective", "ineffective", "harmful", "unknown"]);

const VERDICTS = new Set(["yes", "no", "unknown"]);

/**
 * bare = does the naked model already do it, full = does it with your prompt loaded.
 *   yes/yes -> redundant    (candidate deadweight)
 *   no/yes  -> effective
 *   no/no   -> ineffective  (rule may be dead, or the probe missed)
 *   yes/no  -> harmful      (the prompt may be breaking a good default)
 */
export function quadrant(bareExhibits, fullExhibits) {
  if (!VERDICTS.has(bareExhibits) || !VERDICTS.has(fullExhibits)) return "unknown";
  if (bareExhibits === "unknown" || fullExhibits === "unknown") return "unknown";
  if (bareExhibits === "yes" && fullExhibits === "yes") return "redundant";
  if (bareExhibits === "no" && fullExhibits === "yes") return "effective";
  if (bareExhibits === "no" && fullExhibits === "no") return "ineffective";
  return "harmful"; // yes / no
}

/** Plain majority vote. A tie — including an empty list — is "unknown", never a coin flip. */
export function majority(values) {
  if (!Array.isArray(values) || values.length === 0) return "unknown";
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = null;
  let bestN = 0;
  let tied = false;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
      tied = false;
    } else if (n === bestN) {
      tied = true;
    }
  }
  return tied ? "unknown" : best;
}

/**
 * A rule's quadrant is only the probes' quadrant when every probe agrees.
 * Disagreement is reported as disagreement, not averaged into a verdict.
 */
export function ruleQuadrant(probeQuadrants) {
  if (!Array.isArray(probeQuadrants) || probeQuadrants.length === 0) {
    return { quadrant: "unknown", note: "no probes" };
  }
  const distinct = new Set(probeQuadrants);
  if (distinct.size === 1) return { quadrant: probeQuadrants[0] };
  return { quadrant: "unknown", note: "probes disagree" };
}
