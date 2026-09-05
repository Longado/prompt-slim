// The OpenAI-compatible provider, offline. Every call goes through an injected fetch stub —
// setFetch is module-local, so nothing here touches globalThis.fetch.

import test from "node:test";
import assert from "node:assert/strict";
import {
  callMessages,
  countTokens,
  setFetch,
  textOf,
  toolInputOf,
  usageOf,
  stopReasonOf,
  resolveBaseUrl,
  toOpenAIBody,
  OPENAI_MAX_TOKENS,
} from "../src/api.mjs";
import { auditRules, resolveJudgeModel } from "../src/audit.mjs";

/**
 * Records every request, replies with the queued responses in order.
 * A reply may be a function of the request body — judgePair randomises which response is
 * shown as A, so a fixed verdict there would make the test flaky by construction.
 */
function stub(...replies) {
  const calls = [];
  let i = 0;
  setFetch(async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const queued = replies[Math.min(i++, replies.length - 1)];
    const r = typeof queued === "function" ? queued(body) : queued;
    return {
      ok: r.status === undefined || r.status === 200,
      status: r.status ?? 200,
      headers: { get: () => null },
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  });
  return calls;
}

const TOOL = {
  name: "submit_verdict",
  description: "Return whether each response follows the rule.",
  input_schema: { type: "object", required: ["a_exhibits"], properties: { a_exhibits: { type: "string" } } },
};

const ANTHROPIC_BODY = {
  model: "deepseek-chat",
  max_tokens: 4096,
  system: [{ type: "text", text: "you are a judge", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: "compare A and B" }],
  tools: [TOOL],
  tool_choice: { type: "tool", name: "submit_verdict" },
};

function okToolCall(args = '{"a_exhibits":"yes"}') {
  return {
    body: {
      choices: [
        {
          finish_reason: "tool_calls",
          message: { content: null, tool_calls: [{ function: { name: "submit_verdict", arguments: args } }] },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    },
  };
}

test.afterEach(() => setFetch(null));

test("openai request maps system, tools, forced tool_choice and the base URL", async () => {
  const calls = stub(okToolCall());
  await callMessages({ provider: "openai", apiKey: "k", body: ANTHROPIC_BODY });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(calls[0].headers.authorization, "Bearer k");
  const sent = calls[0].body;
  assert.deepEqual(sent.messages, [
    { role: "system", content: "you are a judge" },
    { role: "user", content: "compare A and B" },
  ]);
  assert.deepEqual(sent.tools, [
    { type: "function", function: { name: TOOL.name, description: TOOL.description, parameters: TOOL.input_schema } },
  ]);
  assert.deepEqual(sent.tool_choice, { type: "function", function: { name: "submit_verdict" } });
  // cache_control has no OpenAI-compatible equivalent and must not be forwarded anywhere.
  assert.ok(!JSON.stringify(sent).includes("cache_control"));
});

test("a bare call (no system) sends no system message at all", () => {
  const sent = toOpenAIBody({ model: "deepseek-chat", max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(sent.messages, [{ role: "user", content: "hi" }]);
  assert.equal("tools" in sent, false);
  assert.equal("tool_choice" in sent, false);
});

test("max_tokens is clamped to the deepseek-chat ceiling, and left alone below it", () => {
  const big = toOpenAIBody({ model: "m", max_tokens: 32000, messages: [] });
  assert.equal(big.max_tokens, OPENAI_MAX_TOKENS);
  const small = toOpenAIBody({ model: "m", max_tokens: 2048, messages: [] });
  assert.equal(small.max_tokens, 2048);
});

test("--base-url overrides the default endpoint", async () => {
  const calls = stub(okToolCall());
  await callMessages({ provider: "openai", baseUrl: "https://example.test/v1/", apiKey: "k", body: ANTHROPIC_BODY });
  assert.equal(calls[0].url, "https://example.test/v1/chat/completions");
  assert.equal(resolveBaseUrl("anthropic"), "https://api.anthropic.com");
});

test("a model that rejects forced tool_choice is retried once on auto", async () => {
  const calls = stub(
    { status: 400, body: { error: { message: "Thinking mode does not support this tool_choice" } } },
    okToolCall(),
  );
  const res = await callMessages({
    provider: "openai",
    apiKey: "k",
    body: { ...ANTHROPIC_BODY, model: "deepseek-reasoner" },
  });

  assert.equal(calls.length, 2, "exactly one downgrade, not a retry loop");
  assert.deepEqual(calls[0].body.tool_choice, { type: "function", function: { name: "submit_verdict" } });
  assert.equal(calls[1].body.tool_choice, "auto");
  assert.deepEqual(toolInputOf(res, "submit_verdict"), { a_exhibits: "yes" });
});

test("an unrelated 400 is not downgraded — it is thrown as-is", async () => {
  const calls = stub({ status: 400, body: { error: { message: "model not found" } } });
  await assert.rejects(
    () => callMessages({ provider: "openai", apiKey: "k", body: ANTHROPIC_BODY }),
    /openai 400: model not found/,
  );
  assert.equal(calls.length, 1);
});

test("toolInputOf reads the tool arguments on both providers", () => {
  const anthropic = { content: [{ type: "tool_use", name: "submit_verdict", input: { a_exhibits: "no" } }] };
  assert.deepEqual(toolInputOf(anthropic, "submit_verdict"), { a_exhibits: "no" });
  assert.deepEqual(toolInputOf(okToolCall().body, "submit_verdict"), { a_exhibits: "yes" });
});

test("toolInputOf throws when the model answered in prose instead of calling the tool", () => {
  const prose = { choices: [{ finish_reason: "stop", message: { content: "I think A follows the rule." } }] };
  assert.throws(() => toolInputOf(prose, "submit_verdict"), /model did not call the tool/);
});

test("toolInputOf throws on unparseable arguments, quoting the raw text", () => {
  const bad = okToolCall('{"a_exhibits": ye').body;
  assert.throws(() => toolInputOf(bad, "submit_verdict"), (err) => {
    assert.match(err.message, /not valid JSON/);
    assert.match(err.message, /a_exhibits/); // the raw text is in the message, not swallowed
    return true;
  });
});

test("textOf returns the assistant content, empty string when null", () => {
  assert.equal(textOf({ choices: [{ message: { content: "hello" } }] }), "hello");
  assert.equal(textOf(okToolCall().body), "");
  assert.equal(textOf({ content: [{ type: "text", text: "claude" }] }), "claude");
});

test("usageOf maps the OpenAI usage fields, cache misses excluded", () => {
  const res = {
    choices: [{ message: { content: "hi", reasoning_content: "12345" } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36 },
  };
  assert.deepEqual(usageOf(res), {
    input: 100,
    output: 20,
    cache_creation: 0, // prompt_cache_miss_tokens is NOT cache creation: nothing was declared
    cache_read: 64,
    thinking: 0,
    reasoningChars: 5,
  });
});

test("stop_reason is normalised onto the Anthropic vocabulary", () => {
  assert.equal(stopReasonOf({ choices: [{ finish_reason: "stop" }] }), "end_turn");
  assert.equal(stopReasonOf({ choices: [{ finish_reason: "length" }] }), "max_tokens");
  assert.equal(stopReasonOf({ choices: [{ finish_reason: "tool_calls" }] }), "tool_use");
  assert.equal(stopReasonOf({ choices: [{ finish_reason: "content_filter" }] }), "content_filter");
  assert.equal(stopReasonOf({ stop_reason: "end_turn" }), "end_turn");
  assert.equal(stopReasonOf({ choices: [{}] }), null);
});

test("countTokens estimates without a request on openai, and says so", async () => {
  const calls = stub(okToolCall());
  const got = await countTokens({
    provider: "openai",
    apiKey: "k",
    model: "deepseek-chat",
    messages: [{ role: "user", content: "x".repeat(400) }],
  });
  assert.deepEqual(got, { promptTokens: 100, source: "estimate" });
  assert.equal(calls.length, 0, "there is no count_tokens endpoint to call");
});

test("countTokens uses the real endpoint on anthropic", async () => {
  const calls = stub({ body: { input_tokens: 1234 } });
  const got = await countTokens({
    apiKey: "k",
    model: "claude-sonnet-5",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(got, { promptTokens: 1234, source: "count_tokens" });
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages/count_tokens");
});

test("judge resolution: deepseek pairs itself, other openai endpoints must be told", () => {
  assert.equal(resolveJudgeModel(undefined, "deepseek-chat", { provider: "openai" }), "deepseek-reasoner");
  assert.equal(resolveJudgeModel("deepseek-chat", "deepseek-chat", { provider: "openai" }), "deepseek-reasoner");
  assert.equal(resolveJudgeModel("gpt-x", "deepseek-chat", { provider: "openai" }), "gpt-x");
  assert.throws(
    () => resolveJudgeModel("m1", "m1", { provider: "openai", baseUrl: "https://example.test/v1" }),
    /judgeModel must differ from targetModel; pass --judge/,
  );
  // anthropic is untouched by all of the above
  assert.equal(resolveJudgeModel(undefined, "claude-sonnet-5"), "claude-opus-5");
  assert.equal(resolveJudgeModel(undefined, "claude-opus-5"), "claude-sonnet-5");
});

// One offline pass through the whole loop: the point is that provider/baseUrl actually
// reach probe_gen, the two target calls and the judge — not that the classifier works.
test("auditRules drives the whole pipeline over the openai provider", async () => {
  const toolCall = (name, args) => ({
    body: {
      choices: [
        {
          finish_reason: "tool_calls",
          message: { content: null, tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] },
        },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 2 },
    },
  });
  const say = (text) => ({
    body: { choices: [{ finish_reason: "stop", message: { content: text } }], usage: { prompt_tokens: 5, completion_tokens: 1 } },
  });

  const calls = stub(
    toolCall("submit_probes", {
      reasoning: "one probe is enough",
      probes: [{ message: "say something", criterion: { kind: "judge", description: "follows the rule" } }],
    }),
    say("bare answer"),
    say("full answer"),
    // "bare does not follow the rule, full does", answered against whichever slot bare landed in.
    (body) => {
      const shown = body.messages.at(-1).content;
      const bareIsA = shown.includes("Response A:\nbare answer");
      return toolCall("submit_verdict", {
        reasoning: "only the one with the prompt follows it",
        a_exhibits: bareIsA ? "no" : "yes",
        b_exhibits: bareIsA ? "yes" : "no",
      });
    },
  );

  const report = await auditRules({
    promptText: "RULE: always answer in one word.",
    rules: [{ id: "R1", quote: "always answer in one word", category: "mechanical", testable: true, why: "test" }],
    apiKey: "k",
    targetModel: "deepseek-chat",
    provider: "openai",
    runs: 1,
  });

  assert.equal(calls.length, 4, "probe_gen, bare, full, judge — no extra count_tokens request");
  assert.ok(calls.every((c) => c.url === "https://api.deepseek.com/chat/completions"));
  assert.equal(calls[1].body.messages.some((m) => m.role === "system"), false, "bare carries no system prompt");
  assert.equal(calls[2].body.messages[0].role, "system", "full carries the prompt as a system message");
  assert.equal(calls[3].body.model, "deepseek-reasoner", "judge is not the model under test");

  assert.equal(report.meta.provider, "openai");
  assert.equal(report.meta.baseUrl, "https://api.deepseek.com");
  assert.equal(report.meta.judgeProvider, "openai");
  assert.equal(report.meta.judgeModel, "deepseek-reasoner");
  assert.equal(report.tokens.promptTokensSource, "estimate");
  assert.equal(report.rules[0].quadrant, "effective"); // bare no / full yes
});
