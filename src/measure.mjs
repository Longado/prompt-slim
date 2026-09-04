// Pure surface-form measurements. No network, no LLM. This is the "code" half of the
// LLM-vs-code split: anything visible in the shape of the text is counted here, never judged.

// Chinese ordinals ("一、" "二、") are bullets too — an English-only bullet regex silently
// scores a fully formatted Chinese answer as "no formatting". Known lesson, do not drop.
const BULLET_RE = /^\s*([-*+]|\d+[.)]|[一二三四五六七八九十]+、)\s?/;
const HEADER_RE = /^\s*#{1,6}\s/;
const BOLD_RE = /\*\*[^*\n]+\*\*/g;
const PIPE_RE = /\|/g;

// A probe runner supplies no tools, so an attempted call shows up as text in one of these forms.
const TOOL_CALL_RE = /(\{?antml:invoke|<invoke\b|antml:function_calls|"type"\s*:\s*"tool_use")/;

/** Which satisfied_when values are meaningful for each measure. Shared with probe.mjs. */
export const MEASURE_SATISFIED_WHEN = Object.freeze({
  bullets: ["==0", ">0"],
  headers: ["==0", ">0"],
  bold: ["==0", ">0"],
  tables: ["==0", ">0"],
  contains: ["present"],
  absent: ["absent"],
  tool_call: ["present", "absent"],
});

/** Measures whose `arg` is a regular expression source and is therefore required. */
export const REGEX_MEASURES = Object.freeze(["contains", "absent"]);

function lines(text) {
  return text.split(/\r?\n/);
}

/**
 * measure(text, name, arg)
 *   bullets/headers/bold/tables -> number
 *   contains/absent             -> boolean: does the regex in `arg` appear (case-insensitive)
 *   tool_call                   -> boolean: does the text attempt a tool call
 * Throws on an unknown measure or an unusable regex; satisfies() turns that into "unknown".
 */
export function measure(text, measureName, arg) {
  const s = typeof text === "string" ? text : "";
  switch (measureName) {
    case "bullets":
      return lines(s).filter((l) => BULLET_RE.test(l)).length;
    case "headers":
      return lines(s).filter((l) => HEADER_RE.test(l)).length;
    case "bold":
      return (s.match(BOLD_RE) ?? []).length;
    case "tables":
      return lines(s).filter((l) => (l.match(PIPE_RE) ?? []).length >= 2).length;
    case "contains":
    case "absent": {
      if (typeof arg !== "string" || arg === "") throw new Error(`measure ${measureName} needs a regex arg`);
      let re;
      try {
        re = new RegExp(arg, "i");
      } catch (err) {
        throw new Error(`measure ${measureName}: bad regex ${JSON.stringify(arg)}: ${err.message}`);
      }
      return re.test(s);
    }
    case "tool_call":
      return TOOL_CALL_RE.test(s);
    default:
      throw new Error(`unknown measure: ${String(measureName)}`);
  }
}

/**
 * satisfies(criterion, text) -> "yes" | "no" | "unknown".
 * "unknown" whenever the text is empty or the criterion is not a usable code criterion —
 * an unmeasurable probe must never be scored as a compliance failure.
 */
export function satisfies(criterion, text) {
  if (typeof text !== "string" || text.trim() === "") return "unknown";
  if (!criterion || typeof criterion !== "object") return "unknown";
  if (criterion.kind !== "code") return "unknown";

  const { measure: name, arg, satisfied_when: when } = criterion;
  const allowed = MEASURE_SATISFIED_WHEN[name];
  if (!allowed || !allowed.includes(when)) return "unknown";

  let value;
  try {
    value = measure(text, name, arg);
  } catch {
    return "unknown";
  }

  switch (when) {
    case "==0":
      return value === 0 ? "yes" : "no";
    case ">0":
      return value > 0 ? "yes" : "no";
    case "present":
      return value === true ? "yes" : "no";
    case "absent":
      return value === false ? "yes" : "no";
    default:
      return "unknown";
  }
}
