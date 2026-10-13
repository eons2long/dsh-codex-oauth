import React, { useCallback, useEffect, useState } from "react";

const BASE = "/plugins/dsh-codex-oauth/auth";
const h = React.createElement;
async function request(path, method = "GET") {
  const response = await fetch(`${BASE}/${path}`, { method, credentials: "same-origin", headers: { accept: "application/json" } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : `HTTP ${response.status}`);
  return value;
}
function QuotaPanel({ quota }) {
  if (!quota?.available) return h("div", { role: "status" }, "Quota unavailable. No current quota data is available.");
  return h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
    ...quota.buckets.map((bucket) => h("section", { key: bucket.id },
      h("strong", null, bucket.name ?? bucket.id),
      ...bucket.windows.map((window, index) => {
        const remaining = Math.round(window.remainingPercent);
        const color = window.stale ? "#888" : remaining <= 10 ? "#c44" : remaining <= 30 ? "#b88020" : "#38875c";
        return h("div", { key: index, style: { marginTop: 8 } },
          h("div", null, `${window.label}: ${remaining}% remaining${window.stale ? " (stale)" : ""}`),
          h("div", { role: "progressbar", "aria-label": `${window.label} quota remaining`, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": window.remainingPercent,
            style: { height: 7, background: "var(--dsw-alias-border-l2)", borderRadius: 4, marginTop: 4 } },
            h("div", { style: { width: `${window.remainingPercent}%`, height: "100%", background: color, borderRadius: 4 } })),
          h("small", null, window.resetsAt ? `Reset: ${new Date(window.resetsAt * 1000).toLocaleString("en-US")}` : "Reset time unavailable"),
          h("small", { style: { display: "block" } }, `Updated: ${new Date(window.checkedAt).toLocaleString("en-US")}`));
      }))),
    h("small", null, "Quota checks do not call a model."));
}
function CodexSettings() {
  const [state, setState] = useState({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const refresh = useCallback(() => request("status").then(setState).catch((error) => setState({ status: "error", message: error.message })), []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (state.status !== "signing-in") return undefined;
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [refresh, state.status]);
  const signIn = async (newAccount = false) => {
    const popup = window.open("about:blank", "_blank");
    if (!popup) { setState({ ...state, status: "error", message: "Allow pop-ups to complete sign-in." }); return; }
    popup.opener = null;
    setBusy(true); setState({ ...state, status: "signing-in" }); setNotice("");
    try { const challenge = await request(`login${newAccount ? "?new_account=1" : ""}`, "POST"); popup.location.replace(challenge.url); }
    catch (error) { popup.close(); setState({ ...state, status: "error", message: error.message }); }
    finally { setBusy(false); }
  };
  const signOut = async () => {
    setBusy(true);
    try {
      const result = await request("logout", "POST");
      if (!result.remoteRevoked) setNotice("Signed out locally. Remote revocation was not confirmed; disconnect the app in ChatGPT usage settings.");
      await refresh();
    } catch (error) { setState({ ...state, status: "error", message: error.message }); }
    finally { setBusy(false); }
  };
  const selectAccount = async (clientId) => {
    setBusy(true); setNotice("");
    try { setState(await request(`account?client_id=${encodeURIComponent(clientId)}`, "POST")); }
    catch (error) { setState({ ...state, status: "error", message: error.message }); }
    finally { setBusy(false); }
  };
  const refreshModels = async () => {
    setBusy(true);
    try { const { models } = await request("models", "POST"); setNotice(`Refreshed ${models.length} available models.`); }
    catch (error) { setNotice(error.message); }
    finally { setBusy(false); }
  };
  const signedIn = state.authenticated && state.planUsage;
  useEffect(() => {
    if (!signedIn) return undefined;
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, [signedIn, refresh]);
  const signingIn = state.status === "signing-in";
  const label = signingIn ? "Waiting for browser sign-in…" : signedIn ? `Signed in${state.label ? `: ${state.label}` : ""}`
    : state.status === "loading" ? "Checking sign-in status…" : state.authenticated ? "Signed in; ChatGPT plan usage is not authorized" : "Signed out";
  return h("section", { style: { display: "flex", flexDirection: "column", gap: 12, maxWidth: 640 } },
    h("h2", { style: { margin: 0 } }, "OpenAI Codex"),
    h("p", { style: { margin: 0 } }, "Use your ChatGPT plan without an OpenAI API key. Models are provided by the active account."),
    h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: 16, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10 } },
      h("span", null, label),
      state.status === "loading" ? null : h("button", { type: "button", disabled: busy, onClick: signedIn || signingIn ? signOut : () => signIn() }, signedIn ? "Sign out" : signingIn ? "Cancel sign-in" : "Continue with ChatGPT")),
    state.accounts?.length ? h("div", { style: { display: "flex", gap: 8 } },
      h("select", { "aria-label": "ChatGPT account", disabled: busy || signingIn, value: state.accounts.find((account) => account.active)?.clientId ?? "", onChange: (event) => selectAccount(event.target.value) },
        ...state.accounts.map((account) => h("option", { key: account.clientId, value: account.clientId }, `${account.label}${account.authenticated ? "" : " (signed out)"}`))),
      h("button", { type: "button", disabled: busy || signingIn, onClick: () => signIn(true) }, "Add account")) : null,
    state.authenticated && !state.planUsage && !signingIn ? h("button", { type: "button", disabled: busy, onClick: signOut }, "Sign out") : null,
    signedIn && !signingIn ? h("div", { style: { display: "flex", alignItems: "center", gap: 12 } },
      h("span", null, "Using ChatGPT plan"),
      h("a", { href: "https://chatgpt.com/settings/usage", target: "_blank", rel: "noopener noreferrer" }, "Manage usage"),
      h("button", { type: "button", disabled: busy, onClick: refreshModels }, "Refresh models")) : null,
    signedIn ? h(QuotaPanel, { quota: state.quota }) : null,
    state.status === "error" ? h("p", { style: { color: "var(--dsw-alias-state-error-primary)" } }, state.message) : null,
    notice ? h("p", { role: "status" }, notice) : null,
  );
}
export const name = "dsh-codex-oauth-client";
export const inject = ["slots"];
export function apply(ctx) {
  ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "dsh-codex-oauth", order: 15, label: () => "OpenAI Codex" }, CodexSettings));
}
