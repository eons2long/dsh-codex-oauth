import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { QuotaTracker } from "./quota.js";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_MS = 60_000;
const FAILURE_BACKOFF_MS = 30_000;
const empty = () => ({ available: false, buckets: [] });
function claims(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()); }
  catch { return {}; }
}
function email(token) {
  const value = claims(token);
  const address = value.email ?? value["https://api.openai.com/profile"]?.email;
  return typeof address === "string" ? address.trim().toLowerCase() : undefined;
}
async function readLegacy(filename) {
  for (const path of [dirname(filename), filename]) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (process.platform !== "win32" && info.mode & 0o077)) return;
    if (path === filename && (!info.isFile() || info.size > 1_048_576)) return;
  }
  return JSON.parse(await readFile(filename, "utf8")).credential;
}
export function quotaUsage(body) {
  const groups = [{ id: "codex", rate_limit: body?.rate_limit },
    ...(Array.isArray(body?.additional_rate_limits) ? body.additional_rate_limits.map((value) => ({
      id: value?.metered_feature ?? value?.limit_name, rate_limit: value?.rate_limit,
    })) : [])];
  return groups.flatMap((group) => {
    if (typeof group.id !== "string" || !group.id || !group.rate_limit) return [];
    const windows = {};
    for (const slot of ["primary", "secondary"]) {
      const value = group.rate_limit[`${slot}_window`];
      if (!value) continue;
      const usedPercent = value.used_percent;
      if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) continue;
      windows[slot] = { usedPercent, remainingPercent: 100 - usedPercent,
        ...(Number.isSafeInteger(value.limit_window_seconds) && value.limit_window_seconds > 0 ? { windowMinutes: Math.ceil(value.limit_window_seconds / 60) } : {}),
        ...(Number.isSafeInteger(value.reset_at) && value.reset_at > 0 && value.reset_at <= 8_640_000_000_000 ? { resetsAt: value.reset_at } : {}),
      };
    }
    return Object.keys(windows).length ? [{ id: group.id.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 80), windows }] : [];
  });
}

// SIWC inference tokens do not authorize WHAM. Query with the plugin's retained
// legacy Codex login only; never borrow Pi/Codex app credentials or refresh their
// rotating tokens. Matching emails guard against unrelated accounts, but do not
// prove identical workspaces or SIWC application limits (see README).
export class CodexQuotaLookup {
  #tracker = new QuotaTracker();
  #key;
  #pending;
  #controller;
  #nextCheck = 0;
  #epoch = 0;
  #disposed = false;
  constructor(filename, options = {}) {
    this.readCredential = options.readCredential ?? (() => readLegacy(join(dirname(filename), ".openai-codex-auth.json")));
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }
  reset() {
    this.#epoch++;
    this.#controller?.abort(); this.#controller = undefined;
    this.#pending = undefined; this.#key = undefined; this.#nextCheck = 0;
    this.#tracker.clear();
  }
  dispose() { this.#disposed = true; this.reset(); }
  async snapshot(account, binding) {
    if (this.#disposed) return empty();
    const epoch = this.#epoch;
    let credential;
    try { credential = await this.readCredential(); } catch { this.reset(); return empty(); }
    if (this.#disposed) return empty();
    const address = email(account.idToken);
    if (!credential?.access || !(credential.expires > this.now()) || !address || address !== email(credential.access)) {
      this.reset(); return empty();
    }
    const key = createHash("sha256").update(JSON.stringify([binding.clientId, binding.generation, credential.accountId, credential.access, account.idToken])).digest("hex");
    if (epoch !== this.#epoch && key !== this.#key) return empty();
    if (key !== this.#key) { this.reset(); this.#key = key; this.#tracker.activate(binding); }
    if (!this.#pending && this.now() >= this.#nextCheck) {
      const controller = new AbortController();
      this.#controller = controller;
      const requestEpoch = this.#epoch;
      const request = (async () => {
        this.#nextCheck = this.now() + FAILURE_BACKOFF_MS;
        try {
          const response = await this.fetch(USAGE_URL, {
            redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
            headers: { authorization: `Bearer ${credential.access}`, ...(credential.accountId ? { "chatgpt-account-id": credential.accountId } : {}) },
          });
          if (!response.ok) { await response.body?.cancel(); return; }
          const updates = quotaUsage(await response.json());
          if (this.#disposed || requestEpoch !== this.#epoch || controller.signal.aborted) return;
          // WHAM is a complete snapshot: null/missing windows must retire old data.
          this.#tracker.clear(); this.#tracker.activate(binding);
          this.#tracker.update(binding, updates, 0, this.now());
          this.#nextCheck = this.now() + REFRESH_MS;
        } catch { /* Quota failures never affect inference or disclose credentials. */ }
      })();
      this.#pending = request;
      void request.finally(() => {
        if (this.#pending === request) { this.#pending = undefined; this.#controller = undefined; }
      });
    }
    await this.#pending;
    return this.#disposed || this.#key !== key ? empty() : this.#tracker.snapshot(this.now());
  }
}
