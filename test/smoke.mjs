import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels } from "@earendil-works/pi-ai";
import { CodexCredentialStore, OPENAI_CODEX_PROVIDER } from "../lib/store.js";
import { safeMessage } from "../lib/safe-message.js";
import * as plugin from "../lib/index.js";

let adapter;
plugin.apply({
  llm: { registerAdapter(_routes, value) { adapter = value; } },
  inject() {},
});
const models = await adapter.listModels("openai-codex");
assert.ok(models.length > 0);
assert.ok(models.some((model) => model.id === "gpt-5.6-luna"));
const profile = [...adapter.config.profiles().values()][0];
const bearerModels = createModels();
bearerModels.setProvider(profile.piProvider);
assert.equal((await bearerModels.getAuth(OPENAI_CODEX_PROVIDER, { apiKey: "test-bearer" }))?.auth.apiKey, "test-bearer");
const client = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
assert.match(client, /__ModuleLoader__\.load/);
assert.match(client, /id:"dsh-codex-oauth"/);

const root = await mkdtemp(join(tmpdir(), "dsh-codex-oauth-"));
const filename = join(root, "auth.json");
const store = new CodexCredentialStore(filename);
const credential = { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000, accountId: "account" };
await store.modify(OPENAI_CODEX_PROVIDER, () => credential);
assert.deepEqual(await store.read(OPENAI_CODEX_PROVIDER), credential);
assert.equal((await stat(filename)).mode & 0o777, 0o600);
assert.equal((await stat(root)).mode & 0o777, 0o700);
await chmod(root, 0o755);
assert.deepEqual(await store.read(OPENAI_CODEX_PROVIDER), credential);
assert.equal((await stat(root)).mode & 0o777, 0o700);
await chmod(filename, 0o644);
await assert.rejects(() => store.read(OPENAI_CODEX_PROVIDER), /owner-only/);
await chmod(filename, 0o600);
await store.delete(OPENAI_CODEX_PROVIDER);
await rm(root, { recursive: true, force: true });

const diagnostic = safeMessage(new Error('access_token="access-secret" refresh_token=refresh-secret https://x.test/?code=code-secret eyJhbGciOiJfake.token.value'));
assert.ok(!diagnostic.includes("access-secret"));
assert.ok(!diagnostic.includes("refresh-secret"));
assert.ok(!diagnostic.includes("code-secret"));
assert.ok(!diagnostic.includes("eyJhbGciOiJfake.token.value"));
console.log(`ok: ${models.length} Codex models; client, store, and redaction checks passed`);
