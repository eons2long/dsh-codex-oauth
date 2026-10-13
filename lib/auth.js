import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { createServer } from "node:http";
import { LlmError } from "@deepseek-ai/dsh-llm";
import { activeRegistration, clearTokens, CodexCredentialStore, OPENAI_CODEX_PROVIDER, authPath } from "./store.js";
import { fetchJSON, openaiFetch, OPENAI_API, OPENAI_ISSUER, responseError, readJSON } from "./openai-http.js";

const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const TERMINAL_REFRESH_ERRORS = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);
const random = () => randomBytes(32).toString("base64url");
const same = (left, right) => typeof left === "string" && typeof right === "string" && Buffer.byteLength(left) === Buffer.byteLength(right)
  && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const nowOf = (options) => options.now?.() ?? Date.now();

async function metadata(options) {
  const value = await fetchJSON(`${OPENAI_ISSUER}/.well-known/openid-configuration`, { signal: options.signal }, options.fetch);
  if (value.issuer !== OPENAI_ISSUER) throw new Error("OpenAI discovery returned an unexpected issuer");
  for (const field of ["jwks_uri", "revocation_endpoint"]) {
    const url = new URL(value[field]);
    if (url.origin !== OPENAI_ISSUER) throw new Error("OpenAI discovery returned an unexpected endpoint");
  }
  return value;
}

async function validateIdentity(token, clientId, options, nonce, subject) {
  if (typeof token !== "string") throw new Error("OpenAI did not return an ID token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("OpenAI returned an invalid ID token");
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch { throw new Error("OpenAI returned an invalid ID token"); }
  if (header.alg !== "RS256" || typeof header.kid !== "string" || header.crit !== undefined) throw new Error("Unsupported OpenAI ID-token signature");
  const discovery = await metadata(options);
  const jwks = await fetchJSON(discovery.jwks_uri, { signal: options.signal }, options.fetch);
  const key = jwks.keys?.find((key) => key.kid === header.kid && key.kty === "RSA" && (!key.use || key.use === "sig") && (!key.alg || key.alg === "RS256"));
  if (!key || !verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2], "base64url"))) {
    throw new Error("OpenAI ID-token signature validation failed");
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const now = nowOf(options) / 1000;
  if (claims.iss !== OPENAI_ISSUER || !audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId) || (claims.azp !== undefined && claims.azp !== clientId)
    || !Number.isFinite(claims.exp) || claims.exp <= now || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 30))
    || typeof claims.sub !== "string" || !claims.sub || (nonce !== undefined && !same(claims.nonce, nonce))
    || (subject !== undefined && claims.sub !== subject)) throw new Error("OpenAI ID-token identity validation failed");
  return { subject: claims.sub, issuer: claims.iss, ...(typeof claims.email === "string" ? { email: claims.email } : {}) };
}

function tokenFields(token, options, previous) {
  if (typeof token.access_token !== "string" || !token.access_token || !Number.isFinite(token.expires_in) || token.expires_in <= 0
    || String(token.token_type).toLowerCase() !== "bearer") throw new Error("OpenAI returned an invalid token response");
  if (token.refresh_token !== undefined && (typeof token.refresh_token !== "string" || !token.refresh_token)) throw new Error("OpenAI returned an invalid refresh token");
  if (token.scope !== undefined && typeof token.scope !== "string") throw new Error("OpenAI returned invalid granted scopes");
  const scopes = token.scope === undefined ? previous?.scopes ?? [] : token.scope.split(/\s+/).filter(Boolean);
  if (scopes.includes("offline_access") && !token.refresh_token) throw new Error("OpenAI did not return a rotating refresh token");
  const earliest = typeof token.earliest_refresh_at === "number"
    ? token.earliest_refresh_at * (token.earliest_refresh_at < 1e12 ? 1000 : 1)
    : Date.parse(token.earliest_refresh_at);
  return {
    access: token.access_token,
    ...(token.refresh_token ? { refresh: token.refresh_token } : {}),
    expires: nowOf(options) + token.expires_in * 1000,
    scopes,
    ...(Number.isFinite(earliest) ? { earliestRefreshAt: earliest } : {}),
  };
}

async function callbackListener(state, requestedClientId, signal, port) {
  let resolveCallback, rejectCallback;
  const callback = new Promise((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
  // Attach a handler immediately: cancellation can precede the caller awaiting the callback.
  callback.catch(() => {});
  const server = createServer((req, res) => {
    const reply = (status, text) => { res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); res.end(text); };
    let url;
    try { url = new URL(req.url, "http://127.0.0.1"); }
    catch { return reply(400, "Invalid callback URL"); }
    if (req.method !== "GET" || url.pathname !== "/auth/callback") return reply(404, "Not found");
    if (!same(url.searchParams.get("state"), state)) return reply(400, "Invalid OAuth state");
    if (url.searchParams.has("error")) {
      reply(400, "ChatGPT authorization was not completed. Return to DSH.");
      rejectCallback(new Error("ChatGPT authorization was declined or could not be completed"));
      return;
    }
    const clientId = url.searchParams.get("client_id") ?? requestedClientId;
    if (!clientId || clientId === "dynamic_agent_client" || (requestedClientId && clientId !== requestedClientId) || !url.searchParams.get("code")) {
      reply(400, "Invalid OAuth registration result");
      rejectCallback(new Error("OpenAI returned an incomplete or mismatched registration"));
      return;
    }
    reply(200, "Authorization received. Return to DSH to check that sign-in completed.");
    resolveCallback({ clientId, code: url.searchParams.get("code") });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  const abort = () => { rejectCallback(signal.reason); server.close(); server.closeAllConnections(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const listen = (listenPort) => new Promise((resolve, reject) => {
      const error = (error) => { server.off("listening", ready); reject(error); };
      const ready = () => { server.off("error", error); resolve(); };
      server.once("error", error); server.once("listening", ready); server.listen(listenPort, "127.0.0.1");
    });
    signal.throwIfAborted();
    try { await listen(port ?? 1455); }
    catch (error) { if (error.code !== "EADDRINUSE" || port !== undefined) throw error; await listen(0); }
    signal.throwIfAborted();
    return {
      redirectUri: `http://127.0.0.1:${server.address().port}/auth/callback`,
      callback,
      close() { signal.removeEventListener("abort", abort); server.close(); server.closeAllConnections(); },
    };
  } catch (error) { signal.removeEventListener("abort", abort); server.close(); throw error; }
}

export async function login(store = new CodexCredentialStore(), interaction = {}, options = {}) {
  const signal = AbortSignal.any([...(interaction.signal ? [interaction.signal] : []), ...(options.signal ? [options.signal] : []), AbortSignal.timeout(10 * 60_000)]);
  options = { ...options, signal };
  const document = await store.initialize();
  const selected = options.newAccount ? undefined : activeRegistration(document);
  const state = random(), nonce = random(), verifier = random();
  const listener = await callbackListener(state, selected?.clientId, signal, options.callbackPort);
  try {
    const url = new URL(`${OPENAI_ISSUER}/api/accounts/authorize`);
    url.search = new URLSearchParams({
      client_id: selected?.clientId ?? "dynamic_agent_client",
      ext_agent_host_id: document.hostId,
      response_type: "code", redirect_uri: listener.redirectUri, scope: SCOPES, resource: OPENAI_API,
      state, nonce, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      ...(!selected ? { agent_name_hint: "dsh-codex-oauth" } : {}),
      ...(selected?.idToken ? { id_token_hint: selected.idToken } : {}),
      ...(selected?.email ? { login_hint: selected.email } : {}),
      ...(selected?.access && !selected.scopes?.includes("chatgpt.tokens.use.direct") ? { prompt: "consent" } : {}),
    }).toString();
    if (!interaction.notify) throw new Error("OAuth login requires an authorization-URL handler");
    interaction.notify({ type: "auth_url", url: url.href });
    const { clientId, code } = await listener.callback;
    const tokens = await fetchJSON(`${OPENAI_ISSUER}/api/accounts/oauth/token`, {
      method: "POST", signal,
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: listener.redirectUri, resource: OPENAI_API }),
    }, options.fetch);
    const identity = await validateIdentity(tokens.id_token, clientId, options, nonce, selected?.subject);
    const registration = { ...identity, clientId, idToken: tokens.id_token, ...tokenFields(tokens, options) };
    await store.transaction((current) => {
      signal.throwIfAborted();
      if ((current.generation ?? 0) !== (document.generation ?? 0)) throw new Error("The selected account changed during sign-in; please retry");
      const existing = current.registrations.find((account) => account.clientId === clientId);
      if (existing && existing.subject !== identity.subject) throw new Error("OAuth registration identity changed");
      if (existing) { clearTokens(existing); Object.assign(existing, registration); }
      else current.registrations.push(registration);
      current.activeClientId = clientId;
      current.generation = (current.generation ?? 0) + 1;
    });
    return status(store);
  } finally { listener.close(); }
}

export async function getCredential(store, options = {}) {
  const initial = await store.read(OPENAI_CODEX_PROVIDER);
  if (!initial || (options.clientId && initial.clientId !== options.clientId)) throw new LlmError("Sign in to the selected ChatGPT account with dsh-openai-codex login", "AUTH");
  if (!initial.scopes.includes("chatgpt.tokens.use.direct")) throw new LlmError("ChatGPT plan usage was not authorized; sign in again to enable it", "AUTH");
  const now = nowOf(options);
  if (initial.expires > now + 60_000 || (initial.expires > now && initial.earliestRefreshAt > now)) return initial;
  let terminalError;
  const credential = await store.transaction(async (document) => {
    const current = activeRegistration(document);
    if (!current?.access || current.clientId !== initial.clientId) throw new LlmError("The selected ChatGPT account changed", "AUTH");
    const now = nowOf(options);
    if (current.expires > now + 60_000 || (current.expires > now && current.earliestRefreshAt > now)) return current;
    if (!current.refresh) throw new LlmError("ChatGPT sign-in has expired; sign in again", "AUTH");
    try {
      const tokens = await fetchJSON(`${OPENAI_ISSUER}/api/accounts/oauth/token`, {
        method: "POST", signal: options.signal,
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: current.clientId, refresh_token: current.refresh, resource: OPENAI_API }),
      }, options.fetch);
      if (tokens.id_token) await validateIdentity(tokens.id_token, current.clientId, options, undefined, current.subject);
      const fields = tokenFields(tokens, options, current);
      delete current.earliestRefreshAt;
      Object.assign(current, fields, ...(tokens.id_token ? [{ idToken: tokens.id_token }] : []));
      return current;
    } catch (error) {
      if (!TERMINAL_REFRESH_ERRORS.has(error.providerCode)) throw error;
      clearTokens(current);
      document.generation = (document.generation ?? 0) + 1;
      terminalError = new LlmError("ChatGPT sign-in is no longer valid; sign in again", "AUTH");
      return undefined;
    }
  });
  if (terminalError) throw terminalError;
  if (!credential?.scopes.includes("chatgpt.tokens.use.direct")) throw new LlmError("ChatGPT plan usage is no longer authorized", "AUTH");
  return credential;
}

export async function logout(store = new CodexCredentialStore(), options = {}) {
  let remoteRevoked = true;
  await store.transaction(async (document) => {
    const registration = activeRegistration(document);
    if (!registration?.access) return;
    if (registration.refresh) {
      remoteRevoked = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const discovery = await metadata(options);
          const response = await openaiFetch(discovery.revocation_endpoint, {
            method: "POST", signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(15_000)]),
            body: new URLSearchParams({ token: registration.refresh, token_type_hint: "refresh_token", client_id: registration.clientId }),
          }, options.fetch);
          if (!response.ok) throw responseError(await readJSON(response), response.status, response.headers, [registration.refresh]);
          remoteRevoked = true;
          break;
        } catch (error) {
          if (attempt || (error.failure?.status && error.failure.status < 500)) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    }
    clearTokens(registration);
    document.generation = (document.generation ?? 0) + 1;
  });
  return { remoteRevoked };
}

export async function accounts(store = new CodexCredentialStore()) {
  const document = await store.readDocument();
  return document?.registrations.map((registration) => ({
    clientId: registration.clientId,
    label: registration.email ? `${registration.email} (${registration.clientId.slice(-8)})` : `ChatGPT (${registration.clientId.slice(-8)})`,
    active: registration.clientId === document.activeClientId,
    authenticated: !!registration.access,
  })) ?? [];
}
export async function status(store = new CodexCredentialStore()) {
  const credential = await store.read(OPENAI_CODEX_PROVIDER);
  return credential ? {
    authenticated: true, planUsage: credential.scopes.includes("chatgpt.tokens.use.direct"),
    expiresAt: new Date(credential.expires), clientId: credential.clientId,
    label: (await accounts(store)).find((account) => account.active)?.label,
  } : { authenticated: false };
}
export { authPath };
