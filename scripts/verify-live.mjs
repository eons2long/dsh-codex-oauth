import assert from "node:assert/strict";
import { BlockAssembler } from "@deepseek-ai/dsh-llm";
import { CodexCredentialStore } from "../lib/store.js";
import { createCodexAdapter } from "../lib/adapter.js";

const provider = "openai-codex";
const model = process.argv[2] ?? "gpt-6.1-sol";
const adapter = createCodexAdapter(new CodexCredentialStore());
const tools = [{ name: "add", description: "Add two integers and return their sum", parameters: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"], additionalProperties: false } }];
const messages = [{ role: "user", content: [{ type: "text", text: "Use the add tool with a=19 and b=23, then reply only with its returned number. You must call the tool before answering." }] }];
async function turn() {
  const assembled = new BlockAssembler();
  for await (const chunk of adapter.stream({ provider, model, reasoningEffort: "low", tools, messages })) assembled.push(chunk);
  assert.ok(["stop", "tool-calls"].includes(assembled.finish.kind));
  messages.push({ role: "assistant", content: assembled.blocks(), source: { kind: "model", provider, model, replayState: assembled.replayState } });
  return assembled;
}
try {
  const catalog = await adapter.listModels(provider);
  assert.ok(catalog.some((entry) => entry.id === model), `${model} is not listed for the selected account`);
  const first = await turn();
  assert.equal(first.finish.kind, "tool-calls", "The first turn must call the offered tool");
  const calls = first.blocks().filter((block) => block.type === "tool-call");
  assert.equal(calls.length, 1);
  for (const call of calls) {
    assert.equal(call.name, "add");
    const { a, b } = JSON.parse(call.arguments);
    assert.equal(a + b, 42);
    messages.push({ role: "tool", content: [{ type: "text", text: String(a + b) }], source: { kind: "tool", callId: call.id } });
  }
  const second = await turn();
  assert.equal(second.finish.kind, "stop");
  assert.equal(second.blocks().filter((block) => block.type === "text").map((block) => block.text).join("").trim(), "42");
  messages.push({ role: "user", content: [{ type: "text", text: "What number did the tool return? Answer only with that number, without calling it again." }] });
  const third = await turn();
  assert.equal(third.finish.kind, "stop");
  assert.equal(third.blocks().filter((block) => block.type === "text").map((block) => block.text).join("").trim(), "42");
  console.log(JSON.stringify({ model, availableModels: catalog.length, toolCall: "add(19,23)", result: 42, turns: 3, replay: "passed", tokenUsage: [first.usage, second.usage, third.usage] }));
} finally { adapter.dispose(); }
