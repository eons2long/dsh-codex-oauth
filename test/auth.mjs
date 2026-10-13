import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { attributionHeaders } from "@deepseek-ai/dsh-llm";
import { accounts, getCredential, login, logout, status } from "../lib/auth.js";
import { CodexCredentialStore, OPENAI_CODEX_PROVIDER } from "../lib/store.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", use: "sig", alg: "RS256" };
const issuer = "https://auth.openai.com";
const now = Date.now();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "dsh-native-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new CodexCredentialStore(join(root, "auth.json"));
  let authorize;
  const exchanges = [];
  const mock = {
    store, root, exchanges, issuedClientId: "oaiapp_test", subject: "subject-test", scope: "openid offline_access resource.invoke chatgpt.tokens.use.direct",
    changeClaims: (claims) => claims,
    async fetch(url, options) {
      for (const [name, value] of Object.entries(attributionHeaders())) assert.equal(new Headers(options.headers).get(name), value);
      if (url.endsWith("openid-configuration")) return json({ issuer, jwks_uri: `${issuer}/jwks`, revocation_endpoint: `${issuer}/revoke` });
      if (url.endsWith("/jwks")) return json({ keys: [jwk] });
      if (url.endsWith("/revoke")) {
        mock.revoked = new URLSearchParams(options.body);
        return new Response(null, { status: 200 });
      }
      assert.equal(url, `${issuer}/api/accounts/oauth/token`);
      const form = new URLSearchParams(options.body);
      exchanges.push(form);
      if (form.get("grant_type") === "refresh_token") return mock.refresh(form);
      assert.equal(form.get("client_id"), mock.issuedClientId);
      assert.equal(form.get("redirect_uri"), authorize.searchParams.get("redirect_uri"));
      assert.equal(createHash("sha256").update(form.get("code_verifier")).digest("base64url"), authorize.searchParams.get("code_challenge"));
      const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString("base64url");
      const claims = mock.changeClaims({ iss: issuer, aud: mock.issuedClientId, sub: mock.subject, email: "test@example.com", exp: now / 1000 + 3600, nonce: authorize.searchParams.get("nonce") });
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
      return json({ access_token: "access-test", refresh_token: "refresh-test", id_token: `${header}.${payload}.${signature}`, expires_in: 3600, token_type: "Bearer", scope: mock.scope });
    },
    refresh: async () => json({ access_token: "access-replacement", refresh_token: "refresh-replacement", expires_in: 3600, token_type: "Bearer" }),
    async signIn(options = {}) {
      let callbackError;
      const result = await login(store, {
        notify(event) {
          authorize = new URL(event.url);
          mock.authorize = authorize;
          const url = new URL(authorize.searchParams.get("redirect_uri"));
          url.search = new URLSearchParams({ state: authorize.searchParams.get("state"), client_id: mock.issuedClientId, code: "code-test" });
          (async () => {
            const wrong = new URL(url); wrong.searchParams.set("state", "wrong-state");
            assert.equal((await fetch(wrong)).status, 400);
            assert.equal((await fetch(url)).status, 200);
          })().catch((error) => { callbackError = error; });
        },
      }, { fetch: mock.fetch, now: () => now, callbackPort: 0, ...options });
      if (callbackError) throw callbackError;
      return result;
    },
  };
  return mock;
}

test("OAuth verifies identity, exchanges the issued client ID and keeps a stable host across reauthorization", async (t) => {
  const mock = await fixture(t);
  const first = await mock.signIn();
  assert.equal(first.planUsage, true);
  assert.equal(mock.authorize.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(mock.authorize.searchParams.get("agent_name_hint"), "dsh-codex-oauth");
  const host = mock.authorize.searchParams.get("ext_agent_host_id");
  await mock.signIn();
  assert.equal(mock.authorize.searchParams.get("client_id"), mock.issuedClientId);
  assert.equal(mock.authorize.searchParams.has("agent_name_hint"), false);
  assert.equal(mock.authorize.searchParams.get("ext_agent_host_id"), host);
  assert.equal((await stat(mock.store.filename)).mode & 0o777, 0o600);
  assert.equal((await stat(mock.root)).mode & 0o777, 0o700);
});

test("ID-token validation rejects a forged audience or nonce without replacing saved credentials", async (t) => {
  const mock = await fixture(t);
  await mock.signIn();
  const saved = await mock.store.read(OPENAI_CODEX_PROVIDER);
  mock.changeClaims = (claims) => ({ ...claims, aud: "another-client" });
  await assert.rejects(mock.signIn(), /identity validation/);
  assert.deepEqual(await mock.store.read(OPENAI_CODEX_PROVIDER), saved);
  mock.changeClaims = (claims) => ({ ...claims, nonce: "another-nonce" });
  await assert.rejects(mock.signIn(), /identity validation/);
  mock.changeClaims = (claims) => ({ ...claims, sub: "another-user" });
  await assert.rejects(mock.signIn(), /identity validation/);
  assert.deepEqual(await mock.store.read(OPENAI_CODEX_PROVIDER), saved);
});

test("identity-only authorization stays signed in but cannot perform inference", async (t) => {
  const mock = await fixture(t);
  mock.scope = "openid offline_access";
  assert.equal((await mock.signIn()).planUsage, false);
  await assert.rejects(getCredential(mock.store), /plan usage was not authorized/);
  assert.equal((await status(mock.store)).authenticated, true);
});

test("two independent stores serialize a rotating refresh and return the same replacement", async (t) => {
  const mock = await fixture(t);
  await mock.signIn();
  await mock.store.modify(OPENAI_CODEX_PROVIDER, (credential) => ({ ...credential, expires: now - 1 }));
  const started = deferred(), release = deferred();
  let refreshes = 0;
  mock.refresh = async (form) => {
    refreshes++;
    assert.equal(form.get("client_id"), mock.issuedClientId);
    assert.equal(form.get("refresh_token"), "refresh-test");
    assert.equal(form.get("resource"), "https://api.openai.com/v1");
    assert.equal(form.has("scope"), false);
    started.resolve(); await release.promise;
    return json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, token_type: "Bearer" });
  };
  const options = { fetch: mock.fetch, now: () => now };
  const first = getCredential(mock.store, options);
  await started.promise;
  const second = getCredential(new CodexCredentialStore(mock.store.filename), options);
  release.resolve();
  const values = await Promise.all([first, second]);
  assert.equal(refreshes, 1);
  assert.equal(values[0].access, "new-access");
  assert.deepEqual(values[0], values[1]);
  assert.equal((await mock.store.read(OPENAI_CODEX_PROVIDER)).refresh, "new-refresh");
});

test("temporary refresh failure preserves credentials, terminal invalid_grant clears tokens but keeps the registration", async (t) => {
  const mock = await fixture(t);
  await mock.signIn();
  await mock.store.modify(OPENAI_CODEX_PROVIDER, (credential) => ({ ...credential, expires: now - 1 }));
  const saved = await mock.store.read(OPENAI_CODEX_PROVIDER);
  mock.refresh = async () => json({ error: "temporarily_unavailable" }, 503);
  await assert.rejects(getCredential(mock.store, { fetch: mock.fetch, now: () => now }), (error) => error.failure.status === 503);
  assert.deepEqual(await mock.store.read(OPENAI_CODEX_PROVIDER), saved);
  mock.refresh = async () => json({ error: "invalid_grant" }, 400);
  await assert.rejects(getCredential(mock.store, { fetch: mock.fetch, now: () => now }), /no longer valid/);
  assert.equal((await status(mock.store)).authenticated, false);
  assert.equal((await accounts(mock.store))[0].clientId, mock.issuedClientId);
});

test("sign-out revokes the selected session, retains its registration and leaves other accounts intact", async (t) => {
  const mock = await fixture(t);
  await mock.signIn();
  mock.issuedClientId = "oaiapp_other";
  mock.subject = "other-subject";
  await mock.signIn({ newAccount: true });
  assert.equal((await accounts(mock.store)).length, 2);
  assert.deepEqual(await logout(mock.store, { fetch: mock.fetch }), { remoteRevoked: true });
  assert.equal(mock.revoked.get("client_id"), "oaiapp_other");
  assert.equal((await status(mock.store)).authenticated, false);
  await mock.store.select("oaiapp_test");
  assert.equal((await status(mock.store)).authenticated, true);
});
