// JSON Schemas for the three LLM judgments. Used as tool input_schema with forced tool_choice,
// so the API validates shape server-side; validate() is a belt-and-braces check on our side.

export const SUBMIT_RULES = {
  name: "submit_rules",
  description: "Return every rule found in the system prompt.",
  input_schema: {
    type: "object",
    required: ["reasoning", "rules"],
    properties: {
      reasoning: { type: "string" },
      rules: {
        type: "array",
        items: {
          type: "object",
          required: ["quote", "category", "testable", "why"],
          properties: {
            quote: { type: "string", maxLength: 400 },
            category: { type: "string", enum: ["mechanical", "dispositional", "environmental", "mixed"] },
            testable: { type: "boolean" },
            why: { type: "string" },
          },
        },
      },
    },
  },
};

export const SUBMIT_PROBES = {
  name: "submit_probes",
  description: "Return 1-3 probes for the rule.",
  input_schema: {
    type: "object",
    required: ["reasoning", "probes"],
    properties: {
      reasoning: { type: "string" },
      probes: {
        type: "array", minItems: 1, maxItems: 3,
        items: {
          type: "object",
          required: ["message", "criterion"],
          properties: {
            message: { type: "string" },
            criterion: {
              type: "object",
              required: ["kind", "description"],
              properties: {
                kind: { type: "string", enum: ["code", "judge"] },
                measure: { type: "string", enum: ["bullets", "headers", "bold", "tables", "contains", "absent", "tool_call"] },
                arg: { type: "string" },
                satisfied_when: { type: "string", enum: ["==0", ">0", "present", "absent"] },
                description: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

export const SUBMIT_VERDICT = {
  name: "submit_verdict",
  description: "Return whether each response follows the rule.",
  input_schema: {
    type: "object",
    required: ["reasoning", "a_exhibits", "b_exhibits"],
    properties: {
      reasoning: { type: "string" },
      a_exhibits: { type: "string", enum: ["yes", "no", "unknown"] },
      b_exhibits: { type: "string", enum: ["yes", "no", "unknown"] },
      note: { type: "string" },
    },
  },
};

// Minimal validator: type / required / enum / minItems / maxItems / maxLength. No deps.
export function validate(value, schema, path = "$") {
  const errs = [];
  const t = schema.type;
  if (t === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${path}: expected object`];
    for (const k of schema.required ?? []) if (!(k in value)) errs.push(`${path}.${k}: required`);
    for (const [k, sub] of Object.entries(schema.properties ?? {})) if (k in value) errs.push(...validate(value[k], sub, `${path}.${k}`));
  } else if (t === "array") {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    if (schema.minItems != null && value.length < schema.minItems) errs.push(`${path}: minItems ${schema.minItems}`);
    if (schema.maxItems != null && value.length > schema.maxItems) errs.push(`${path}: maxItems ${schema.maxItems}`);
    value.forEach((v, i) => errs.push(...validate(v, schema.items, `${path}[${i}]`)));
  } else if (t === "string") {
    if (typeof value !== "string") return [`${path}: expected string`];
    if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: not in enum`);
    if (schema.maxLength != null && value.length > schema.maxLength) errs.push(`${path}: maxLength ${schema.maxLength}`);
  } else if (t === "boolean") {
    if (typeof value !== "boolean") return [`${path}: expected boolean`];
  }
  return errs;
}

// Layer-A assertion: every quote must be an exact substring of the source text.
export function assertQuotesExact(rules, text) {
  return rules.map((r) => ({ ...r, quoteFound: text.includes(r.quote) }));
}
