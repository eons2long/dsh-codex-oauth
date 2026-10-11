import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai";
import { createCodexAdapter } from "../lib/adapter.js";
import { OPENAI_CODEX_PROVIDER } from "../lib/store.js";

// No files, real credentials, OAuth refresh, or model requests are needed.
const credentials = {
  async read(provider) {
    assert.equal(provider, OPENAI_CODEX_PROVIDER);
    return { type: "api_key", key: "adapter-test-bearer" };
  },
};
const adapter = createCodexAdapter(credentials);
const models = await adapter.listModels(OPENAI_CODEX_PROVIDER);
assert.ok(models.length > 0);
for (const model of models) {
  const resolved = await adapter.resolveModel(OPENAI_CODEX_PROVIDER, model.id);
  assert.equal(resolved.provider, OPENAI_CODEX_PROVIDER);
  assert.equal(resolved.id, model.id);
  assert.ok(resolved.context.contextWindow > 0);
}

// Exercise the auth options used by the adapter's model collection, rather
// than passing an explicit API key that would hide a missing credential store.
const collection = createModels(adapter.config.auth);
for (const profile of adapter.config.profiles().values()) {
  collection.setProvider(profile.piProvider);
}
assert.equal(
  (await collection.getAuth(OPENAI_CODEX_PROVIDER))?.auth.apiKey,
  "adapter-test-bearer",
);
console.log(`ok: ${models.length} Codex model descriptors and adapter credential resolution`);
