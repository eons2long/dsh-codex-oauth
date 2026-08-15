import assert from "node:assert/strict";
import * as plugin from "../lib/index.js";

let adapter;
plugin.apply({
  llm: { registerAdapter(_routes, value) { adapter = value; } },
  inject() {},
});
const models = await adapter.listModels("openai-codex");
assert.ok(models.length > 0);
assert.ok(models.some((model) => model.id === "gpt-5.6-luna"));
console.log(`ok: ${models.length} Codex models`);
