import test from "node:test";
import assert from "node:assert/strict";
import {
  SUBMIT_RULES,
  SUBMIT_PROBES,
  SUBMIT_VERDICT,
  validate,
  assertQuotesExact,
} from "../src/schemas.mjs";
import { parsePrompt, loadPrompt, promptVersions } from "../src/prompts.mjs";

const okRules = {
  reasoning: "a system prompt with two rules",
  rules: [
    { quote: "Be concise.", category: "mechanical", testable: true, why: "output shape" },
    { quote: "The tool is called search.", category: "environmental", testable: false, why: "deployment fact" },
  ],
};

test("validate accepts a well-formed submit_rules payload", () => {
  assert.deepEqual(validate(okRules, SUBMIT_RULES.input_schema), []);
});

test("validate reports missing required fields", () => {
  const errs = validate({ rules: [] }, SUBMIT_RULES.input_schema);
  assert.ok(errs.some((e) => e.includes("reasoning")));
});

test("validate rejects a category outside the enum", () => {
  const bad = { ...okRules, rules: [{ ...okRules.rules[0], category: "vibes" }] };
  const errs = validate(bad, SUBMIT_RULES.input_schema);
  assert.ok(errs.some((e) => e.includes("not in enum")));
});

test("validate enforces quote maxLength", () => {
  const bad = { ...okRules, rules: [{ ...okRules.rules[0], quote: "x".repeat(401) }] };
  assert.ok(validate(bad, SUBMIT_RULES.input_schema).some((e) => e.includes("maxLength")));
});

test("validate rejects a non-boolean testable", () => {
  const bad = { ...okRules, rules: [{ ...okRules.rules[0], testable: "true" }] };
  assert.ok(validate(bad, SUBMIT_RULES.input_schema).some((e) => e.includes("expected boolean")));
});

test("validate enforces submit_probes min/max items", () => {
  const probe = {
    message: "hi",
    criterion: { kind: "code", description: "no bullets", measure: "bullets", satisfied_when: "==0" },
  };
  assert.deepEqual(validate({ reasoning: "r", probes: [probe] }, SUBMIT_PROBES.input_schema), []);
  assert.ok(validate({ reasoning: "r", probes: [] }, SUBMIT_PROBES.input_schema).some((e) => e.includes("minItems")));
  const four = [probe, probe, probe, probe];
  assert.ok(validate({ reasoning: "r", probes: four }, SUBMIT_PROBES.input_schema).some((e) => e.includes("maxItems")));
});

test("validate rejects an unknown measure name", () => {
  const bad = {
    reasoning: "r",
    probes: [{ message: "hi", criterion: { kind: "code", description: "d", measure: "vibes" } }],
  };
  assert.ok(validate(bad, SUBMIT_PROBES.input_schema).some((e) => e.includes("not in enum")));
});

test("validate accepts and rejects submit_verdict payloads", () => {
  assert.deepEqual(
    validate({ reasoning: "r", a_exhibits: "yes", b_exhibits: "unknown" }, SUBMIT_VERDICT.input_schema),
    [],
  );
  assert.ok(
    validate({ reasoning: "r", a_exhibits: "maybe", b_exhibits: "no" }, SUBMIT_VERDICT.input_schema).length > 0,
  );
});

test("validate rejects a non-object and a non-array", () => {
  assert.ok(validate("nope", SUBMIT_RULES.input_schema).some((e) => e.includes("expected object")));
  assert.ok(
    validate({ reasoning: "r", rules: "nope" }, SUBMIT_RULES.input_schema).some((e) => e.includes("expected array")),
  );
});

test("assertQuotesExact flags quotes that are not verbatim substrings", () => {
  const text = "Be concise. Never use emoji.";
  const marked = assertQuotesExact(
    [{ quote: "Be concise." }, { quote: "Be Concise." }, { quote: "Never  use emoji." }],
    text,
  );
  assert.deepEqual(
    marked.map((r) => r.quoteFound),
    [true, false, false],
  );
});

test("assertQuotesExact does not mutate its input", () => {
  const rules = [{ quote: "a" }];
  const marked = assertQuotesExact(rules, "abc");
  assert.equal("quoteFound" in rules[0], false);
  assert.equal(marked[0].quoteFound, true);
});

test("parsePrompt strips the header comment and reads the version", () => {
  const raw = "<!-- prompt: extract | version: 7 | model: x -->\nBody line one.\n";
  assert.deepEqual(parsePrompt(raw), { text: "Body line one.", version: 7 });
});

test("parsePrompt tolerates a file with no header", () => {
  assert.deepEqual(parsePrompt("  Just a body.  "), { text: "Just a body.", version: null });
});

test("the three shipped prompts load, are versioned, and carry no header comment", async () => {
  for (const name of ["extract", "probe_gen", "judge"]) {
    const p = await loadPrompt(name);
    assert.equal(typeof p.version, "number", `${name} has a version`);
    assert.ok(p.text.length > 100, `${name} has a body`);
    assert.ok(!p.text.startsWith("<!--"), `${name} header stripped`);
  }
  assert.deepEqual(Object.keys(await promptVersions()).sort(), ["extract", "judge", "probe_gen"]);
});

test("loadPrompt rejects an unsafe prompt name", async () => {
  await assert.rejects(() => loadPrompt("../secrets"), /bad prompt name/);
});
