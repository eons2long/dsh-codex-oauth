import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as plugin from "../lib/index.js";

let adapter;
plugin.apply({
  llm: { registerAdapter(_routes, value) { adapter = value; } },
  inject() {},
});
const models = await adapter.listModels("openai-codex");
assert.ok(models.length > 0);
assert.ok(models.some((model) => model.id === "gpt-5.6-luna"));
const client = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
assert.match(client, /__ModuleLoader__\.load/);
assert.match(client, /id:"dsh-codex-oauth"/);
console.log(`ok: ${models.length} Codex models; client loader wrapper present`);
