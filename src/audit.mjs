// The loop. Every iteration, branch, vote and count here is plain code; the only model calls
// are genProbes (one per rule) and judgePair (one per judged run). Chain depth per rule <= 2.

import { addUsage, countTokens, ZERO_USAGE } from "./api.mjs";
import { promptVersions } from "./prompts.mjs";
import { extractRules } from "./extract.mjs";
import { genProbes, contextAround } from "./probe.mjs";
import { runProbe } from "./run.mjs";
import { judgePair } from "./judge.mjs";
import { satisfies } from "./measure.mjs";
import { quadrant, majority, ruleQuadrant } from "./classify.mjs";

const DEFAULT_JUDGE = "claude-opus-5";
const JUDGE_FALLBACK = "claude-sonnet-5";
const UNTESTED = "untested";

function abortError() {
  const e = new Error("audit aborted");
  e.name = "AbortError";
  return e;
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

/** Judge must not be the model under test. */
export function resolveJudgeModel(judgeModel, targetModel) {
  const chosen = judgeModel ?? DEFAULT_JUDGE;
  return chosen === targetModel ? JUDGE_FALLBACK : chosen;
}

/** Progress bookkeeping: one emit per step, with a total that grows as probes are discovered. */
function progressTracker(onProgress) {
  let done = 0;
  let total = 0;
  let tokens = { ...ZERO_USAGE };
  return {
    addTotal(n) {
      total += n;
    },
    spend(usage) {
      tokens = addUsage(tokens, usage);
    },
    get tokens() {
      return tokens;
    },
    emit(stage, ruleId) {
      done += 1;
      onProgress?.({ stage, ruleId, done, total, tokens });
    },
  };
}

function emptyByQuadrant() {
  return { redundant: 0, effective: 0, ineffective: 0, harmful: 0, unknown: 0, [UNTESTED]: 0 };
}

/**
 * Per-rule token share, apportioned by quote length against the whole prompt.
 * Deliberately crude — a rule's real cost is not its quote's character count — hence approx:true.
 */
function estimateRuleTokens(rule, promptText, promptTokens) {
  if (!promptText.length || !promptTokens) return 0;
  return Math.round((promptTokens * (rule.quote?.length ?? 0)) / promptText.length);
}

async function promptTokenCount({ promptText, apiKey, targetModel, signal }) {
  try {
    const n = await countTokens({
      apiKey,
      model: targetModel,
      messages: [{ role: "user", content: promptText }],
      signal,
    });
    if (Number.isFinite(n) && n > 0) return { promptTokens: n, source: "count_tokens" };
    return { promptTokens: Math.round(promptText.length / 4), source: "estimate" };
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    // Not fatal: the whole tokensByCategory block is already flagged approximate.
    return { promptTokens: Math.round(promptText.length / 4), source: "estimate", error: err.message };
  }
}

async function scoreOneRun({ rule, probe, promptText, apiKey, targetModel, judgeModel, signal, track }) {
  track.emit("run", rule.id);
  const result = await runProbe({ message: probe.message, promptText, apiKey, targetModel, signal });
  track.spend(result.bare.usage);
  track.spend(result.full.usage);

  if (probe.criterion?.kind === "code") {
    return {
      bare: result.bare,
      full: result.full,
      bareExhibits: satisfies(probe.criterion, result.bare.text),
      fullExhibits: satisfies(probe.criterion, result.full.text),
      how: "code",
      judge: null,
    };
  }

  checkAbort(signal);
  track.emit("judge", rule.id);
  const verdict = await judgePair({
    rule,
    criterion: probe.criterion,
    message: probe.message,
    bareText: result.bare.text,
    fullText: result.full.text,
    bareTruncated: result.bare.truncated,
    fullTruncated: result.full.truncated,
    apiKey,
    judgeModel,
    signal,
  });
  track.spend(verdict.usage);

  return {
    bare: result.bare,
    full: result.full,
    bareExhibits: verdict.bareExhibits,
    fullExhibits: verdict.fullExhibits,
    how: "judge",
    judge: { reasoning: verdict.reasoning, note: verdict.note, order: verdict.order },
  };
}

async function auditOneRule({ rule, promptText, apiKey, targetModel, judgeModel, runs, signal, track }) {
  checkAbort(signal);
  track.addTotal(1);
  track.emit("probe_gen", rule.id);

  const gen = await genProbes({
    rule,
    contextWindow: contextAround(promptText, rule.quote),
    apiKey,
    signal,
  });
  track.spend(gen.usage);

  // Now the real step count for this rule is known.
  for (const probe of gen.probes) {
    track.addTotal(runs + (probe.criterion?.kind === "judge" ? runs : 0));
  }

  const probeRecords = [];
  for (const probe of gen.probes) {
    const runResults = [];
    for (let i = 0; i < runs; i++) {
      checkAbort(signal);
      runResults.push(
        await scoreOneRun({ rule, probe, promptText, apiKey, targetModel, judgeModel, signal, track }),
      );
    }

    const bareExhibits =
      runs > 1 ? majority(runResults.map((r) => r.bareExhibits)) : runResults[0].bareExhibits;
    const fullExhibits =
      runs > 1 ? majority(runResults.map((r) => r.fullExhibits)) : runResults[0].fullExhibits;

    const first = runResults[0];
    probeRecords.push({
      message: probe.message,
      criterion: probe.criterion,
      how: first.how,
      bare: { text: first.bare.text, tokens: first.bare.usage, truncated: first.bare.truncated },
      full: { text: first.full.text, tokens: first.full.usage, truncated: first.full.truncated },
      bareExhibits,
      fullExhibits,
      quadrant: quadrant(bareExhibits, fullExhibits),
      runs: runResults.map((r) => ({
        bareExhibits: r.bareExhibits,
        fullExhibits: r.fullExhibits,
        judge: r.judge,
        bare: { text: r.bare.text, tokens: r.bare.usage, truncated: r.bare.truncated },
        full: { text: r.full.text, tokens: r.full.usage, truncated: r.full.truncated },
      })),
    });
  }

  const rolled = ruleQuadrant(probeRecords.map((p) => p.quadrant));
  return {
    ...rule,
    quadrant: rolled.quadrant,
    note: rolled.note,
    probeReasoning: gen.reasoning,
    probes: probeRecords,
  };
}

/**
 * auditRules({ promptText, rules, apiKey, targetModel, judgeModel, runs, onProgress, signal })
 * Rules come in already extracted (the golden test supplies them by hand).
 */
export async function auditRules({
  promptText,
  rules,
  apiKey,
  targetModel,
  judgeModel,
  runs = 1,
  onProgress,
  signal,
  extraMeta = {},
}) {
  if (typeof promptText !== "string" || promptText.trim() === "") {
    throw new Error("auditRules: promptText is empty");
  }
  if (!Array.isArray(rules)) throw new Error("auditRules: rules must be an array");
  if (!targetModel) throw new Error("auditRules: targetModel is required");
  if (!Number.isInteger(runs) || runs < 1) throw new Error("auditRules: runs must be a positive integer");

  const startedAt = new Date().toISOString();
  const resolvedJudge = resolveJudgeModel(judgeModel, targetModel);
  const versions = await promptVersions();
  const track = progressTracker(onProgress);

  const audited = [];
  for (const rule of rules) {
    checkAbort(signal);
    if (!rule.testable) {
      // Environmental / unprobeable: kept, never scored, still counted for tokens.
      audited.push({ ...rule, quadrant: UNTESTED, probes: [] });
      continue;
    }
    audited.push(
      await auditOneRule({
        rule,
        promptText,
        apiKey,
        targetModel,
        judgeModel: resolvedJudge,
        runs,
        signal,
        track,
      }),
    );
  }

  const { promptTokens, source, error } = await promptTokenCount({ promptText, apiKey, targetModel, signal });

  const withTokens = audited.map((r) => ({ ...r, estTokens: estimateRuleTokens(r, promptText, promptTokens) }));

  const byQuadrant = emptyByQuadrant();
  const tokensByCategory = { approx: true };
  let candidateDeadweightTokens = 0;
  for (const r of withTokens) {
    byQuadrant[r.quadrant] = (byQuadrant[r.quadrant] ?? 0) + 1;
    tokensByCategory[r.category] = (tokensByCategory[r.category] ?? 0) + r.estTokens;
    if (r.quadrant === "redundant") candidateDeadweightTokens += r.estTokens;
  }

  return {
    meta: {
      targetModel,
      judgeModel: resolvedJudge,
      promptVersions: versions,
      runs,
      startedAt,
      finishedAt: new Date().toISOString(),
      ...extraMeta,
    },
    tokens: {
      prompt: promptTokens,
      promptTokensSource: source,
      promptTokensError: error ?? null,
      spent: track.tokens,
    },
    rules: withTokens,
    summary: { byQuadrant, tokensByCategory, candidateDeadweightTokens },
  };
}

/** audit(): extract the rules first, then run auditRules over them. */
export async function audit({
  promptText,
  apiKey,
  targetModel,
  judgeModel,
  runs = 1,
  onProgress,
  signal,
  extractModel = "claude-opus-5",
}) {
  const extracted = await extractRules({ promptText, apiKey, model: extractModel, signal });
  const report = await auditRules({
    promptText,
    rules: extracted.rules,
    apiKey,
    targetModel,
    judgeModel,
    runs,
    onProgress,
    signal,
    extraMeta: { extractModel, extractReasoning: extracted.reasoning },
  });
  return {
    ...report,
    tokens: { ...report.tokens, spent: addUsage(report.tokens.spent, extracted.usage) },
  };
}
