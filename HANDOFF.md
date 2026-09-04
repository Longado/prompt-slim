# 接力(2026-09-04 晚)

## 先对账
```bash
cd ~/Desktop/Workspace/01_项目/prompt-slim && git log --oneline | head -1   # 期望 335ff91
npm test                                                                    # 期望 42 tests, 41 pass, 1 skipped(golden)
```

## 现状
- 核心 src/ 九个模块 + cli.mjs + 41 无网单测:完成。
- web/ 静态页:完成,mock 全流程在 Chrome 走通(认规则 → 跑探针 → 四格 → 瘦身版本)。
- 黄金集:**未通过,原因是 API 余额不足**,9-04 在 P1 第 9 步 400 `credit balance too low`。代码路径本身在真 API 上跑通了 8 步(probe_gen/run/judge 都发生过)。
- 已加 onRuleDone 断点:重跑时每完成一条规则写 `test/golden/last-run.partial.json`,中途挂不丢。

## 下一步(按序,前一步不过不做后一步)
1. Eddie 充值 API 余额。
2. `GOLDEN=1 GOLDEN_RUNS=3 node --test test/golden.test.mjs 2>&1 | tee test/golden/golden-run.log`。期望 stderr 打出 7 行 `checkpoint i/7 Px → <quadrant>`,最终表 7 条 expected 与 got 一致。
   - 不一致:先看 last-run.report.json 里该条的 probes[].message 是否打中规则(探针方差),再怀疑 judge,最后才是代码。
3. 黄金集过了 → `node cli.mjs <你的 CLAUDE.md 或 rules/common 拼接> --target claude-sonnet-5 --out my.report.json`,这是第二篇内容的素材。
4. 部署(需 Eddie 拍板:公开仓名 / GitHub Pages 还是 Vercel / 计数器用 GoatCounter 还是 umami)。静态目录就是仓库根,入口 `web/index.html`,`src/` 与 `prompts/` 必须一起部署(页面按相对路径 fetch 提示词)。
5. 发布:`drafts/2026-09-04-Fable5.1系统提示词研究报告.md` + 链接。

## 已知未做
- 真 key 的页面端到端没人跑过(mock 之外)。黄金集过了之后用真 key 在页面上跑一次示例提示词。
- api/extract/probe/judge/audit 没有仓库内的可注入 fetch 测试,只有实现 agent 的离线桩。
- 逐条消融、多模型、账号、支付:v2。
