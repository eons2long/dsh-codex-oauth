import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import { BlockAssembler, LlmRuntime, attributionHeaders } from "@deepseek-ai/dsh-llm";
import { createCodexAdapter } from "../lib/adapter.js";
import { CodexCredentialStore, OPENAI_CODEX_PROVIDER } from "../lib/store.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
test("adapter quota display reads only its sibling legacy login and leaves both credentials unchanged", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dsh-quota-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = `header.${Buffer.from(JSON.stringify({ email: "person@example.test" })).toString("base64url")}.signature`;
  const store = new CodexCredentialStore(join(root, "native.json"));
  await store.modify(OPENAI_CODEX_PROVIDER, () => ({ clientId: "oaiapp_test", subject: "test-subject", issuer: "https://auth.openai.com", access: "native-access", idToken: token, expires: Date.now() + 3600000, scopes: ["chatgpt.tokens.use.direct"] }));
  const legacyPath = join(root, ".openai-codex-auth.json");
  await writeFile(legacyPath, JSON.stringify({ credential: { access: token, accountId: "legacy-account", expires: Date.now() + 3600000 } }), { mode: 0o600 });
  const before = await Promise.all([readFile(store.filename, "utf8"), readFile(legacyPath, "utf8")]);
  let calls = 0;
  const adapter = createCodexAdapter(store, undefined, { async fetch(url, options) {
    calls++; assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    return json({ rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000 }, secondary_window: { used_percent: 49, limit_window_seconds: 604800 } } });
  } });
  t.after(() => adapter.dispose());
  assert.equal((await adapter.quotaSnapshot()).buckets[0].windows[0].remainingPercent, 88);
  await adapter.quotaSnapshot(); assert.equal(calls, 1);
  assert.deepEqual(await Promise.all([readFile(store.filename, "utf8"), readFile(legacyPath, "utf8")]), before);
  await store.delete(OPENAI_CODEX_PROVIDER);
  assert.equal((await adapter.quotaSnapshot()).available, false);
  assert.equal(calls, 1);
});
const baseCatalog = [
  { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility: "list", context_window: 272000, input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "low", description: "Fast" }, { effort: "high", description: "Deep" }], default_reasoning_level: "low" },
  { slug: "future-model", display_name: "Future Model", visibility: "list" },
  { slug: "hidden-model", display_name: "Hidden Model", visibility: "hide" },
];
const usage = { input_tokens: 100, output_tokens: 25, total_tokens: 125, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 5 } };
function responseStream(events, headers = { "content-type": "text/event-stream" }) {
  const bytes = new TextEncoder().encode(events.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n");
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) { if (offset === bytes.length) return controller.close(); const end = Math.min(bytes.length, offset + 17); controller.enqueue(bytes.slice(offset, end)); offset = end; } }), { headers });
}
function textEvents(text = "你好，native") {
  const item = { type: "message", id: "msg-test", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  return [
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp-test", status: "completed", output: [item], usage } },
  ];
}
async function fixture(t, attachments) {
  const root = await mkdtemp(join(tmpdir(), "dsh-native-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new CodexCredentialStore(join(root, "auth.json"));
  await store.modify(OPENAI_CODEX_PROVIDER, () => ({ clientId: "oaiapp_test", subject: "test-subject", issuer: "https://auth.openai.com", access: "test-access", refresh: "test-refresh", idToken: "test-id-token", expires: Date.now() + 3600000, scopes: ["chatgpt.tokens.use.direct"] }));
  const requests = [];
  const mock = { store, requests, requestHeaders: [], models: structuredClone(baseCatalog), stream: () => responseStream(textEvents()), catalogCalls: 0 };
  const adapter = createCodexAdapter(store, () => attachments, {
    async fetch(url, options) {
      for (const [name, value] of Object.entries(attributionHeaders())) assert.equal(new Headers(options.headers).get(name), value);
      if (url.endsWith("/models")) { mock.catalogCalls++; await mock.beforeCatalog?.(); return json({ models: mock.models }); }
      assert.equal(url, "https://api.openai.com/v1/responses");
      assert.equal(new Headers(options.headers).get("authorization"), "Bearer test-access");
      requests.push(JSON.parse(options.body));
      mock.requestHeaders.push(new Headers(options.headers));
      return mock.stream(options);
    },
  });
  mock.adapter = adapter;
  t.after(() => adapter.dispose());
  mock.options = { provider: OPENAI_CODEX_PROVIDER, model: "gpt-6.1-sol", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };
  return mock;
}
async function collect(iterable) { const chunks = []; for await (const chunk of iterable) chunks.push(chunk); return chunks; }

test("catalog displays current account models in server order and refreshes new model metadata", async (t) => {
  const mock = await fixture(t);
  assert.deepEqual((await mock.adapter.listModels(OPENAI_CODEX_PROVIDER)).map((model) => model.id), ["gpt-6.1-sol", "future-model"]);
  const first = await mock.adapter.resolveModel(OPENAI_CODEX_PROVIDER, "gpt-6.1-sol");
  assert.equal(first.context.contextWindow, 272000);
  assert.equal(first.reasoning.defaultEffort, "low");
  assert.equal(mock.catalogCalls, 1);
  mock.models.unshift({ slug: "new-release", visibility: "list", display_name: "New Release" });
  assert.equal((await mock.adapter.listModels(OPENAI_CODEX_PROVIDER, { refresh: true }))[0].id, "new-release");
  await mock.store.delete(OPENAI_CODEX_PROVIDER);
  assert.deepEqual(await mock.adapter.listModels(OPENAI_CODEX_PROVIDER), []);
});

test("UTF-8 SSE becomes DSH blocks, uncached token usage and a single terminal finish, including a missing Content-Type", async (t) => {
  const mock = await fixture(t);
  mock.stream = () => responseStream(textEvents(), {});
  const chunks = await collect(mock.adapter.stream(mock.options));
  assert.equal(chunks.filter((chunk) => chunk.type === "finish").length, 1);
  assert.equal(chunks.at(-1).reason.kind, "stop");
  const assembler = new BlockAssembler(); chunks.forEach((chunk) => assembler.push(chunk));
  assert.deepEqual(assembler.blocks(), [{ type: "text", text: "你好，native" }]);
  assert.deepEqual(assembler.usage, { inputTokens: 60, outputTokens: 25, cacheReadTokens: 40, totalTokens: 125, reasoningTokens: 5 });
  assert.equal(mock.requests[0].store, false); assert.equal(mock.requests[0].stream, true);
  assert.equal(mock.requests[0].input[0].role, "user");
});

test("tool calls round-trip raw arguments and completed encrypted reasoning through durable DSH replay", async (t) => {
  const mock = await fixture(t);
  const args = '{"a": 2, "b":3}';
  const reason = { type: "reasoning", id: "rs-test", summary: [], encrypted_content: "completed-encrypted-reasoning" };
  const call = { type: "function_call", id: "fc-test", call_id: "call-test", name: "add", namespace: "dsh", arguments: args, status: "completed" };
  mock.stream = () => responseStream([
    { type: "response.output_item.added", output_index: 0, item: { ...reason, encrypted_content: "incomplete-encrypted-reasoning" } },
    { type: "response.output_item.done", output_index: 0, item: reason },
    { type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: args },
    { type: "response.output_item.done", output_index: 1, item: call },
    { type: "response.completed", response: { id: "resp-tool", status: "completed", output: [reason, call], usage } },
  ]);
  const tools = [{ name: "add", description: "Add numbers", parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } }];
  const chunks = await collect(mock.adapter.stream({ ...mock.options, tools }));
  const assembler = new BlockAssembler(); chunks.forEach((chunk) => assembler.push(chunk));
  assert.equal(assembler.finish.kind, "tool-calls");
  assert.equal(assembler.blocks()[1].arguments, args);
  const assistant = { role: "assistant", content: assembler.blocks(), source: { kind: "model", provider: OPENAI_CODEX_PROVIDER, model: mock.options.model, replayState: JSON.parse(JSON.stringify(assembler.replayState)) } };
  mock.stream = () => responseStream(textEvents("5"));
  await collect(mock.adapter.stream({ ...mock.options, tools, messages: [...mock.options.messages, assistant, { role: "tool", source: { kind: "tool", callId: "call-test" }, content: [{ type: "text", text: "5" }] }] }));
  const request = mock.requests[1];
  assert.equal(request.tools[0].type, "namespace");
  assert.equal(request.tools[0].tools[0].strict, false);
  assert.deepEqual(request.input[1], reason);
  assert.deepEqual(request.input[2], call);
  assert.deepEqual(request.input[3], { type: "function_call_output", call_id: "call-test", output: [{ type: "input_text", text: "5" }] });
  assert.equal(request.previous_response_id, undefined);
  const changed = structuredClone(assistant); changed.content[0].text = "edited summary";
  await collect(mock.adapter.stream({ ...mock.options, tools, messages: [...mock.options.messages, changed] }));
  assert.equal(mock.requests[2].input.some((item) => item.type === "reasoning"), false);
});

test("historical tool IDs fit the Responses limit without merging calls or losing result correlation", async (t) => {
  const mock = await fixture(t);
  const callPrefix = `call_${"a".repeat(27)}`;
  const legacyA = `${callPrefix}|fc_${"b".repeat(55)}`;
  const legacyB = `${callPrefix}|fc_${"b".repeat(54)}c`;
  const ids = [legacyA, legacyB, callPrefix, "x".repeat(64), "x".repeat(65), "other_provider:".repeat(20)];
  const messages = [...mock.options.messages, {
    role: "assistant", source: { kind: "model", provider: OPENAI_CODEX_PROVIDER, model: "gpt-6-sol" },
    content: ids.map((id, index) => ({ type: "tool-call", id, name: "add", arguments: JSON.stringify({ a: index, b: 1 }) })),
  }, ...ids.toReversed().map((id, index) => ({ role: "tool", source: { kind: "tool", callId: id }, content: [{ type: "text", text: String(ids.length - index) }] }))];
  const saved = structuredClone(messages);
  mock.stream = () => {
    for (const item of mock.requests.at(-1).input) if (item.call_id !== undefined) {
      assert.ok(item.call_id.length <= 64, `Responses rejected a ${item.call_id.length}-character call_id`);
    }
    return responseStream(textEvents("done"));
  };
  await collect(mock.adapter.stream({ ...mock.options, messages }));
  const input = mock.requests[0].input;
  const calls = input.filter((item) => item.type === "function_call");
  const results = input.filter((item) => item.type === "function_call_output");
  assert.equal(new Set(calls.map((item) => item.call_id)).size, ids.length);
  assert.equal(calls[2].call_id, callPrefix);
  assert.equal(calls[3].call_id, ids[3]);
  for (const [index, call] of calls.entries()) {
    const output = results.find((item) => item.call_id === call.call_id);
    assert.equal(output.output[0].text, String(index + 1));
  }
  await collect(mock.adapter.stream({ ...mock.options, messages }));
  assert.deepEqual(mock.requests[1].input, input);
  assert.deepEqual(messages, saved);
});

test("streamed usage-limit failure and an interrupted stream cannot be mistaken for success", async (t) => {
  const mock = await fixture(t);
  mock.stream = () => responseStream([...textEvents().slice(0,3), { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "App usage limit reached" } } }]);
  const finishes = [];
  await assert.rejects((async () => { for await (const chunk of mock.adapter.stream(mock.options)) if (chunk.type === "finish") finishes.push(chunk); })(), (error) => error.code === "ACCOUNT_QUOTA_EXCEEDED");
  assert.equal(finishes.length, 0);
  mock.stream = () => responseStream(textEvents().slice(0,3));
  await assert.rejects(collect(mock.adapter.stream(mock.options)), (error) => error.code === "TRANSPORT");
});

test("prepared calls cannot dispatch after switching accounts", async (t) => {
  const mock = await fixture(t);
  const prepared = await mock.adapter.prepareCall(OPENAI_CODEX_PROVIDER, "gpt-6.1-sol");
  await mock.store.modify(OPENAI_CODEX_PROVIDER, (current) => ({ ...current, clientId: "oaiapp_other", subject: "other-subject" }));
  await assert.rejects(collect(prepared.stream(mock.options)), (error) => error.code === "AUTH");
  assert.equal(mock.requests.length, 0);
});

test("switching away and back during model discovery cannot bind stale account metadata", async (t) => {
  const mock = await fixture(t);
  let started, release;
  const reading = new Promise((resolve) => { started = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  t.after(release);
  mock.beforeCatalog = async () => { started(); await blocked; };
  const preparing = mock.adapter.prepareCall(OPENAI_CODEX_PROVIDER, "gpt-6.1-sol");
  await reading;
  const otherProcess = new CodexCredentialStore(mock.store.filename);
  await otherProcess.modify(OPENAI_CODEX_PROVIDER, (current) => ({ ...current, clientId: "oaiapp_other", subject: "other-subject" }));
  await otherProcess.select("oaiapp_test");
  release();
  await assert.rejects(preparing, (error) => error.code === "AUTH");
  assert.equal(mock.requests.length, 0);
  await mock.adapter.listModels(OPENAI_CODEX_PROVIDER);
  assert.equal(mock.catalogCalls, 2);
});

test("caller cancellation closes a stalled response stream promptly", async (t) => {
  const mock = await fixture(t);
  let opened;
  const streamOpened = new Promise((resolve) => { opened = resolve; });
  let cancelled = false;
  mock.stream = () => {
    opened();
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
  };
  const controller = new AbortController();
  const pending = collect(mock.adapter.stream({ ...mock.options, signal: controller.signal }));
  await streamOpened;
  controller.abort(new Error("test cancellation"));
  await assert.rejects(pending, /test cancellation/);
  assert.equal(cancelled, true);
});

test("images use attachment request bytes, while offloaded images and files remain local handles", async (t) => {
  const image = { attachmentId: "sha256:image", width: 800, height: 600, name: "test.png" };
  const reads = [];
  const attachments = { async readImageRequest(ref, target) { reads.push({ ref, target }); return { bytes: 3, data: new Uint8Array([1,2,3]), mediaType: "image/png", width: 800, height: 600 }; } };
  const mock = await fixture(t, attachments);
  await collect(mock.adapter.stream({ ...mock.options, messages: [{ role: "user", content: [{ type: "image", attachment: image }, { type: "image", attachment: image, offloaded: true }, { type: "file", attachment: { attachmentId: "sha256:abcdabcd", name: "notes.txt", bytes: 10 } }] }] }));
  assert.equal(reads.length, 1);
  const content = mock.requests[0].input[0].content;
  assert.equal(content[1].image_url, "data:image/png;base64,AQID");
  assert.match(content[2].text, /image omitted/);
  assert.match(content[3].text, /notes.txt/);
});

test("unsupported request options fail before inference, and system instructions never use a system input role", async (t) => {
  const mock = await fixture(t);
  for (const unsupported of [{ temperature: 0 }, { maxTokens: 65536 }, { stop: ["END"] }]) {
    await assert.rejects(collect(mock.adapter.stream({ ...mock.options, ...unsupported })), (error) => error.code === "UNSUPPORTED_OPTION");
  }
  assert.equal(mock.requests.length, 0);
  await collect(mock.adapter.stream({ ...mock.options, messages: [{ role: "system", content: [{ type: "text", text: "Follow the user's request" }] }, ...mock.options.messages] }));
  assert.equal(mock.requests[0].instructions, "Follow the user's request");
  assert.equal(mock.requests[0].input.some((item) => item.role === "system"), false);
});

test("DSH's compaction summarizer accepts its automatic output budget without sending unsupported API fields", async (t) => {
  const mock = await fixture(t);
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  await ctx.plugin({ name: "test-compaction-adapter", inject: ["llm"], apply(ctx) { ctx.llm.registerAdapter([OPENAI_CODEX_PROVIDER], mock.adapter); } });
  const engine = new BasicCompactionEngine(ctx, { auto: false, maxTokens: 65536 });
  const messages = [{ role: "system", content: [{ type: "text", text: "Continue the coding task." }] }, ...mock.options.messages];
  const tools = [{ name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }];
  await collect(ctx.llm.stream({ ...mock.options, messages, tools, sessionId: "compaction-regression" }));
  const ordinary = mock.requests[0];
  mock.stream = () => responseStream(textEvents("Checkpoint: preserve the task, decisions and remaining work."));
  const result = await engine.summarize({ messages, tools }, {
    options: {}, session: { id: "compaction-regression", requestHeader: () => ({ config: { provider: mock.options.provider, model: mock.options.model } }), toolHistory: () => [] },
  });
  assert.deepEqual(result.summary, [{ type: "text", text: "Checkpoint: preserve the task, decisions and remaining work." }]);
  assert.equal(result.llmStreamCall, true);
  assert.equal(mock.requests.length, 2);
  const compact = mock.requests[1];
  assert.equal(compact.instructions, ordinary.instructions);
  assert.deepEqual(compact.tools, ordinary.tools);
  assert.deepEqual(compact.input.slice(0, ordinary.input.length), ordinary.input);
  assert.equal(compact.input.at(-1).role, "user");
  assert.notEqual(compact.input.at(-1).content[0].text, "hello");
  assert.equal(Object.hasOwn(compact, "max_output_tokens"), false);
  assert.equal(Object.hasOwn(compact, "maxTokens"), false);
  for (const header of ["session-id", "x-client-request-id"]) {
    assert.equal(mock.requestHeaders[0].get(header), "compaction-regression");
    assert.equal(mock.requestHeaders[1].get(header), mock.requestHeaders[0].get(header));
  }
  for (const unsupported of [{ temperature: 0 }, { stop: ["END"] }]) {
    const failed = await collect(ctx.llm.stream({ ...mock.options, ...unsupported, purpose: "compaction", maxTokens: 65536 }));
    assert.equal(failed.at(-1).reason.failure.code, "UNSUPPORTED_OPTION");
  }
  assert.equal(mock.requests.length, 2);
});

test("DSH session affinity stays stable across turns and independent sessions never share it", async (t) => {
  const mock = await fixture(t);
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  await ctx.plugin({ name: "test-session-affinity", inject: ["llm"], apply(ctx) { ctx.llm.registerAdapter([OPENAI_CODEX_PROVIDER], mock.adapter); } });
  const firstSession = "d23e3ea2-e47b-43f8-80e5-8e1df1e421a1";
  const secondSession = "ca39e844-27e5-40ca-ad2b-2e42e1beea7f";
  await collect(ctx.llm.stream({ ...mock.options, sessionId: firstSession }));
  await collect(ctx.llm.stream({ ...mock.options, sessionId: firstSession, messages: [...mock.options.messages,
    { role: "assistant", source: { kind: "model", provider: mock.options.provider, model: mock.options.model }, content: [{ type: "text", text: "First answer" }] },
    { role: "user", content: [{ type: "text", text: "Continue" }] },
  ] }));
  await collect(ctx.llm.stream({ ...mock.options, sessionId: secondSession }));
  await collect(ctx.llm.stream(mock.options));
  for (const header of ["session-id", "x-client-request-id"]) {
    assert.deepEqual(mock.requestHeaders.map((headers) => headers.get(header)), [firstSession, firstSession, secondSession, null]);
  }
});

test("official DSH runtime binds model metadata, applies reasoning defaults and normalizes stream failures", async (t) => {
  const mock = await fixture(t);
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  await ctx.plugin({ name: "test-codex-adapter", inject: ["llm"], apply(ctx) { ctx.llm.registerAdapter([OPENAI_CODEX_PROVIDER], mock.adapter); } });
  const call = await ctx.llm.prepareCall({ provider: OPENAI_CODEX_PROVIDER, model: "gpt-6.1-sol" });
  assert.equal(call.context.contextWindow, 272000);
  assert.equal(call.config.reasoningEffort, "low");
  const chunks = await collect(call.stream({ ...mock.options, ...call.config }));
  assert.equal(chunks.at(-1).reason.kind, "stop");
  mock.stream = () => responseStream([{ type: "response.failed", response: { error: { code: "subscription_sharing_usage_unavailable", message: "Usage unavailable" } } }]);
  const failed = await collect(ctx.llm.stream(mock.options));
  assert.equal(failed.at(-1).reason.kind, "error");
  assert.equal(failed.at(-1).reason.failure.code, "SERVER");
});

test("quota headers and stream events update account-scoped UI data without changing model output", async (t) => {
  const mock = await fixture(t);
  const reset = Math.floor(Date.now() / 1000) + 3600;
  mock.stream = () => responseStream(textEvents("Answer"), { "content-type": "text/event-stream",
    "x-codex-primary-used-percent": "25", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": String(reset),
    "x-codex-secondary-used-percent": "60", "x-codex-secondary-window-minutes": "10080",
  });
  await collect(mock.adapter.stream(mock.options));
  const initial = await mock.adapter.quotaSnapshot();
  assert.deepEqual(initial.buckets[0].windows.map((w) => [w.label, w.remainingPercent]), [["5h", 75], ["Weekly", 40]]);
  assert.equal(initial.buckets[0].windows[0].resetsAt, reset);
  mock.stream = () => responseStream([{ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 30, window_minutes: 300, reset_at: reset } } }, ...textEvents("Answer")]);
  const assembler = new BlockAssembler();
  for (const chunk of await collect(mock.adapter.stream(mock.options))) assembler.push(chunk);
  assert.deepEqual(assembler.blocks(), [{ type: "text", text: "Answer" }]);
  assert.equal(assembler.finish.kind, "stop");
  const updated = await mock.adapter.quotaSnapshot();
  assert.deepEqual(updated.buckets[0].windows.map((w) => w.remainingPercent), [70, 40]);
  mock.stream = () => responseStream(textEvents());
  await collect(mock.adapter.stream(mock.options));
  assert.deepEqual(await mock.adapter.quotaSnapshot(), updated);
  mock.stream = () => new Response(JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "Usage limit reached" } }), {
    status: 429, headers: { "content-type": "application/json", "x-codex-primary-used-percent": "100", "x-codex-primary-window-minutes": "300" },
  });
  await assert.rejects(collect(mock.adapter.stream(mock.options)), (error) => error.code === "ACCOUNT_QUOTA_EXCEEDED");
  assert.equal((await mock.adapter.quotaSnapshot()).buckets[0].windows[0].remainingPercent, 0);
  await mock.store.modify(OPENAI_CODEX_PROVIDER, (current) => ({ ...current, clientId: "oaiapp_other", subject: "other-subject" }));
  assert.deepEqual(await mock.adapter.quotaSnapshot(), { available: false, buckets: [] });
  assert.equal(mock.requests.length, 4);
});
