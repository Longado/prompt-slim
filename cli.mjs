#!/usr/bin/env node
// prompt-slim CLI. Progress goes to stderr, the report goes to stdout (or --out).

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { audit } from "./src/audit.mjs";
import { extractRules } from "./src/extract.mjs";

const USAGE = `prompt-slim — 提示词瘦身

Usage:
  node cli.mjs <file> --target <model> [options]

Arguments:
  <file>                 path to the system prompt to audit (plain text or markdown)

Options:
  --target <model>       model under test, e.g. claude-sonnet-5   (required)
  --judge <model>        judge model (default claude-opus-5; falls back to
                         claude-sonnet-5 when it equals --target)
  --runs <n>             repetitions per probe, majority vote (default 1)
  --out <file>           write the JSON report here instead of stdout
  --rules-only           extract rules and print the table; no probes, no cost
  -h, --help             show this message

Environment:
  ANTHROPIC_API_KEY      required (except for --help)

Examples:
  node cli.mjs prompt.md --target claude-sonnet-5
  node cli.mjs prompt.md --target claude-sonnet-5 --runs 3 --out report.json
  node cli.mjs prompt.md --target claude-sonnet-5 --rules-only
`;

const FLAGS_WITH_VALUE = new Set(["--target", "--judge", "--runs", "--out"]);

export function parseArgs(argv) {
  const opts = { file: null, target: null, judge: null, runs: 1, out: null, rulesOnly: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      opts.help = true;
    } else if (a === "--rules-only") {
      opts.rulesOnly = true;
    } else if (FLAGS_WITH_VALUE.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      if (a === "--target") opts.target = v;
      if (a === "--judge") opts.judge = v;
      if (a === "--out") opts.out = v;
      if (a === "--runs") {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) throw new Error(`--runs must be a positive integer, got ${v}`);
        opts.runs = n;
      }
    } else if (a.startsWith("-")) {
      throw new Error(`unknown option: ${a}`);
    } else if (opts.file === null) {
      opts.file = a;
    } else {
      throw new Error(`unexpected argument: ${a}`);
    }
  }
  return opts;
}

function pad(s, n) {
  const str = String(s ?? "");
  return str.length >= n ? str : str + " ".repeat(n - str.length);
}

function clip(s, n) {
  const one = String(s ?? "").replace(/\s+/g, " ");
  return one.length <= n ? one : one.slice(0, n - 1) + "…";
}

function printRulesTable(rules, out = process.stdout) {
  out.write(`${pad("id", 6)}${pad("category", 15)}${pad("testable", 10)}quote\n`);
  out.write(`${"-".repeat(80)}\n`);
  for (const r of rules) {
    out.write(`${pad(r.id, 6)}${pad(r.category, 15)}${pad(r.testable ? "yes" : "no", 10)}${clip(r.quote, 70)}\n`);
  }
  out.write(`\n${rules.length} rules, ${rules.filter((r) => r.testable).length} testable\n`);
}

function progressLine(evt) {
  const t = evt.tokens ?? {};
  const spent = `in ${t.input ?? 0} / out ${t.output ?? 0} / cache_read ${t.cache_read ?? 0}`;
  process.stderr.write(`[${evt.done}/${evt.total}] ${pad(evt.stage, 10)} ${pad(evt.ruleId ?? "", 6)} ${spent}\n`);
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    return 2;
  }

  if (opts.help || argv.length === 0) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!opts.file) {
    process.stderr.write(`missing <file>\n\n${USAGE}`);
    return 2;
  }
  if (!opts.rulesOnly && !opts.target) {
    process.stderr.write(`missing --target <model>\n\n${USAGE}`);
    return 2;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    process.stderr.write("ANTHROPIC_API_KEY is not set\n");
    return 2;
  }

  let promptText;
  try {
    promptText = await readFile(opts.file, "utf8");
  } catch (err) {
    process.stderr.write(`cannot read ${opts.file}: ${err.message}\n`);
    return 2;
  }

  const controller = new AbortController();
  const onSigint = () => {
    process.stderr.write("\naborting…\n");
    controller.abort();
  };
  process.on("SIGINT", onSigint);

  try {
    if (opts.rulesOnly) {
      const { rules } = await extractRules({ promptText, apiKey, signal: controller.signal });
      printRulesTable(rules);
      return 0;
    }

    const report = await audit({
      promptText,
      apiKey,
      targetModel: opts.target,
      judgeModel: opts.judge ?? undefined,
      runs: opts.runs,
      onProgress: progressLine,
      signal: controller.signal,
    });

    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (opts.out) {
      await writeFile(opts.out, json, "utf8");
      process.stderr.write(`report written to ${opts.out}\n`);
    } else {
      process.stdout.write(json);
    }
    const q = report.summary.byQuadrant;
    process.stderr.write(
      `\nredundant ${q.redundant} / effective ${q.effective} / ineffective ${q.ineffective} / ` +
        `harmful ${q.harmful} / unknown ${q.unknown} / untested ${q.untested}\n` +
        `candidate deadweight ~${report.summary.candidateDeadweightTokens} tokens (approx)\n`,
    );
    return 0;
  } catch (err) {
    if (err?.name === "AbortError") {
      process.stderr.write("aborted\n");
      return 130;
    }
    process.stderr.write(`error: ${err.message}\n`);
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

// pathToFileURL, not string concat: the repo path may contain non-ASCII characters.
const invokedDirectly = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}

export { main, USAGE };
