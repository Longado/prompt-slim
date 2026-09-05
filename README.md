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
- 黄金集,以及"提示词修得动机械规则、修不太动性情"这个判断,证据全部来自 Claude。别的模型性情不同,同一条规则在它身上落哪一格得重新测——**一份四格报告只对报告里那个被测模型成立**,不是关于这条规则的普遍结论。
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
  judgeModel,                 // anthropic 默认 "claude-opus-5",与 target 同名则换 "claude-sonnet-5"
  provider,                   // "anthropic"(默认)| "openai"
  baseUrl,                    // 默认 api.anthropic.com / api.deepseek.com
  judgeProvider, judgeBaseUrl, judgeApiKey,  // extract/probe_gen/judge 走哪儿,缺省与被测相同
  runs: 1,                    // 每探针重复次数,多数票
  onProgress(evt) {},         // {stage, done, total, tokens:{input,output,cache_read}}
  signal,                     // AbortSignal
});
// report = {
//   meta: { targetModel, judgeModel, provider, baseUrl, judgeProvider, judgeBaseUrl,
//           promptVersions:{extract,probe_gen,judge}, startedAt, finishedAt },
//   tokens: { prompt, promptTokensSource:"count_tokens"|"estimate", promptTokensError?,
//             spent:{ input, output, cache_creation, cache_read, thinking, reasoningChars } },
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

## 其他模型(OpenAI 兼容接口)

方法本身不挑模型:裸对全文这个实验只要求"能发系统提示词、能强制调一个工具"。所以 `--provider openai` 把同一条流水线指向任何 OpenAI 兼容的 `/chat/completions`,默认 base 是 DeepSeek。

```bash
export DEEPSEEK_API_KEY=...
node cli.mjs prompt.md --provider openai --key-env DEEPSEEK_API_KEY \
  --target deepseek-chat --judge deepseek-reasoner
```

- `--base-url` 换别的兼容端点(vLLM、OpenRouter、Together 之类),`--key-env` 换读哪个环境变量。
- 被测和裁判可以分开:`--judge-provider anthropic --judge-key-env ANTHROPIC_API_KEY --judge claude-opus-5`,被测走 DeepSeek、裁判走 Claude。extract 与 probe_gen 跟着裁判那一侧走。
- 裁判 ≠ 被测这条不放宽。api.deepseek.com 上裁判缺省是 `deepseek-reasoner`(实测:它拒绝强制 `tool_choice`,但 `auto` 时会自己调工具);其他兼容端点我们不知道那儿有哪些模型,不替你猜,直接报错要求 `--judge`。
- 两处能力差,报告里如实标着,不是 bug:兼容接口没有计数端点,`promptTokensSource` 会是 `estimate`(字符数除 4);兼容接口也没有客户端声明的缓存,`cache_control` 直接不发,`cache_creation` 恒为 0(DeepSeek 自己按前缀缓存,命中数记在 `cache_read`)。
- `max_tokens` 会截到 8192(deepseek-chat 上限)。extract 那一步本来要 32000,所以在 DeepSeek 上审长提示词可能截断报错——这时用 `--judge-provider anthropic` 把 extract 挪回 Claude。
- 冒烟:`node test/smoke.mjs --provider openai --key-env DEEPSEEK_API_KEY --target deepseek-chat --judge deepseek-reasoner`,只跑黄金集前两条、n=1,报告写到 `test/golden/smoke.report.json`。花钱。
- web/ 这轮没动,页面仍只走 Anthropic。

## 黄金集

`test/golden/fable51.md` 是 2026-09-01 泄露的 Claude Fable 5.1 系统提示词(92K token),**不随仓库分发**:黄金测试首次运行时从 CL4R1T4S 公共归档下载到本地(已 gitignore),并按 `expected.sourceMd5` 校验。`expected.json` 里 7 条规则的四格结果来自 2026-09-03 的人工实验(`claude -p --bare` 裸对灌全文,各 n=1)。黄金测试跑 3 次取多数票,**7 条四格分类全部一致才算通过**。不一致先怀疑探针方差,再怀疑代码。
