import test from "node:test";
import assert from "node:assert/strict";
import { measure, satisfies, MEASURE_SATISFIED_WHEN } from "../src/measure.mjs";

test("bullets counts dashes, stars, plus and numbered items", () => {
  const text = "- one\n* two\n+ three\n1. four\n2) five\nplain line";
  assert.equal(measure(text, "bullets"), 5);
});

test("bullets counts Chinese ordinals — an English-only regex would score this as unformatted", () => {
  const text = "一、第一点\n二、第二点\n十、第十点\n这是正文,不是列表。";
  assert.equal(measure(text, "bullets"), 3);
});

test("bullets returns 0 for prose with no list at all", () => {
  const text = "这是一段普通的中文回复,没有任何列表。\nIt continues in plain prose across two lines.";
  assert.equal(measure(text, "bullets"), 0);
});

test("bullets tolerates leading indentation", () => {
  assert.equal(measure("   - indented\n\t* tabbed", "bullets"), 2);
});

test("headers counts markdown headings only", () => {
  const text = "# One\n## Two\n###### Six\n####### seven hashes is not a heading\nnot a heading #";
  assert.equal(measure(text, "headers"), 3);
});

test("bold counts double-star spans", () => {
  assert.equal(measure("**a** and **b c** and *not bold*", "bold"), 2);
  assert.equal(measure("nothing bold here", "bold"), 0);
});

test("tables counts lines with two or more pipes", () => {
  const text = "| a | b |\n|---|---|\n| 1 | 2 |\nplain | single pipe";
  assert.equal(measure(text, "tables"), 3);
});

test("contains and absent both report whether the pattern appears, case-insensitively", () => {
  assert.equal(measure("Honestly, I think so.", "contains", "honestly"), true);
  assert.equal(measure("I think so.", "contains", "honestly"), false);
  assert.equal(measure("straightforward", "absent", "genuinely|honestly|straightforward"), true);
  assert.equal(measure("nothing banned here", "absent", "genuinely|honestly"), false);
});

test("tool_call detects the antml invoke text form", () => {
  assert.equal(measure('{antml:invoke name="create_file"}', "tool_call"), true);
  assert.equal(measure("<invoke name=\"web_search\">", "tool_call"), true);
  assert.equal(measure("antml:function_calls", "tool_call"), true);
  assert.equal(measure('{"type": "tool_use", "name": "x"}', "tool_call"), true);
  assert.equal(measure("I would search the web for that, but I have no tools here.", "tool_call"), false);
});

test("measure treats a non-string as empty text", () => {
  assert.equal(measure(null, "bullets"), 0);
  assert.equal(measure(undefined, "tool_call"), false);
});

test("measure throws on an unknown measure and on an unusable regex arg", () => {
  assert.throws(() => measure("x", "vibes"), /unknown measure/);
  assert.throws(() => measure("x", "contains"), /needs a regex arg/);
  assert.throws(() => measure("x", "contains", "([unclosed"), /bad regex/);
});

test("satisfies maps counts to yes/no through satisfied_when", () => {
  const noBullets = { kind: "code", measure: "bullets", satisfied_when: "==0", description: "d" };
  assert.equal(satisfies(noBullets, "just prose"), "yes");
  assert.equal(satisfies(noBullets, "- a bullet"), "no");

  const someBullets = { kind: "code", measure: "bullets", satisfied_when: ">0", description: "d" };
  assert.equal(satisfies(someBullets, "- a bullet"), "yes");
  assert.equal(satisfies(someBullets, "just prose"), "no");
});

test("satisfies maps present/absent for contains, absent and tool_call", () => {
  const c = { kind: "code", measure: "contains", arg: "sorry", satisfied_when: "present", description: "d" };
  assert.equal(satisfies(c, "Sorry, I cannot."), "yes");
  assert.equal(satisfies(c, "Sure thing."), "no");

  const a = { kind: "code", measure: "absent", arg: "honestly", satisfied_when: "absent", description: "d" };
  assert.equal(satisfies(a, "Here is what I think."), "yes");
  assert.equal(satisfies(a, "Honestly, no."), "no");

  const t = { kind: "code", measure: "tool_call", satisfied_when: "present", description: "d" };
  assert.equal(satisfies(t, '{antml:invoke name="create_file"}'), "yes");
  assert.equal(satisfies(t, "here is the post, inline"), "no");
});

test("satisfies returns unknown for empty text, judge criteria, and malformed criteria", () => {
  const c = { kind: "code", measure: "bullets", satisfied_when: "==0", description: "d" };
  assert.equal(satisfies(c, ""), "unknown");
  assert.equal(satisfies(c, "   \n "), "unknown");
  assert.equal(satisfies(c, null), "unknown");
  assert.equal(satisfies({ kind: "judge", description: "d" }, "some text"), "unknown");
  assert.equal(satisfies(null, "some text"), "unknown");
  assert.equal(satisfies({ kind: "code", measure: "bullets", satisfied_when: "present" }, "text"), "unknown");
  assert.equal(satisfies({ kind: "code", measure: "vibes", satisfied_when: "==0" }, "text"), "unknown");
  assert.equal(satisfies({ kind: "code", measure: "contains", satisfied_when: "present" }, "text"), "unknown");
});

test("MEASURE_SATISFIED_WHEN pins the measure/satisfied_when pairing the prompt promises", () => {
  assert.deepEqual(MEASURE_SATISFIED_WHEN.bullets, ["==0", ">0"]);
  assert.deepEqual(MEASURE_SATISFIED_WHEN.contains, ["present"]);
  assert.deepEqual(MEASURE_SATISFIED_WHEN.absent, ["absent"]);
  assert.deepEqual(MEASURE_SATISFIED_WHEN.tool_call, ["present", "absent"]);
});

test("bullets ignores hr lines and inline emphasis openers", () => {
  assert.equal(measure("---\nplain\n***", "bullets"), 0);
  assert.equal(measure("*emphasis* at line start\n**bold** too", "bullets"), 0);
  assert.equal(measure("- real item\n* another\n1. numbered\n一、中文", "bullets"), 4);
});
