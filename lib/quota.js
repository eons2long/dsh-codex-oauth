const MAX_RESET_SECONDS = 8_640_000_000_000;
const safeLabel = (value) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 80) : undefined;
function windowValue(used, minutes, reset) {
  if (used === null || used === undefined || (typeof used === "string" && !used.trim())) return undefined;
  const usedPercent = Number(used);
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return undefined;
  const windowMinutes = Number(minutes);
  const resetsAt = Number(reset);
  if (usedPercent === 0 && minutes !== null && minutes !== undefined && windowMinutes === 0 && !reset) return null;
  return { usedPercent, remainingPercent: 100 - usedPercent,
    ...(Number.isSafeInteger(windowMinutes) && windowMinutes > 0 ? { windowMinutes } : {}),
    ...(Number.isSafeInteger(resetsAt) && resetsAt > 0 && resetsAt <= MAX_RESET_SECONDS ? { resetsAt } : {}),
  };
}
export function quotaHeaders(headers) {
  const buckets = [];
  const prefixes = new Set();
  for (const key of headers.keys()) {
    const match = /^(x-codex(?:-[a-z0-9-]+)?)-(?:primary|secondary)-used-percent$/.exec(key);
    if (match) prefixes.add(match[1]);
  }
  for (const prefix of prefixes) {
    const bucket = { id: prefix.slice(2), name: safeLabel(headers.get(`${prefix}-limit-name`)), windows: {} };
    for (const slot of ["primary", "secondary"]) {
      const value = windowValue(headers.get(`${prefix}-${slot}-used-percent`), headers.get(`${prefix}-${slot}-window-minutes`), headers.get(`${prefix}-${slot}-reset-at`));
      if (value !== undefined) bucket.windows[slot] = value;
    }
    if (Object.keys(bucket.windows).length) buckets.push(bucket);
  }
  return buckets;
}
export function quotaEvent(event) {
  if (event?.type !== "codex.rate_limits" || !event.rate_limits || typeof event.rate_limits !== "object") return [];
  const windows = {};
  for (const slot of ["primary", "secondary"]) {
    const source = event.rate_limits[slot];
    if (source === null) windows[slot] = null;
    else if (source && typeof source.used_percent === "number") {
      const value = windowValue(source.used_percent, source.window_minutes, source.reset_at);
      if (value !== undefined) windows[slot] = value;
    }
  }
  if (!Object.keys(windows).length) return [];
  const id = safeLabel(event.metered_limit_name ?? event.limit_name) || "codex";
  return [{ id: id.replaceAll("_", "-"), windows }];
}
export class QuotaTracker {
  #binding;
  #buckets = new Map();
  #listeners = new Set();
  subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #emit() { for (const listener of this.#listeners) { try { listener(); } catch { /* Quota display must not interrupt inference. */ } } }
  matches(binding) { return !!this.#binding && this.#binding.clientId === binding.clientId && this.#binding.generation === binding.generation; }
  activate(binding) {
    if (this.matches(binding)) return;
    this.#binding = binding; this.#buckets.clear(); this.#emit();
  }
  accountChanged(state) { if (!state.authenticated || state.clientId !== this.#binding?.clientId) this.clear(); }
  clear() { this.#binding = undefined; this.#buckets.clear(); this.#emit(); }
  update(binding, updates, startedAt, now = Date.now()) {
    if (!this.matches(binding)) return;
    let changed = false;
    for (const update of updates) {
      const bucket = this.#buckets.get(update.id) ?? { id: update.id, name: update.name, windows: {}, sequence: {} };
      if (update.name) bucket.name = update.name;
      for (const [slot, value] of Object.entries(update.windows)) {
        if (startedAt < (bucket.sequence[slot] ?? -Infinity)) continue;
        bucket.sequence[slot] = startedAt;
        if (value === null) delete bucket.windows[slot];
        else bucket.windows[slot] = { ...value, checkedAt: now, startedAt };
        changed = true;
      }
      this.#buckets.set(update.id, bucket);
    }
    if (changed) this.#emit();
  }
  snapshot(now = Date.now()) {
    const buckets = [...this.#buckets.values()].map((bucket) => ({ id: bucket.id, ...(bucket.name ? { name: bucket.name } : {}),
      windows: Object.values(bucket.windows).map(({ startedAt, ...window }) => ({ ...window, label: windowLabel(window), stale: now - window.checkedAt > 300_000 || (window.resetsAt !== undefined && window.resetsAt * 1000 <= now) })),
    })).filter((bucket) => bucket.windows.length);
    return { available: buckets.length > 0, buckets };
  }
}
export function windowLabel(window) {
  if (window.windowMinutes === 300) return "5h";
  if (window.windowMinutes === 10080) return "Weekly";
  return window.windowMinutes ? `${window.windowMinutes}m` : "Quota";
}
function resetText(window, now) {
  if (!window.resetsAt) return "reset time unavailable";
  const minutes = Math.ceil((window.resetsAt * 1000 - now) / 60000);
  if (minutes <= 0) return "awaiting update";
  const hours = Math.floor(minutes / 60);
  return hours >= 24 ? `resets in ${Math.floor(hours / 24)}d ${hours % 24}h` : hours ? `resets in ${hours}h ${minutes % 60}m` : `resets in ${minutes}m`;
}
export function quotaSummary(snapshot, now = Date.now()) {
  const bucket = snapshot.buckets.find((value) => value.id === "codex") ?? snapshot.buckets[0];
  if (!bucket) return "codex unavailable";
  const windows = [...bucket.windows].sort((a, b) => (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity));
  return `codex ${windows.map((window) => `${Math.round(window.remainingPercent)}%${window.stale ? "*" : ""} ${compactReset(window, now)}`).join(" ")}`;
}
function compactReset(window, now) {
  if (!window.resetsAt) return "?";
  const total = Math.max(0, Math.ceil((window.resetsAt * 1000 - now) / 60000));
  const days = Math.floor(total / 1440), hours = Math.floor(total % 1440 / 60), minutes = total % 60;
  return `${days ? `${days}d` : ""}${hours ? `${hours}h` : ""}${minutes ? `${minutes}m` : ""}` || "0m";
}
export function quotaDetails(snapshot, now = Date.now()) {
  if (!snapshot.available) return "Codex quota unavailable. No quota data is currently available for this account. This command does not call a model.\nManage usage: https://chatgpt.com/settings/usage";
  return snapshot.buckets.map((bucket) => `${bucket.name ?? bucket.id}\n${bucket.windows.map((window) => `${window.label}: ${window.remainingPercent.toFixed(1)}% remaining${window.stale ? " (stale)" : ""}\n  ${resetText(window, now)}${window.resetsAt ? ` · ${new Date(window.resetsAt * 1000).toLocaleString("en-US")}` : ""}\n  Updated: ${new Date(window.checkedAt).toLocaleString("en-US")}`).join("\n")}`).join("\n\n");
}
