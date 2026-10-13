import assert from "node:assert/strict";
import { test } from "node:test";
import { QuotaTracker, quotaHeaders, quotaEvent, quotaSummary, quotaDetails } from "../lib/quota.js";
import { registerQuotaUi } from "../lib/quota-ui.js";
import { CodexQuotaLookup } from "../lib/quota-lookup.js";
const binding = { clientId: "test-account", generation: 1 };
const windows = (used, reset = 5000) => quotaHeaders(new Headers({
  "x-codex-primary-used-percent": String(used), "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": String(reset),
}));
test("partial, invalid and missing quota frames preserve real data; retired windows cannot be resurrected by older responses", () => {
  const tracker = new QuotaTracker(); tracker.activate(binding);
  tracker.update(binding, windows(25), 1, 1000);
  tracker.update(binding, quotaHeaders(new Headers()), 2, 2000);
  tracker.update(binding, quotaHeaders(new Headers({ "x-codex-primary-used-percent": " " })), 3, 3000);
  tracker.update(binding, quotaEvent({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 200 } } }), 4, 4000);
  assert.equal(tracker.snapshot(5000).buckets[0].windows[0].remainingPercent, 75);
  tracker.update(binding, windows(50), 7, 7000);
  tracker.update(binding, windows(10), 6, 8000);
  assert.equal(tracker.snapshot(9000).buckets[0].windows[0].remainingPercent, 50);
  tracker.update(binding, quotaEvent({ type: "codex.rate_limits", rate_limits: { primary: null } }), 8, 10000);
  tracker.update(binding, windows(10), 6, 11000);
  assert.equal(tracker.snapshot().available, false);
});
const jwt = (email) => `header.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.signature`;
const native = { idToken: jwt("person@example.test") };
function lookupFixture(fetcher) {
  let now = 1_000_000;
  let credential = { access: jwt("person@example.test"), accountId: "legacy-account", expires: 10_000_000 };
  let calls = 0;
  const lookup = new CodexQuotaLookup("/unused/auth.json", {
    now: () => now, readCredential: async () => credential,
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.authorization, `Bearer ${credential.access}`);
      assert.equal(options.headers["chatgpt-account-id"], credential.accountId);
      return fetcher(options);
    },
  });
  return { lookup, calls: () => calls, advance: (ms) => { now += ms; }, credential: (value) => { credential = value; } };
}
const wham = (used = 12, secondary = true) => new Response(JSON.stringify({ rate_limit: {
  primary_window: { used_percent: used, limit_window_seconds: 18_000, reset_at: 2000 },
  secondary_window: secondary ? { used_percent: 49, limit_window_seconds: 604_800, reset_at: 5000 } : null,
} }));
test("WHAM lookups share in-flight work, cache results, and retire absent windows", async (t) => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let secondary = true;
  const f = lookupFixture(async () => { await gate; return wham(12, secondary); });
  t.after(() => f.lookup.dispose());
  const first = f.lookup.snapshot(native, binding);
  const second = f.lookup.snapshot(native, binding);
  await new Promise(setImmediate);
  assert.equal(f.calls(), 1); release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(quotaSummary(a, 1_000_000), "codex 88% 17m 51% 1h7m");
  await f.lookup.snapshot(native, binding); assert.equal(f.calls(), 1);
  f.advance(60_000); secondary = false;
  const updated = await f.lookup.snapshot(native, binding);
  assert.equal(f.calls(), 2); assert.equal(updated.buckets[0].windows.length, 1);
});
test("failed WHAM queries preserve stale data and back off without retrying inference", async (t) => {
  let failed = false;
  const f = lookupFixture(async () => failed ? new Response("unauthorized", { status: 401 }) : wham());
  t.after(() => f.lookup.dispose());
  await f.lookup.snapshot(native, binding);
  failed = true; f.advance(301_000);
  const snapshot = await f.lookup.snapshot(native, binding);
  assert.equal(snapshot.buckets[0].windows[0].remainingPercent, 88);
  assert.equal(snapshot.buckets[0].windows[0].stale, true);
  await f.lookup.snapshot(native, binding); assert.equal(f.calls(), 2);
  f.advance(30_000); await f.lookup.snapshot(native, binding); assert.equal(f.calls(), 3);
});
test("missing, expired and unrelated legacy credentials never authorize a quota request", async (t) => {
  const f = lookupFixture(async () => wham()); t.after(() => f.lookup.dispose());
  for (const credential of [undefined, { access: jwt("person@example.test"), expires: 1 }, { access: jwt("other@example.test"), expires: 10_000_000 }]) {
    f.credential(credential);
    assert.equal((await f.lookup.snapshot(native, binding)).available, false);
  }
  assert.equal(f.calls(), 0);
});
test("sign-out or disposal aborts pending quota work and rejects late responses", async () => {
  for (const dispose of [false, true]) {
    let release; const gate = new Promise((resolve) => { release = resolve; });
    let signal;
    const f = lookupFixture(async (options) => { signal = options.signal; await gate; return wham(); });
    const pending = f.lookup.snapshot(native, binding);
    await new Promise(setImmediate);
    if (dispose) f.lookup.dispose(); else f.lookup.reset();
    assert.equal(signal.aborted, true); release();
    assert.equal((await pending).available, false);
    f.lookup.dispose();
  }
});
test("account generations and sign-out prevent stale request updates; reset expiry never fabricates remaining quota", () => {
  const tracker = new QuotaTracker(); tracker.activate(binding);
  tracker.update(binding, windows(75, 2), 1, 1000);
  const expired = tracker.snapshot(3000);
  assert.equal(expired.buckets[0].windows[0].remainingPercent, 25);
  assert.equal(expired.buckets[0].windows[0].stale, true);
  assert.equal(quotaSummary(expired, 3000), "codex 25%* 0m");
  assert.match(quotaDetails(expired, 3000), /25.0% remaining/);
  tracker.activate({ ...binding, generation: 2 });
  tracker.update(binding, windows(10), 99, 4000);
  assert.equal(tracker.snapshot().available, false);
  tracker.accountChanged({ authenticated: false, clientId: binding.clientId });
  tracker.update({ ...binding, generation: 2 }, windows(10), 100, 5000);
  assert.equal(tracker.snapshot().available, false);
});
test("quota windows are labeled by duration, with independent model buckets and unavailable reset times", () => {
  assert.equal(quotaSummary({ buckets: [{ id: "codex", windows: [
    { windowMinutes: 10080, remainingPercent: 50, resetsAt: (5 * 1440 + 4) * 60 },
    { windowMinutes: 300, remainingPercent: 81, resetsAt: (4 * 60 + 36) * 60 },
  ] }] }, 0), "codex 81% 4h36m 50% 5d4m");
  const tracker = new QuotaTracker(); tracker.activate(binding);
  const updates = quotaHeaders(new Headers({
    "x-codex-primary-used-percent": "30", "x-codex-primary-window-minutes": "10080",
    "x-codex-secondary-used-percent": "20", "x-codex-secondary-window-minutes": "300",
    "x-codex-special-primary-used-percent": "90", "x-codex-special-primary-window-minutes": "60",
    "x-codex-special-limit-name": "Special\u001b model",
  }));
  tracker.update(binding, updates, 1, 1000);
  const snapshot = tracker.snapshot(1000);
  assert.equal(snapshot.buckets.length, 2);
  assert.deepEqual(snapshot.buckets[0].windows.map(w => w.label), ["Weekly", "5h"]);
  assert.equal(snapshot.buckets[1].name.includes("\u001b"), false);
  assert.match(quotaDetails(snapshot, 1000), /reset time unavailable/);
  assert.equal(quotaSummary(snapshot, 1000), "codex 80% ? 70% ?");
});
test("TUI summary and detail command read the same quota snapshot and clean up on unload", async () => {
  const tracker = new QuotaTracker(); tracker.activate(binding);
  let command, summary, reads = 0; const cleanups = [];
  const ctx = { inject(deps, fn) { fn({
    effect(fn) { cleanups.push(fn()); },
    commands: { register(value) { command = value; return () => { command = undefined; }; } },
    tuiStatus: { set(_key, value) { summary = value; return () => { summary = undefined; }; } },
  }); } };
  registerQuotaUi(ctx, { quotas: tracker, async quotaSnapshot() { reads++; return tracker.snapshot(); } });
  await new Promise(setImmediate);
  assert.equal(summary, "codex unavailable");
  tracker.update(binding, windows(40, Math.floor(Date.now() / 1000) + 3600), 1);
  await new Promise(setImmediate);
  assert.match(summary, /^codex 60% /);
  const result = await command.handler({ rawInput: "" });
  assert.equal(command.name, "codex-usage");
  assert.equal(result.kind, "success");
  assert.match(result.text, /60.0% remaining/);
  assert.ok(reads >= 2);
  for (const cleanup of cleanups) cleanup();
  assert.equal(summary, undefined); assert.equal(command, undefined);
});
