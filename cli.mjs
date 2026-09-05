#!/usr/bin/env node
// prompt-slim CLI. Progress goes to stderr, the report goes to stdout (or --out).

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { audit } from "./src/audit.mjs";
import { extractRules } from "./src/extract.mjs";
import { isProvider } from "./src/api.mjs";

const USAGE = `prompt-slim — 提示词瘦身

Usage:
  node cli.mjs <file> --target <model> [options]

Arguments:
  <file>                 path to the system prompt to audit (plain text or markdown)

Options:
  --target <model>       model under test, e.g. claude-sonnet-5   (required)
  --judge <model>        judge model. anthropic: default claude-opus-5, falls back to
                         claude-sonnet-5 when it equals --target. openai: defaults to
                         deepseek-reasoner on api.deepseek.com, required elsewhere
  --provider <name>      anthropic | openai (default anthropic). "openai" means any
                         OpenAI-compatible /chat/completions endpoint
  --base-url <url>       API base (default https://api.anthropic.com for anthropic,
                         https://api.deepseek.com for openai)
  --key-env <ENV>        env var holding the key (default ANTHROPIC_API_KEY for
                         anthropic, OPENAI_API_KEY for openai)
  --judge-provider <n>   provider for extract / probe_gen / judge (default: same as --provider)
  --judge-base-url <url> base URL for those calls (default: same as --base-url)
  --judge-key-env <ENV>  env var for their key (default: same as --key-env)
  --runs <n>             repetitions per probe, majority vote (default 1)
  --out <file>           write the JSON report here instead of stdout
  --rules-only           extract rules and print the table; no probes, no cost
  -h, --help             show this message

Environment:
  ANTHROPIC_API_KEY      default key for --provider anthropic
  OPENAI_API_KEY         default key for --provider openai (override with --key-env)

Examples:
  node cli.mjs prompt.md --target claude-sonnet-5
  node cli.mjs prompt.md --target claude-sonnet-5 --runs 3 --out report.json
  node cli.mjs prompt.md --target claude-sonnet-5 --rules-only
  DEEPSEEK_API_KEY=... node cli.mjs prompt.md --provider openai --key-env DEEPSEEK_API_KEY \
    --target deepseek-chat --judge deepseek-reasoner
`;

const FLAGS_WITH_VALUE = new Set([
  "--target",
  "--judge",
  "--runs",
  "--out",
  "--provider",
  "--base-url",
  "--key-env",
  "--judge-provider",
  "--judge-base-url",
  "--judge-key-env",
]);

const DEFAULT_KEY_ENV = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };

function assertProvider(flag, v) {
  if (!isProvider(v)) throw new Error(`${flag} must be anthropic or openai, got ${v}`);
  return v;
}

export function parseArgs(argv) {
  const opts = {
    file: null,
    target: null,
    judge: null,
    runs: 1,
    out: null,
    rulesOnly: false,
    help: false,
    provider: "anthropic",
    baseUrl: null,
    keyEnv: null,
    judgeProvider: null,
    judgeBaseUrl: null,
    judgeKeyEnv: null,
  };
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
      if (a === "--provider") opts.provider = assertProvider(a, v);
      if (a === "--base-url") opts.baseUrl = v;
      if (a === "--key-env") opts.keyEnv = v;
      if (a === "--judge-provider") opts.judgeProvider = assertProvider(a, v);
      if (a === "--judge-base-url") opts.judgeBaseUrl = v;
      if (a === "--judge-key-env") opts.judgeKeyEnv = v;
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

  const keyEnv = opts.keyEnv ?? DEFAULT_KEY_ENV[opts.provider];
  const apiKey = process.env[keyEnv];
  if (!apiKey) {
    process.stderr.write(`${keyEnv} is not set\n`);
    return 2;
  }

  const judgeProvider = opts.judgeProvider ?? opts.provider;
  const judgeKeyEnv = opts.judgeKeyEnv ?? (judgeProvider === opts.provider ? keyEnv : DEFAULT_KEY_ENV[judgeProvider]);
  const judgeApiKey = process.env[judgeKeyEnv];
  if (!judgeApiKey) {
    process.stderr.write(`${judgeKeyEnv} is not set (needed for extract / probe_gen / judge)\n`);
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
      const { rules } = await extractRules({
        promptText,
        apiKey: judgeApiKey,
        provider: judgeProvider,
        baseUrl: opts.judgeBaseUrl ?? (judgeProvider === opts.provider ? opts.baseUrl ?? undefined : undefined),
        model: judgeProvider === "openai" ? (opts.judge ?? opts.target ?? undefined) : undefined,
        signal: controller.signal,
      });
      printRulesTable(rules);
      return 0;
    }

    const report = await audit({
      promptText,
      apiKey,
      targetModel: opts.target,
      judgeModel: opts.judge ?? undefined,
      provider: opts.provider,
      baseUrl: opts.baseUrl ?? undefined,
      judgeProvider,
      judgeBaseUrl: opts.judgeBaseUrl ?? undefined,
      judgeApiKey,
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
