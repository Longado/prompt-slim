# 接力(2026-09-04 晚)

## 先对账
```bash
cd ~/Desktop/Workspace/01_项目/prompt-slim && git log --oneline | head -1   # 期望 f5874b3 或更新
npm test                                                                    # 期望 58 tests, 57 pass, 1 skipped(golden)
```

## 现状
- 核心 src/ 九个模块 + cli.mjs + 57 无网单测:完成。
- provider 抽象(2026-09-05):同一条流水线可走 Anthropic Messages 或 OpenAI 兼容 chat/completions(首个目标 DeepSeek)。见 README「其他模型」。真 key 端到端未跑,脚本是 `test/smoke.mjs`。
- web/ 静态页:完成,mock 全流程在 Chrome 走通(认规则 → 跑探针 → 四格 → 瘦身版本)。
- 黄金集:**未通过,原因是 API 余额不足**,9-04 在 P1 第 9 步 400 `credit balance too low`。代码路径本身在真 API 上跑通了 8 步(probe_gen/run/judge 都发生过)。
- 已加 onRuleDone 断点:重跑时每完成一条规则写 `test/golden/last-run.partial.json`,中途挂不丢。

## 下一步(按序,前一步不过不做后一步)
1. Eddie 充值 API 余额。
2. `GOLDEN=1 GOLDEN_RUNS=3 node --test test/golden.test.mjs 2>&1 | tee test/golden/golden-run.log`。期望 stderr 打出 7 行 `checkpoint i/7 Px → <quadrant>`,最终表 7 条 expected 与 got 一致。
   - 不一致:先看 last-run.report.json 里该条的 probes[].message 是否打中规则(探针方差),再怀疑 judge,最后才是代码。
3. 黄金集过了 → `node cli.mjs <你的 CLAUDE.md 或 rules/common 拼接> --target claude-sonnet-5 --out my.report.json`,这是第二篇内容的素材。
4. ~~部署~~ 已上线 2026-09-04:公开仓 github.com/Longado/prompt-slim,GitHub Pages 从 main 根目录发布,入口 https://longado.github.io/prompt-slim/ (根 index.html 跳 web/)。**计数器仍空着**(web/index.html 里有占位注释),需 Eddie 选 GoatCounter 或 umami 并给站点 id。
5. 发布:`drafts/2026-09-04-Fable5.1系统提示词研究报告.md` + 链接。


## 2026-09-05 晚:OpenAI 兼容 provider 已落地并用 DeepSeek 真跑过一次
- commit dfab267 + fc63ad8。58 单测。`--provider openai --key-env DEEPSEEK_API_KEY --target deepseek-chat --judge deepseek-reasoner`。
- 冒烟(黄金集前 2 条、runs=1)端到端跑通:probe_gen → bare/full → reasoner 裁判(auto 模式)→ 四格。DeepSeek 前缀缓存命中 317K/389K 输入。
- 结果本身就是发现:P2「一词作答拒绝短形式」在 DeepSeek 上 bare/full 三个探针全是一词答("No." "Yes." "Justified."),落「未观察到效果」——同一份 Fable 提示词的这条规则对 DeepSeek 不起作用。四格只对被测模型成立,README 已改口径。
- P1 落 unknown 的原因是三探针分歧,其中 probe2 裁判(reasoner, auto)没调工具 → unknown。**下一个小修**:judge.mjs 里"没调工具"先重发一次再判 unknown。
- 黄金集(Fable)仍卡 Anthropic 余额,未过。

## 已知未做
- 真 key 的页面端到端没人跑过(mock 之外)。黄金集过了之后用真 key 在页面上跑一次示例提示词。
- web/ 页面没有 provider 选择,仍写死 Anthropic。
- DeepSeek 上 extract 那一步 max_tokens 被截到 8192(原本要 32000),长提示词可能截断;没实测过多长会炸。
- 逐条消融、账号、支付:v2。
