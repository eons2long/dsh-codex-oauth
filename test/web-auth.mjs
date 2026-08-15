import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerWebAuth, AUTH_LOGIN_PATH, AUTH_LOGOUT_PATH } from "../lib/web-auth.js";
import { CodexCredentialStore } from "../lib/store.js";

const root = await mkdtemp(join(tmpdir(), "dsh-web-auth-"));
const handlers = new Map();
let cleanup;
const ctx = {
  inject(_deps, callback) { callback({ webServer: { register(route) { handlers.set(route.path, route.handler); return () => {}; } } }); },
  effect(fn) { cleanup = fn(); },
};
registerWebAuth(ctx, new CodexCredentialStore(join(root, "auth.json")));
const request = { method: "POST", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:3080" } };
async function call(path) {
  let result;
  await handlers.get(path)(request, { writeHead(status, headers) { result = { status, headers }; }, end(body) { result.body = body; } });
  return result;
}
assert.equal((await call(AUTH_LOGIN_PATH)).status, 200);
assert.equal((await call(AUTH_LOGOUT_PATH)).status, 200);
assert.equal((await call(AUTH_LOGIN_PATH)).status, 200);
assert.equal((await call(AUTH_LOGOUT_PATH)).status, 200);
await cleanup;
await rm(root, { recursive: true, force: true });
console.log("ok: Web OAuth can sign in twice after logout");
