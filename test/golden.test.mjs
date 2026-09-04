// Golden set. Costs money and needs a key, so it is gated: GOLDEN=1 plus ANTHROPIC_API_KEY.
// It does not run extract() — the seven rules and their quadrants come from the 2026-09-03
// manual experiment, so what is under test here is the probe/run/judge/classify pipeline.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { auditRules } from "../src/audit.mjs";

const DIR = new URL("./golden/", import.meta.url);
const SOURCE = new URL("fable51.md", DIR);
const EXPECTED = new URL("expected.json", DIR);
const LAST_RUN = new URL("last-run.report.json", DIR);

const enabled = process.env.GOLDEN === "1";
const hasKey = !!process.env.ANTHROPIC_API_KEY;
const skip = !enabled
  ? "set GOLDEN=1 to run the golden set (costs money)"
  : !hasKey
    ? "ANTHROPIC_API_KEY is not set"
    : false;

function md5(buf) {
  return createHash("md5").update(buf).digest("hex");
}

function pad(s, n) {
  const str = String(s ?? "");
  return str.length >= n ? str : str + " ".repeat(n - str.length);
}

test("golden set: the seven Fable 5.1 rules land in their known quadrants", { skip }, async (t) => {
  const raw = await readFile(SOURCE);
  const expected = JSON.parse(await readFile(EXPECTED, "utf8"));

  // Ground-truth anchor. The expected quadrants describe THIS corpus; if the file moved,
  // every assertion below is meaningless, so stop here rather than report a false result.
  const actualMd5 = md5(raw);
  assert.equal(
    actualMd5,
    expected.sourceMd5,
    `${expected.source} changed: md5 ${actualMd5} != expected ${expected.sourceMd5}. ` +
      "The recorded quadrants no longer describe this file; re-run the manual experiment.",
  );

  const promptText = raw.toString("utf8");
  const rules = expected.rules.map((r) => ({
    id: r.id,
    quote: r.quote,
    category: "mechanical",
    testable: true,
    why: "golden set rule, hand-picked",
  }));

  // Every quote must still be locatable, otherwise probe_gen gets no context window.
  for (const r of rules) {
    assert.ok(promptText.includes(r.quote), `${r.id}: quote is not a verbatim substring of the corpus`);
  }

  const runs = Number(process.env.GOLDEN_RUNS ?? 3);
  assert.ok(Number.isInteger(runs) && runs >= 1, `GOLDEN_RUNS must be a positive integer, got ${process.env.GOLDEN_RUNS}`);

  const report = await auditRules({
    promptText,
    rules,
    apiKey: process.env.ANTHROPIC_API_KEY,
    targetModel: expected.targetModel,
    runs,
    onProgress: (evt) =>
      process.stderr.write(`[${evt.done}/${evt.total}] ${pad(evt.stage, 10)} ${pad(evt.ruleId, 4)}\n`),
    extraMeta: { goldenSource: expected.source, goldenSourceMd5: actualMd5 },
  });

  // Written before the assertions so a failing run still leaves the evidence behind.
  await writeFile(LAST_RUN, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const got = new Map(report.rules.map((r) => [r.id, r.quadrant]));
  const lines = [
    "",
    `golden set — target ${expected.targetModel}, runs ${runs}, judge ${report.meta.judgeModel}`,
    `${pad("id", 6)}${pad("expected", 14)}${pad("got", 14)}ok`,
    "-".repeat(44),
  ];
  for (const r of expected.rules) {
    const actual = got.get(r.id);
    lines.push(`${pad(r.id, 6)}${pad(r.expected, 14)}${pad(actual, 14)}${actual === r.expected ? "ok" : "MISMATCH"}`);
  }
  lines.push("", `report: ${LAST_RUN.pathname}`, "");
  process.stderr.write(lines.join("\n"));

  for (const r of expected.rules) {
    await t.test(`${r.id} -> ${r.expected}`, () => {
      assert.equal(
        got.get(r.id),
        r.expected,
        `${r.id} expected ${r.expected}, got ${got.get(r.id)} (${r.note})`,
      );
    });
  }
});
