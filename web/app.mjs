// prompt-slim web —— 浏览器原生 ESM,无框架、无构建、无依赖。
// 核心在 ../src/;?mock=1 时换成 ./mock-audit.mjs 的同名假实现。
// 首屏那份跑好的报告来自 ./demo-report.mjs(独立数据源,可整块换成真报告)。

import { DEMO_REPORT, DEMO_PROMPT, DEMO_TAGLINE, DEMO_IS_MOCK } from "./demo-report.mjs";

const MOCK = new URLSearchParams(location.search).get("mock") === "1";
const KEY_STORE = "prompt-slim.apiKey";
const CHARS_PER_TOKEN = 3.5; // 兜底估算:全文 token ≈ 字符数 / 3.5
const TEXTAREA_MAX = 420;    // 自适应高度的上限,超过就自己滚

const QUADRANT_ZH = {
  redundant: "候选死重",
  effective: "在起作用",
  ineffective: "未观察到效果",
  harmful: "疑似反效",
  unknown: "无法判定",
  untested: "留,不测",
};
// 卡片上的一行解释,取自 README 的四格表
const QUADRANT_HINT = {
  redundant: "模型不看也会做",
  effective: "留",
  ineffective: "规则无效,或探针没打中",
  harmful: "在破坏一个好默认",
};
const QUADRANT_ORDER = ["redundant", "effective", "ineffective", "harmful", "unknown"];
const CARD_QUADRANTS = ["redundant", "effective", "ineffective", "harmful"];
// 表里的排序:先看要动手的
const ROW_ORDER = ["redundant", "harmful", "effective", "ineffective", "unknown", "untested"];

// 核心 ruleQuadrant() 会回这两种 note
const NOTE_ZH = {
  "probes disagree": "多个探针的结论不一致,没有归并成一个结论,按「无法判定」处理。",
  "no probes": "没有生成出探针。",
};

const CATEGORY_ZH = {
  mechanical: "机械",
  dispositional: "性情",
  environmental: "环境",
  mixed: "混合",
};

const STAGE_ZH = {
  start: "开始", probe_gen: "生成探针", run: "跑探针", judge: "裁判", done: "完成",
};

// ---------- DOM 小工具 ----------
const $ = (id) => document.getElementById(id);
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString("en-US") : "—");
const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "—");

function showError(msg, detail) {
  const b = $("banner");
  b.className = "banner err";
  b.textContent = detail ? `${msg}\n\n${detail}` : msg;
  b.hidden = false;
  b.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function clearError() { $("banner").hidden = true; }

// ---------- 状态 ----------
let state = {
  promptText: "",
  rules: [],
  selected: new Set(),
  totalTokens: 0,
  tokenSource: "估算",
  report: null,
  running: false,
};
const setState = (patch) => { state = { ...state, ...patch }; };

// ---------- 核心加载 ----------
let corePromise = null;
function loadCore() {
  if (corePromise) return corePromise;
  corePromise = (async () => {
    if (MOCK) {
      const m = await import("./mock-audit.mjs");
      return { extractRules: m.extractRules, auditRules: m.auditRules, sample: m.SAMPLE_PROMPT };
    }
    let ex, au;
    try {
      ex = await import("../src/extract.mjs");
    } catch (e) {
      throw new Error(
        `加载不到核心模块 ../src/extract.mjs —— 它还没落地,或者你不是通过 HTTP 打开这个页面的。\n` +
        `本地跑法:在仓库根目录执行 python3 -m http.server,然后访问 /web/\n` +
        `想先看页面流程,加上 ?mock=1(演示模式,不联网)。\n\n原始错误:${e.message}`
      );
    }
    try {
      au = await import("../src/audit.mjs");
    } catch (e) {
      throw new Error(`加载不到核心模块 ../src/audit.mjs。\n想先看页面流程请加 ?mock=1。\n\n原始错误:${e.message}`);
    }
    if (typeof ex.extractRules !== "function")
      throw new Error("../src/extract.mjs 没有导出 extractRules()。契约:extractRules({promptText, apiKey, signal}) → {rules, usage}");
    if (typeof au.auditRules !== "function")
      throw new Error("../src/audit.mjs 没有导出 auditRules()。契约:auditRules({promptText, rules, apiKey, targetModel, judgeModel, runs, onProgress, signal}) → report");
    return { extractRules: ex.extractRules, auditRules: au.auditRules, sample: null };
  })();
  return corePromise;
}

// ---------- 模型 ----------
const judgeFor = (target) => (target === "claude-opus-5" ? "claude-sonnet-5" : "claude-opus-5");
function syncJudge() {
  $("judge-model-box").textContent = judgeFor($("target-model").value);
}

// ---------- token 估算 ----------
function totalTokensFor(text, usage) {
  // 只认核心显式给出的“全文 token”字段;usage.input_tokens 里混着 extract 自己的提示词,不能当全文用。
  // 真实的全文 token 要等第二步 report.tokens.prompt(核心走 API count_tokens)。
  const given = usage?.promptTokens ?? usage?.sourceTokens ?? null;
  if (Number.isFinite(given) && given > 0) return { total: given, source: "核心返回" };
  return { total: Math.round(text.length / CHARS_PER_TOKEN), source: "估算" };
}
function ruleTokens(rule) {
  // 核心在报告里给了 estTokens(用真实 count_tokens 折算)就用它,否则自己按字符占比估
  if (Number.isFinite(rule.estTokens)) return rule.estTokens;
  if (!state.promptText.length) return 0;
  return Math.round(((rule.quote?.length ?? 0) / state.promptText.length) * state.totalTokens);
}

// ---------- 共用渲染件 ----------
function quoteCell(quote) {
  const q = quote ?? "";
  if (q.length <= 90) return h("span", { class: "qt", text: q });
  return h("details", { class: "quote" },
    h("summary", { class: "qt" }, q.slice(0, 90) + "…"),
    h("pre", { text: q }),
  );
}

function tagFor(quadrant) {
  return h("span", { class: `tag q-${quadrant}`, text: QUADRANT_ZH[quadrant] ?? quadrant });
}

// 四格结果条:一条横向 1x4 带边框条带(无法判定/未测另起一行小字)
function renderStrip(counts, el) {
  el.replaceChildren(...CARD_QUADRANTS.map((q) =>
    h("div", { class: `cell q-${q}` },
      h("div", { class: "n", text: String(counts[q] ?? 0) }),
      h("div", { class: "k", text: QUADRANT_ZH[q] }),
      h("div", { class: "h", text: QUADRANT_HINT[q] }),
    )));
}

// 工单头:带边框的键值网格(标签小号大写 mono)
function renderSpec(el, pairs) {
  el.replaceChildren(...pairs.map(([k, v]) =>
    h("div", {}, h("dt", { text: k }), h("dd", { text: v }))));
}

function extraLine(counts) {
  return `另有 无法判定 ${counts.unknown ?? 0} 条 · 留,不测(环境类)${counts.untested ?? 0} 条。`;
}

// 逐规则表体。tok(rule) 给 ≈token;opts.limit 只画前 N 条;opts.sorted 按 ROW_ORDER 排。
function renderRuleRows(rules, tbody, tok, opts = {}) {
  let list = rules.slice();
  if (opts.sorted) list.sort((a, b) => ROW_ORDER.indexOf(a.quadrant) - ROW_ORDER.indexOf(b.quadrant));
  if (opts.limit) list = list.slice(0, opts.limit);
  tbody.replaceChildren();
  for (const r of list) {
    const detail = h("tr", { class: "detail-row", hidden: true },
      h("td", { colspan: "6" },
        r.note ? h("p", { class: "kv" }, h("b", { text: "汇总备注:" }), " ", NOTE_ZH[r.note] ?? r.note) : null,
        r.probeReasoning ? h("details", { class: "quote" },
          h("summary", { text: "探针设计 reasoning" }), h("pre", { text: r.probeReasoning })) : null,
        ...(r.probes ?? []).map(renderProbe),
        (r.probes ?? []).length ? null : h("p", { class: "note", text: "这条规则没有探针记录(不可测的规则不跑探针)。" })));
    const btn = h("button", { class: "ghost xs", text: "展开" });
    btn.addEventListener("click", () => {
      detail.hidden = !detail.hidden;
      btn.textContent = detail.hidden ? "展开" : "收起";
    });
    tbody.append(
      h("tr", {},
        h("td", { class: "q" }, tagFor(r.quadrant)),
        h("td", { class: "id", text: r.id }),
        h("td", {}, quoteCell(r.quote)),
        h("td", { text: CATEGORY_ZH[r.category] ?? r.category ?? "—" }),
        h("td", { class: "num", text: "≈" + fmt(tok(r)) }),
        h("td", {}, btn),
      ),
      detail,
    );
  }
}

function renderProbe(p, i) {
  const crit = p.criterion ?? {};
  const critText = crit.kind === "code"
    ? `代码测量 ${crit.measure ?? "?"}${crit.arg ? ` /${crit.arg}/` : ""} ${crit.satisfied_when ?? ""} — ${crit.description ?? ""}`
    : (crit.description ?? "—");
  const reasoning = p.judge?.reasoning ?? p.judgeReasoning ?? null;
  const note = p.judge?.note ?? p.note ?? null;
  const perRun = Array.isArray(p.runs) ? p.runs : null;

  const side = (id, gloss, side_) => h("div", {},
    h("h4", {},
      h("span", {}, h("span", { class: "side-id", text: id }), " ", h("span", { class: "side-gloss", text: gloss })),
      h("span", { class: "mono", text: `体现该规则:${side_.exhibits ?? "—"}` })),
    h("pre", { class: "out", text: side_.text ?? "—" }),
    side_.truncated ? h("p", { class: "note", text: "⚠ 这条回答被 max_tokens 截断了,判定可能不可靠。" }) : null,
  );

  return h("div", { class: "probe" },
    h("div", { class: "probe-head" },
      h("b", { class: "kv", style: "margin:0", text: `探针 ${i + 1}` }),
      h("span", { class: "note-inline", text: `判定方式:${p.how === "judge" ? "裁判模型" : "代码"}` }),
      p.quadrant ? tagFor(p.quadrant) : null,
      perRun && perRun.length > 1 ? h("span", { class: "note-inline", text: `${perRun.length} 次多数票` }) : null,
    ),
    h("p", { class: "kv" }, h("b", { text: "用户消息:" }), " ", p.message ?? "—"),
    h("p", { class: "kv" }, h("b", { text: "判据:" }), " ", critText),
    h("div", { class: "sbs" },
      side("BARE", "裸模型(空系统提示词)", { ...(p.bare ?? {}), exhibits: p.bareExhibits }),
      side("FULL", "灌全文", { ...(p.full ?? {}), exhibits: p.fullExhibits }),
    ),
    reasoning
      ? h("details", { class: "quote", style: "margin-top:8px" },
          h("summary", { text: "裁判 reasoning" }),
          h("pre", { text: note ? `${reasoning}\n\n裁判备注:${note}` : reasoning })
        )
      : (note ? h("p", { class: "note", text: `裁判备注:${note}` }) : null),
    perRun && perRun.length > 1
      ? h("details", { class: "quote", style: "margin-top:6px" },
          h("summary", { text: `逐次结果(n=${perRun.length})` }),
          h("pre", {
            text: perRun.map((r, k) =>
              `#${k + 1} 裸:${r.bareExhibits} / 全文:${r.fullExhibits}` +
              (r.judge?.reasoning ? `\n   裁判:${r.judge.reasoning}` : "")).join("\n"),
          }))
      : null,
  );
}

// ---------- 首屏:一份跑好的报告 ----------
function renderDemo() {
  const rep = DEMO_REPORT;
  const counts = rep.summary?.byQuadrant ?? {};
  const total = rep.tokens?.prompt ?? 0;

  $("demo-tagline").textContent = DEMO_TAGLINE;
  renderSpec($("demo-spec"), [
    ["被测", rep.meta?.targetModel ?? "—"],
    ["裁判", rep.meta?.judgeModel ?? "—"],
    ["每探针 n", String(rep.meta?.runs ?? 1)],
    ["全文 token", fmt(total)],
    ["数据来源", DEMO_IS_MOCK ? "示例数据" : "真实报告"],
  ]);

  renderStrip(counts, $("demo-strip"));
  $("demo-extra").textContent = extraLine(counts);

  const rows = rep.rules ?? [];
  renderRuleRows(rows, $("demo-table").querySelector("tbody"), (r) => r.estTokens ?? 0,
    { sorted: true, limit: 5 });

  const dw = rep.summary?.candidateDeadweightTokens ?? 0;
  $("demo-foot").textContent =
    `候选死重合计 ≈${fmt(dw)} token,占全文 ≈${pct(dw, total)}。` +
    `表里列了 ${Math.min(5, rows.length)} / ${rows.length} 条,点「展开」看裸对全文的原始回答。`;

  $("btn-cta").addEventListener("click", () => {
    $("sec-input").scrollIntoView({ behavior: "smooth", block: "start" });
    $("prompt-text").focus({ preventScroll: true });
  });
  $("btn-demo-fill").addEventListener("click", () => {
    $("prompt-text").value = DEMO_PROMPT;
    $("prompt-text").dispatchEvent(new Event("input"));
    $("sec-input").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

// ---------- 第一步:认规则 ----------
async function doExtract() {
  clearError();
  const promptText = $("prompt-text").value;
  const apiKey = $("api-key").value.trim();
  if (!promptText.trim()) return showError("先把系统提示词贴进上面的框里。");
  if (!apiKey && !MOCK) return showError("需要 Anthropic API key。它只在你的浏览器和 api.anthropic.com 之间用,不会发去别处。");

  const btn = $("btn-extract");
  btn.disabled = true;
  $("extract-status").textContent = "正在认规则…(1 次 LLM 调用)";
  try {
    const core = await loadCore();
    const res = await core.extractRules({ promptText, apiKey, signal: undefined });
    const rules = (res?.rules ?? []).map((r, i) => ({ ...r, id: r.id ?? `R${i + 1}` }));
    if (!rules.length) throw new Error("核心没有返回任何规则。");
    const { total, source } = totalTokensFor(promptText, res?.usage);
    const selected = new Set(rules.filter((r) => r.testable && r.category !== "environmental").map((r) => r.id));
    setState({ promptText, rules, selected, totalTokens: total, tokenSource: source, report: null });
    renderRules();
    $("sec-rules").hidden = false;
    $("sec-result").hidden = true;
    $("sec-slim").hidden = true;
    $("extract-status").textContent = `认出 ${rules.length} 条。`;
    $("sec-rules").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    $("extract-status").textContent = "";
    showError("第一步失败。", e.message);
  } finally {
    btn.disabled = false;
  }
}

function renderRules() {
  const tb = $("rule-table").querySelector("tbody");
  tb.replaceChildren();
  for (const r of state.rules) {
    const isEnv = r.category === "environmental";
    const cb = h("input", { type: "checkbox" });
    cb.checked = state.selected.has(r.id);
    cb.disabled = isEnv;
    if (isEnv) cb.title = "环境类规则不可测(留,不测),但计入 token 占比";
    cb.addEventListener("change", () => {
      const next = new Set(state.selected);
      cb.checked ? next.add(r.id) : next.delete(r.id);
      setState({ selected: next });
      renderStats();
    });
    tb.append(h("tr", {},
      h("td", {}, cb),
      h("td", { class: "id", text: r.id }),
      h("td", {}, quoteCell(r.quote), r.quoteFound === false
        ? h("div", { class: "note-inline", text: "⚠ 这条 quote 不是原文的精确子串" }) : null),
      h("td", { text: CATEGORY_ZH[r.category] ?? r.category ?? "—" }),
      h("td", { text: r.testable ? "可测" : "不可测" }),
      h("td", { class: "num", text: "≈" + fmt(ruleTokens(r)) }),
    ));
  }
  renderStats();
  $("token-source-note").textContent =
    state.tokenSource === "估算"
      ? `token 一列是估算(标 ≈):还没有真实的全文 token 数,按 字符数 ÷ ${CHARS_PER_TOKEN} 兜底得到全文 ${fmt(state.totalTokens)} token,再按每条 quote 的字符占比折算——跑完第二步会用 API count_tokens 的真实值回填。`
      : `token 一列仍是分摊估算(标 ≈):全文 ${fmt(state.totalTokens)} token 来自 ${state.tokenSource},但每条规则的份额是按 quote 的字符占比折算的,不是它的真实开销。`;
}

function renderStats() {
  const envTok = state.rules.filter((r) => r.category === "environmental").reduce((s, r) => s + ruleTokens(r), 0);
  const behTok = state.rules.filter((r) => r.category !== "environmental").reduce((s, r) => s + ruleTokens(r), 0);
  $("rule-stats").replaceChildren(
    h("span", {}, "共 ", h("b", { text: String(state.rules.length) }), " 条"),
    h("span", {}, "已勾选 ", h("b", { text: String(state.selected.size) }), " 条"),
    h("span", {}, "环境类占 ≈", h("b", { text: pct(envTok, state.totalTokens) }), " token"),
    h("span", {}, "行为类(机械/性情/混合)占 ≈", h("b", { text: pct(behTok, state.totalTokens) }), " token"),
    h("span", {}, "全文 ≈", h("b", { text: fmt(state.totalTokens) }), ` token(${state.tokenSource})`),
  );
}

// ---------- 第二步:跑探针 ----------
let controller = null;

async function doAudit() {
  clearError();
  const picked = state.rules.filter((r) => state.selected.has(r.id));
  if (!picked.length) return showError("一条都没勾。至少勾一条可测的规则再跑。");
  const apiKey = $("api-key").value.trim();
  if (!apiKey && !MOCK) return showError("需要 Anthropic API key。");

  const targetModel = $("target-model").value;
  const judgeModel = judgeFor(targetModel);
  const runs = Math.max(1, parseInt($("runs").value, 10) || 1);

  controller = new AbortController();
  setState({ running: true });
  $("btn-audit").disabled = true;
  $("btn-extract").disabled = true;
  $("statusbar").hidden = false;
  $("statusbar").classList.remove("done");
  $("btn-abort").hidden = false;
  $("audit-status").textContent = `跑 ${picked.length} 条规则,每探针 n=${runs}…`;
  renderProgress({ stage: "准备", done: 0, total: 1, tokens: {} });

  try {
    const core = await loadCore();
    const report = await core.auditRules({
      promptText: state.promptText,
      rules: picked,
      apiKey,
      targetModel,
      judgeModel,
      runs,
      onProgress: renderProgress,
      signal: controller.signal,
    });
    if (!report?.rules) throw new Error("核心返回的报告里没有 rules[]。");
    // 核心在报告里给了真实全文 token(走 API count_tokens),回填后第一步的表也跟着更准
    const pt = report.tokens?.prompt;
    if (Number.isFinite(pt) && pt > 0) {
      const src = report.tokens.promptTokensSource === "count_tokens" ? "API count_tokens" : "估算";
      setState({ totalTokens: pt, tokenSource: src, report });
      renderRules();
    } else {
      setState({ report });
    }
    renderResult();
    $("sec-demo").hidden = true;   // 有了真报告,首屏那份示例就退场
    $("sec-result").hidden = false;
    $("sec-slim").hidden = true;
    $("audit-status").textContent = "跑完了。";
    settleStatus("完成 · 本次累计");
    $("sec-result").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    if (e?.name === "AbortError") {
      $("audit-status").textContent = "已中止。";
      settleStatus("已中止 · 本次累计");
    } else {
      $("audit-status").textContent = "";
      settleStatus("失败 · 本次累计");
      showError("第二步失败。", e.message);
    }
  } finally {
    controller = null;
    setState({ running: false });
    $("btn-audit").disabled = false;
    $("btn-extract").disabled = false;
  }
}

// 跑完/中止/失败后状态栏不收起,塌成一行常驻小结——累计 token 留在屏幕上
function settleStatus(label) {
  $("statusbar").classList.add("done");
  $("btn-abort").hidden = true;
  $("sb-stage").textContent = label;
}

function renderProgress(evt) {
  const done = Number(evt?.done ?? 0), total = Number(evt?.total ?? 0) || 1;
  const stage = STAGE_ZH[evt?.stage] ?? evt?.stage ?? "";
  $("sb-fill").style.width = `${Math.min(100, (done / total) * 100).toFixed(1)}%`;
  $("sb-stage").textContent = `${stage} ${done}/${total}${evt?.ruleId ? ` · ${evt.ruleId}` : ""}`;
  const t = evt?.tokens ?? {};
  $("sb-toks").replaceChildren(
    h("span", { text: `in ${fmt(t.input ?? 0)}` }),
    h("span", { text: `out ${fmt(t.output ?? 0)}(含思考)` }),
    h("span", { text: `cache_read ${fmt(t.cache_read ?? 0)}` }),
    Number.isFinite(t.thinking) ? h("span", { text: `thinking ${fmt(t.thinking)}` }) : null,
  );
}

// ---------- 结果 ----------
function renderResult() {
  const rep = state.report;
  const counts = {};
  for (const r of rep.rules) counts[r.quadrant] = (counts[r.quadrant] ?? 0) + 1;

  renderStrip(counts, $("quadrant-cards"));
  $("result-extra").textContent = extraLine(counts);

  const dw = rep.summary?.candidateDeadweightTokens
    ?? rep.rules.filter((r) => r.quadrant === "redundant").reduce((s, r) => s + ruleTokens(r), 0);
  const spent = rep.tokens?.spent ?? rep.tokens ?? {};
  $("deadweight-note").textContent =
    `候选死重合计 ≈${fmt(dw)} token,占全文 ≈${pct(dw, state.totalTokens)}(全文 ${fmt(state.totalTokens)} token,${state.tokenSource})。` +
    `每探针 n=${rep.meta?.runs ?? $("runs").value}。被测 ${rep.meta?.targetModel ?? "—"},裁判 ${rep.meta?.judgeModel ?? "—"}。` +
    `本次调用累计:input ${fmt(spent.input)} / output ${fmt(spent.output)}(含思考) / cache_read ${fmt(spent.cache_read)}。` +
    (rep.tokens?.promptTokensError ? ` 全文 token 计数失败,已退回估算:${rep.tokens.promptTokensError}` : "");

  renderRuleRows(rep.rules, $("result-table").querySelector("tbody"), ruleTokens, { sorted: true });
}

// ---------- 瘦身版本 ----------
function doSlim() {
  const rep = state.report;
  if (!rep) return;
  const dead = rep.rules.filter((r) => r.quadrant === "redundant");
  let text = state.promptText;
  const warns = [];
  let removed = 0;

  for (const r of dead) {
    const idx = text.indexOf(r.quote);
    if (idx === -1) {
      warns.push(`${r.id}:在当前文本里找不到这条 quote,没有删除(可能被前面的删除切断了,或它本来就不是精确子串)。`);
      continue;
    }
    // 只删第一次出现;出现多次时提示
    const rest = text.slice(idx + r.quote.length);
    if (rest.includes(r.quote)) {
      warns.push(`${r.id}:这条 quote 在原文里出现不止一次,只删了第一次。`);
    }
    text = text.slice(0, idx) + rest;
    removed++;
  }

  $("slim-text").value = text;
  const savedChars = state.promptText.length - text.length;
  const savedTok = Math.round((savedChars / Math.max(1, state.promptText.length)) * state.totalTokens);
  $("slim-note").textContent =
    `从原文里精确删掉了 ${removed} / ${dead.length} 条「候选死重」,` +
    `少 ${fmt(savedChars)} 字符 ≈ ${fmt(savedTok)} token(≈${pct(savedTok, state.totalTokens)})。` +
    `删除是纯子串删除,不做任何改写或空白整理——留下的空行需要你自己收拾。`;
  const w = $("slim-warn");
  if (warns.length) { w.textContent = warns.join("\n"); w.hidden = false; } else { w.hidden = true; }
  $("sec-slim").hidden = false;
  $("sec-slim").scrollIntoView({ behavior: "smooth", block: "start" });
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- 绑定 ----------
function autosize(el) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight + 2, TEXTAREA_MAX)}px`;
}

function init() {
  renderDemo();

  const ta = $("prompt-text");
  const updateLen = () => {
    const t = ta.value;
    $("len-note").textContent = `${fmt(t.length)} 字符 ≈ ${fmt(Math.round(t.length / CHARS_PER_TOKEN))} token(估算)`;
    autosize(ta);
  };

  if (MOCK) $("mock-note").hidden = false;

  const saved = localStorage.getItem(KEY_STORE);
  if (saved) { $("api-key").value = saved; $("remember-key").checked = true; }

  $("remember-key").addEventListener("change", (e) => {
    if (e.target.checked) localStorage.setItem(KEY_STORE, $("api-key").value);
    else localStorage.removeItem(KEY_STORE);
  });
  $("api-key").addEventListener("input", (e) => {
    if ($("remember-key").checked) localStorage.setItem(KEY_STORE, e.target.value);
  });

  ta.addEventListener("input", updateLen);
  updateLen();

  $("target-model").addEventListener("change", syncJudge);
  syncJudge();

  $("btn-extract").addEventListener("click", doExtract);
  $("btn-audit").addEventListener("click", doAudit);
  $("btn-abort").addEventListener("click", () => controller?.abort());
  $("btn-slim").addEventListener("click", doSlim);
  $("btn-check-testable").addEventListener("click", () => {
    setState({ selected: new Set(state.rules.filter((r) => r.testable && r.category !== "environmental").map((r) => r.id)) });
    renderRules();
  });
  $("btn-check-none").addEventListener("click", () => { setState({ selected: new Set() }); renderRules(); });

  $("btn-export").addEventListener("click", () => {
    if (!state.report) return;
    download(`prompt-slim-report-${Date.now()}.json`, JSON.stringify(state.report, null, 2), "application/json");
  });
  $("btn-download").addEventListener("click", () => {
    download(`prompt-slim-${Date.now()}.txt`, $("slim-text").value, "text/plain;charset=utf-8");
  });
  $("btn-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("slim-text").value);
      $("copy-status").textContent = "已复制。";
    } catch {
      $("slim-text").select();
      $("copy-status").textContent = "浏览器不给权限,已选中,自己按 Cmd/Ctrl+C。";
    }
    setTimeout(() => ($("copy-status").textContent = ""), 3000);
  });

  // 非演示模式:开页就探一次核心,src/ 没就绪时立刻给出清楚的错误,而不是等用户点完按钮才白等
  if (!MOCK) loadCore().catch((e) => showError("核心还没就绪。", e.message));

  window.addEventListener("error", (e) => showError("页面出错。", e.message));
  window.addEventListener("unhandledrejection", (e) => showError("未捕获的异步错误。", String(e.reason?.message ?? e.reason)));
}

init();
