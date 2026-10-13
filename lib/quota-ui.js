import { quotaSummary, quotaDetails } from "./quota.js";
export function registerQuotaUi(ctx, adapter) {
  ctx.inject(["commands"], (commands) => commands.effect(() => commands.commands.register({
    name: "codex-usage", description: "Show Codex quota windows and reset times (no model request)",
    handler: async ({ rawInput }) => rawInput.trim() ? { kind: "error", text: "Usage: /codex-usage" }
      : { kind: "success", text: quotaDetails(await adapter.quotaSnapshot()) },
  })));
  ctx.inject(["tuiStatus"], (ui) => ui.effect(() => {
    let clear, disposed = false, refreshing = false;
    const refresh = async () => {
      if (disposed || refreshing) return;
      refreshing = true;
      try {
        const snapshot = await adapter.quotaSnapshot();
        if (!disposed) { clear?.(); clear = ui.tuiStatus.set("dsh-codex-oauth:quota", quotaSummary(snapshot), ui); }
      } catch { /* Status display must not prevent the TUI from starting. */ }
      finally { refreshing = false; }
    };
    const unsubscribe = adapter.quotas.subscribe(refresh);
    const timer = setInterval(refresh, 30_000); timer.unref?.();
    void refresh();
    return () => { disposed = true; clearInterval(timer); unsubscribe(); clear?.(); };
  }));
}
