#!/usr/bin/env node
// Live smoke test. Not node:test — this one spends money, so it is a script you run by hand.
// The first two golden rules, runs=1: enough to prove one provider's whole pipeline
// (probe_gen -> bare/full -> judge -> classify) actually talks to a real endpoint.
//
//   # DeepSeek under test, DeepSeek reasoning model as judge (verified pair 2026-09-05):
//   DEEPSEEK_API_KEY=... node test/smoke.mjs --provider openai --key-env DEEPSEEK_API_KEY \
//     --target deepseek-chat --judge deepseek-reasoner
//
//   # DeepSeek under test, Claude as judge (needs both keys):
//   DEEPSEEK_API_KEY=... ANTHROPIC_API_KEY=... node test/smoke.mjs \
//     --provider openai --key-env DEEPSEEK_API_KEY --target deepseek-chat \
//     --judge-provider anthropic --judge-key-env ANTHROPIC_API_KEY --judge claude-opus-5
//
//   # the original Anthropic path, unchanged:
//   ANTHROPIC_API_KEY=... node test/smoke.mjs --target claude-fable-5-1
//
// The judge may never be the model under test. On api.deepseek.com, --judge deepseek-chat
// against --target deepseek-chat resolves to deepseek-reasoner instead (printed below as
// "judge model"); on any other OpenAI-compatible endpoint it is refused before any request,
// because there is no known second model there to substitute.
//
// The corpus is the 92K-token golden prompt. If the target model's context window is smaller
// than that, the `full` call will 400 — that is the corpus, not a bug in the provider layer;
// audit a shorter prompt with cli.mjs instead.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { auditRules } from "../src/audit.mjs";
import { isProvider } from "../src/api.mjs";

const DIR = new URL("./golden/", import.meta.url);
const SOURCE = new URL("fable51.md", DIR);
const EXPECTED = new URL("expected.json", DIR);
const OUT = new URL("smoke.report.json", DIR); // *.report.json is gitignored
const RULE_COUNT = 2;

const DEFAULT_KEY_ENV = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };
const FLAGS = new Set([
  "--provider",
  "--base-url",
  "--key-env",
  "--target",
  "--judge",
  "--judge-provider",
  "--judge-base-url",
  "--judge-key-env",
]);

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!FLAGS.has(a)) throw new Error(`unknown option: ${a}`);
    const v = argv[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    opts[a.replace(/^--/, "")] = v;
  }
  for (const flag of ["provider", "judge-provider"]) {
    const v = opts[flag];
    if (v != null && !isProvider(v)) throw new Error(`--${flag} must be anthropic or openai, got ${v}`);
  }
  return opts;
}

function pad(s, n) {
  const str = String(s ?? "");
  return str.length >= n ? str : str + " ".repeat(n - str.length);
}

async function main(argv) {
  const opts = parseArgs(argv);
  const provider = opts.provider ?? "anthropic";
  const targetModel = opts.target;
  if (!targetModel) throw new Error("--target is required");

  const keyEnv = opts["key-env"] ?? DEFAULT_KEY_ENV[provider];
  const apiKey = process.env[keyEnv];
  if (!apiKey) throw new Error(`${keyEnv} is not set`);

  const judgeProvider = opts["judge-provider"] ?? provider;
  const judgeKeyEnv =
    opts["judge-key-env"] ?? (judgeProvider === provider ? keyEnv : DEFAULT_KEY_ENV[judgeProvider]);
  const judgeApiKey = process.env[judgeKeyEnv];
  if (!judgeApiKey) throw new Error(`${judgeKeyEnv} is not set (needed for probe_gen and judge)`);

  const expected = JSON.parse(await readFile(EXPECTED, "utf8"));
  const raw = await readFile(SOURCE).catch(() => {
    throw new Error(`${expected.source} is missing; run the golden test once to fetch it`);
  });
  const md5 = createHash("md5").update(raw).digest("hex");
  if (md5 !== expected.sourceMd5) {
    throw new Error(`${expected.source} changed: md5 ${md5} != ${expected.sourceMd5}`);
  }
  const promptText = raw.toString("utf8");

  const rules = expected.rules.slice(0, RULE_COUNT).map((r) => ({
    id: r.id,
    quote: r.quote,
    category: "mechanical",
    testable: true,
    why: "smoke rule, hand-picked",
  }));
  for (const r of rules) {
    if (!promptText.includes(r.quote)) throw new Error(`${r.id}: quote is not in the corpus`);
  }

  process.stderr.write(
    `smoke: ${rules.length} rules, runs 1, target ${targetModel} @ ${provider}, judge @ ${judgeProvider}\n` +
      `corpus ${expected.source}, ~${Math.round(promptText.length / 4)} tokens estimated\n`,
  );

  const report = await auditRules({
    promptText,
    rules,
    apiKey,
    targetModel,
    judgeModel: opts.judge,
    provider,
    baseUrl: opts["base-url"],
    judgeProvider,
    judgeBaseUrl: opts["judge-base-url"],
    judgeApiKey,
    runs: 1,
    onProgress: (evt) =>
      process.stderr.write(`[${evt.done}/${evt.total}] ${pad(evt.stage, 10)} ${pad(evt.ruleId, 4)}\n`),
    extraMeta: { smoke: true, goldenSource: expected.source, goldenSourceMd5: md5 },
  });

  await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const q = report.summary.byQuadrant;
  const lines = [
    "",
    `judge model: ${report.meta.judgeModel}`,
    `redundant ${q.redundant} / effective ${q.effective} / ineffective ${q.ineffective} / ` +
      `harmful ${q.harmful} / unknown ${q.unknown} / untested ${q.untested}`,
    `${pad("id", 6)}${pad("expected", 14)}got`,
    "-".repeat(34),
  ];
  const got = new Map(report.rules.map((r) => [r.id, r.quadrant]));
  for (const r of expected.rules.slice(0, RULE_COUNT)) {
    lines.push(`${pad(r.id, 6)}${pad(r.expected, 14)}${got.get(r.id)}`);
  }
  // The expected column is Claude's ground truth. On another model a mismatch is a finding
  // about that model's disposition, not necessarily a failure — hence no assertion here.
  lines.push("", `report: ${OUT.pathname}`, "");
  process.stderr.write(lines.join("\n"));
  return 0;
}

process.exitCode = await main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`smoke failed: ${err.message}\n`);
  return 1;
});
