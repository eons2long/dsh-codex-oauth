import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexCredentialStore, OPENAI_CODEX_PROVIDER } from "../lib/store.js";
import { safeMessage } from "../lib/safe-message.js";
import * as plugin from "../lib/index.js";

const root = await mkdtemp(join(tmpdir(), "dsh-codex-oauth-"));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = root;
let adapter;
try {
  plugin.apply({
    llm: { registerAdapter(routes, value) { assert.deepEqual(routes, [OPENAI_CODEX_PROVIDER]); adapter = value; } },
    inject() {},
  });
  assert.deepEqual(await adapter.listModels(OPENAI_CODEX_PROVIDER), []);
  const client = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.ok(client.includes("__ModuleLoader__.load"));
  const store = new CodexCredentialStore(join(root, "auth.json"));
  const credential = { clientId: "oaiapp_test", subject: "test-subject", issuer: "https://auth.openai.com", access: "access", refresh: "refresh", idToken: "id-token", expires: Date.now() + 3600000, scopes: ["chatgpt.tokens.use.direct"] };
  await store.modify(OPENAI_CODEX_PROVIDER, () => credential);
  assert.deepEqual(await store.read(OPENAI_CODEX_PROVIDER), credential);
  assert.equal((await stat(store.filename)).mode & 0o777, 0o600);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  await chmod(root, 0o755);
  assert.deepEqual(await store.read(OPENAI_CODEX_PROVIDER), credential);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  await chmod(store.filename, 0o644);
  await assert.rejects(() => store.read(OPENAI_CODEX_PROVIDER), /owner-only/);
  await chmod(store.filename, 0o600);
  await store.delete(OPENAI_CODEX_PROVIDER);
  assert.equal(await store.read(OPENAI_CODEX_PROVIDER), undefined);
  assert.equal((await store.readDocument()).registrations[0].clientId, credential.clientId);
  const diagnostic = safeMessage(new Error('access_token="access-secret" refresh_token=refresh-secret https://x.test/?code=code-secret&id_token_hint=hint-secret eyJhbGciOiJfake.token.value'));
  for (const secret of ["access-secret", "refresh-secret", "code-secret", "hint-secret", "eyJhbGciOiJfake.token.value"]) assert.ok(!diagnostic.includes(secret));
  console.log("ok: native plugin, credential permissions, sign-out and secret redaction");
} finally {
  adapter?.dispose();
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
}
