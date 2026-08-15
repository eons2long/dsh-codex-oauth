import { login, logout, status } from "./auth.js";

export const AUTH_STATUS_PATH = "/plugins/dsh-codex-oauth/auth/status";
export const AUTH_LOGIN_PATH = "/plugins/dsh-codex-oauth/auth/login";
export const AUTH_LOGOUT_PATH = "/plugins/dsh-codex-oauth/auth/logout";

function safeMessage(error) {
  return String(error?.message ?? error)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]")
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]")
    .slice(0, 500);
}
function trusted(req) {
  const remote = req.socket.remoteAddress;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  if (!req.headers.host) return false;
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === new URL(`http://${req.headers.host}`).host; }
  catch { return false; }
}
function json(res, statusCode, value) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(value));
}

export function registerWebAuth(ctx, store) {
  let operation;
  let challenge;
  let state = { status: "signed-out" };
  const cancellation = new AbortController();
  const update = () => status(store).then((value) => { state = value.authenticated ? { status: "signed-in" } : { status: "signed-out" }; return state; });
  const start = () => {
    if (operation) return;
    state = { status: "signing-in" };
    challenge = undefined;
    operation = login(store, {
      signal: cancellation.signal,
      prompt: async (prompt) => prompt.type === "select" ? "browser" : new Promise((_resolve, reject) => cancellation.signal.addEventListener("abort", () => reject(cancellation.signal.reason), { once: true })),
      notify: (event) => { if (event.type === "auth_url") challenge = { url: event.url }; },
    }).then(update, (error) => { state = { status: "error", message: safeMessage(error) }; }).finally(() => { operation = undefined; });
  };
  ctx.inject(["webServer"], (web) => ctx.effect(() => {
    const routes = [
      web.webServer.register({ kind: "exact", path: AUTH_STATUS_PATH, handler: async (req, res) => {
        if (req.method !== "GET" || !trusted(req)) return json(res, req.method === "GET" ? 403 : 405, { error: "forbidden" });
        if (!operation) await update();
        json(res, 200, state);
      }}),
      web.webServer.register({ kind: "exact", path: AUTH_LOGIN_PATH, handler: async (req, res) => {
        if (req.method !== "POST" || !trusted(req)) return json(res, req.method === "POST" ? 403 : 405, { error: "forbidden" });
        try { start(); for (let i = 0; i < 50 && !challenge && operation; i++) await new Promise((resolve) => setTimeout(resolve, 100)); if (!challenge) throw new Error("OAuth URL was not created"); json(res, 200, challenge); }
        catch (error) { json(res, 500, { error: safeMessage(error) }); }
      }}),
      web.webServer.register({ kind: "exact", path: AUTH_LOGOUT_PATH, handler: async (req, res) => {
        if (req.method !== "POST" || !trusted(req)) return json(res, req.method === "POST" ? 403 : 405, { error: "forbidden" });
        cancellation.abort(new Error("sign-in cancelled")); await operation?.catch(() => {}); await logout(store); state = { status: "signed-out" }; json(res, 200, { ok: true });
      }}),
    ];
    return async () => { cancellation.abort(new Error("plugin disposed")); await operation?.catch(() => {}); for (const dispose of routes) dispose(); };
  }, "dsh-codex-oauth: Web OAuth routes"));
}
