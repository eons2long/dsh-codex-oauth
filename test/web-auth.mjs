import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { registerWebAuth, AUTH_STATUS_PATH, AUTH_LOGIN_PATH, AUTH_LOGOUT_PATH, AUTH_ACCOUNT_PATH, AUTH_MODELS_PATH } from "../lib/web-auth.js";
import { CodexCredentialStore, OPENAI_CODEX_PROVIDER } from "../lib/store.js";

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "dsh-web-auth-"));
  const handlers = new Map();
  let cleanup;
  const ctx = {
    inject(_deps, callback) { callback({ webServer: { register(route) { handlers.set(route.path, route.handler); return () => handlers.delete(route.path); } } }); },
    effect(fn) { cleanup = fn(); },
  };
  const store = new CodexCredentialStore(join(root, "auth.json"));
  registerWebAuth(ctx, store, { ...options, auth: { callbackPort: 0, fetch() { throw new Error("Cancellation must not contact OpenAI"); }, ...options.auth } });
  t.after(async () => { await cleanup(); await rm(root, { recursive: true, force: true }); });
  async function call(path, overrides = {}) {
    const request = { method: path === AUTH_STATUS_PATH ? "GET" : "POST", url: path, socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" }, ...overrides };
    let result;
    await handlers.get(path)(request, { writeHead(status, headers) { result = { status, headers }; }, end(body) { result.body = body; result.value = JSON.parse(body); } });
    return result;
  }
  return { store, call };
}

const credential = (clientId) => ({ clientId, subject: `subject-${clientId}`, issuer: "https://auth.openai.com", access: "private-access", refresh: "private-refresh", idToken: "private-id-token", expires: Date.now() + 3600000, scopes: ["chatgpt.tokens.use.direct"] });

test("Web auth rejects foreign hosts, origins and methods before creating a login", async (t) => {
  const { store, call } = await fixture(t);
  assert.equal((await call(AUTH_LOGIN_PATH, { headers: { host: "attacker.example:3080", origin: "http://attacker.example:3080" } })).status, 403);
  assert.equal((await call(AUTH_LOGIN_PATH, { headers: { host: "127.0.0.1:3080", origin: "https://attacker.example" } })).status, 403);
  assert.equal((await call(AUTH_LOGIN_PATH, { method: "GET" })).status, 405);
  assert.equal(await store.readDocument(), undefined);
});

test("cancelling a new-account login preserves the active account and permits a later login", async (t) => {
  const { store, call } = await fixture(t);
  await store.modify(OPENAI_CODEX_PROVIDER, () => credential("oaiapp_existing"));
  const saved = await store.readDocument();
  const start = await call(AUTH_LOGIN_PATH, { url: `${AUTH_LOGIN_PATH}?new_account=1` });
  assert.equal(start.status, 200);
  assert.equal(start.headers["cache-control"], "no-store");
  assert.equal((await call(AUTH_LOGOUT_PATH)).status, 200);
  assert.deepEqual(await store.readDocument(), saved);
  const reauth = await call(AUTH_LOGIN_PATH);
  assert.equal(reauth.status, 200);
  assert.equal(new URL(reauth.value.url).searchParams.has("id_token_hint"), false);
  await call(AUTH_LOGOUT_PATH);
  const status = await call(AUTH_STATUS_PATH);
  assert.equal(status.value.authenticated, true);
  for (const secret of ["private-access", "private-refresh", "private-id-token"]) assert.equal(status.body.includes(secret), false);
});

test("Web account selection and explicit model refresh update the active choices", async (t) => {
  let refreshed, notified = 0;
  const adapter = { options: { onModelsChanged() { notified++; } }, async listModels(provider, options) { refreshed = { provider, options }; return [{ id: "new-model", name: "New Model" }]; } };
  const { store, call } = await fixture(t, { adapter });
  await store.modify(OPENAI_CODEX_PROVIDER, () => credential("oaiapp_first"));
  await store.modify(OPENAI_CODEX_PROVIDER, () => credential("oaiapp_second"));
  const selected = await call(AUTH_ACCOUNT_PATH, { url: `${AUTH_ACCOUNT_PATH}?client_id=oaiapp_first` });
  assert.equal(selected.value.clientId, "oaiapp_first");
  assert.equal(selected.value.accounts.find((account) => account.active).clientId, "oaiapp_first");
  assert.deepEqual((await call(AUTH_MODELS_PATH)).value.models, [{ id: "new-model", name: "New Model" }]);
  assert.deepEqual(refreshed, { provider: "openai-codex", options: { refresh: true } });
  assert.equal(notified, 1);
});

test("Web status exposes only the active account's quota snapshot through the guarded route", async (t) => {
  const quota = { available: true, buckets: [{ id: "codex", windows: [{ label: "5h", remainingPercent: 75, checkedAt: 1000, stale: false }] }] };
  let reads = 0;
  const { store, call } = await fixture(t, { adapter: { async quotaSnapshot() { reads++; return quota; } } });
  await store.modify(OPENAI_CODEX_PROVIDER, () => credential("oaiapp_first"));
  assert.equal((await call(AUTH_STATUS_PATH, { headers: { host: "attacker.example" } })).status, 403);
  assert.equal(reads, 0);
  const result = await call(AUTH_STATUS_PATH);
  assert.deepEqual(result.value.quota, quota);
  for (const secret of ["private-access", "private-refresh", "private-id-token"]) assert.equal(result.body.includes(secret), false);
  assert.equal(reads, 1);
});
