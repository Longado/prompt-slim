# prompt-slim — 提示词瘦身

在线:https://longado.github.io/prompt-slim/ (静态页,自带 Anthropic key)

贴入你的系统提示词,它对每条**可测**规则跑两次探针——一次空系统提示词(裸模型),一次你的全文——然后告诉你每条规则落在四格里的哪一格:

| 裸模型 | 灌全文 | 格 | 含义 |
|---|---|---|---|
| 会 | 会 | **候选死重** | 模型不看也会做。候选,不是判决:去掉它们生成一份新版本,拿回你自己的 eval 跑 |
| 不会 | 会 | **在起作用** | 留 |
| 不会 | 不会 | **未观察到效果** | 可能规则无效,也可能探针没打中。人看 |
| 会 | 不会 | **疑似反效** | 你的提示词在破坏一个好默认。人看 |
| 任一 unknown | | **无法判定** | |

环境类规则(工具名、路径、产品事实、URL)不可测,直接标"留,不测",但计入 token 占比。

## 诚实边界

- 裸对全文只回答"这个行为是不是模型自带的",**回答不了"是你哪条规则造成的"**。灌了才出现的行为归到瞄准的那条上是假设。逐条消融是 v2。
- 默认每探针 n=1。表上写明。
- 只报 token,不报美元。价格表会腐,让用户自己乘。输出 token 含模型思考(fable 5.1 默认自适应思考且不可关闭)。
- 仅 Claude。证据全来自 Claude,别的模型性情不同。
- 每条规则的 token 按 quote 字符占全文比例折算,**系统性低估**(上下文、编号、周围结构都在花 token)。`candidateDeadweightTokens` 是排序信号,不是删掉能省的数。
- 静态页 + 用户自带 key:提示词只在浏览器与 api.anthropic.com 之间走,不经过任何第三方服务器。

## 架构

零依赖 ESM JavaScript,同一份 `src/` 在 Node ≥ 20 和浏览器里跑。三段提示词在 `prompts/`,是代码,改动记 `CHANGELOG.md`。三处模型判断,其余全是代码:

```
text ──extract(LLM#1, 一次)──▶ rules[]
        │ code: 校验 quote 是原文精确子串;环境类→留不测
        ▼
for each testable rule:
   probe_gen(LLM#2) ──▶ probes[1..3]
   for each probe:
      run(bare)  run(full, cached)      ← 被测模型,不是判断
      measure(code) 或 judge(LLM#3, 成对呈现、两个二值)
   classify(code) ──▶ 四格
report(code)
```

链深每条规则 ≤ 2 次判断。裁判模型 ≠ 被测模型。

## `audit()` 契约(web 与 cli 共用)

```js
import { audit } from "./src/audit.mjs";
const report = await audit({
  promptText,                 // string
  apiKey,                     // string, 仅内存
  targetModel,                // 被测,如 "claude-sonnet-5"
  judgeModel,                 // 默认 "claude-opus-5";若与 target 相同则换 "claude-sonnet-5"
  runs: 1,                    // 每探针重复次数,多数票
  onProgress(evt) {},         // {stage, done, total, tokens:{input,output,cache_read}}
  signal,                     // AbortSignal
});
// report = {
//   meta: { targetModel, judgeModel, promptVersions:{extract,probe_gen,judge}, startedAt, finishedAt },
//   tokens: { prompt, promptTokensSource:"count_tokens"|"estimate", promptTokensError?,
//             spent:{ input, output, cache_creation, cache_read, thinking } },
//   rules: [{ id, quote, category, testable, quoteFound, estTokens /*≈*/, quadrant, note?, probeReasoning,
//             probes: [{ message, criterion, how:"code"|"judge",
//                        runs: [{ bare:{text,tokens,truncated}, full:{...}, bareExhibits, fullExhibits, judge?:{reasoning,note,order} }],
//                        bareExhibits, fullExhibits, quadrant }] }],
//   summary: { byQuadrant:{ redundant, effective, ineffective, harmful, unknown, untested }, candidateDeadweightTokens /*≈*/ }
// }
// quadrant 取值:redundant 候选死重 / effective 在起作用 / ineffective 未观察到效果 / harmful 疑似反效 / unknown 无法判定 / untested 未测(环境类或未勾选)
// 以 src/audit.mjs 为准;此处是 2026-09-04 与代码对齐后的形状。
```

## 跑

```bash
export ANTHROPIC_API_KEY=...
node cli.mjs path/to/prompt.txt --target claude-sonnet-5            # 出 JSON 报告到 stdout
npm test                                                             # 无网单测(schema/measure/classify);Node 25 下裸目录不展开,用 glob
GOLDEN=1 node --test test/golden.test.mjs                            # 黄金集,需要 key,花钱
```

## 黄金集

`test/golden/fable51.md` 是 2026-09-01 泄露的 Claude Fable 5.1 系统提示词(92K token),**不随仓库分发**:黄金测试首次运行时从 CL4R1T4S 公共归档下载到本地(已 gitignore),并按 `expected.sourceMd5` 校验。`expected.json` 里 7 条规则的四格结果来自 2026-09-03 的人工实验(`claude -p --bare` 裸对灌全文,各 n=1)。黄金测试跑 3 次取多数票,**7 条四格分类全部一致才算通过**。不一致先怀疑探针方差,再怀疑代码。
