window.__ModuleLoader__.load({id:"dsh-codex-oauth",factory:(require)=>{var module={exports:{}};var exports=module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client/index.jsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);
var import_react = __toESM(require("react"), 1);
var BASE = "/plugins/dsh-codex-oauth/auth";
var h = import_react.default.createElement;
async function request(path, method = "GET") {
  const response = await fetch(`${BASE}/${path}`, { method, credentials: "same-origin", headers: { accept: "application/json" } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : `HTTP ${response.status}`);
  return value;
}
function QuotaPanel({ quota }) {
  if (!quota?.available) return h("div", { role: "status" }, "Quota unavailable. No current quota data is available.");
  return h(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: 12 } },
    ...quota.buckets.map((bucket) => h(
      "section",
      { key: bucket.id },
      h("strong", null, bucket.name ?? bucket.id),
      ...bucket.windows.map((window2, index) => {
        const remaining = Math.round(window2.remainingPercent);
        const color = window2.stale ? "#888" : remaining <= 10 ? "#c44" : remaining <= 30 ? "#b88020" : "#38875c";
        return h(
          "div",
          { key: index, style: { marginTop: 8 } },
          h("div", null, `${window2.label}: ${remaining}% remaining${window2.stale ? " (stale)" : ""}`),
          h(
            "div",
            {
              role: "progressbar",
              "aria-label": `${window2.label} quota remaining`,
              "aria-valuemin": 0,
              "aria-valuemax": 100,
              "aria-valuenow": window2.remainingPercent,
              style: { height: 7, background: "var(--dsw-alias-border-l2)", borderRadius: 4, marginTop: 4 }
            },
            h("div", { style: { width: `${window2.remainingPercent}%`, height: "100%", background: color, borderRadius: 4 } })
          ),
          h("small", null, window2.resetsAt ? `Reset: ${new Date(window2.resetsAt * 1e3).toLocaleString("en-US")}` : "Reset time unavailable"),
          h("small", { style: { display: "block" } }, `Updated: ${new Date(window2.checkedAt).toLocaleString("en-US")}`)
        );
      })
    )),
    h("small", null, "Quota checks do not call a model.")
  );
}
function CodexSettings() {
  const [state, setState] = (0, import_react.useState)({ status: "loading" });
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [notice, setNotice] = (0, import_react.useState)("");
  const refresh = (0, import_react.useCallback)(() => request("status").then(setState).catch((error) => setState({ status: "error", message: error.message })), []);
  (0, import_react.useEffect)(() => {
    refresh();
  }, [refresh]);
  (0, import_react.useEffect)(() => {
    if (state.status !== "signing-in") return void 0;
    const timer = setInterval(refresh, 1e3);
    return () => clearInterval(timer);
  }, [refresh, state.status]);
  const signIn = async (newAccount = false) => {
    const popup = window.open("about:blank", "_blank");
    if (!popup) {
      setState({ ...state, status: "error", message: "Allow pop-ups to complete sign-in." });
      return;
    }
    popup.opener = null;
    setBusy(true);
    setState({ ...state, status: "signing-in" });
    setNotice("");
    try {
      const challenge = await request(`login${newAccount ? "?new_account=1" : ""}`, "POST");
      popup.location.replace(challenge.url);
    } catch (error) {
      popup.close();
      setState({ ...state, status: "error", message: error.message });
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    setBusy(true);
    try {
      const result = await request("logout", "POST");
      if (!result.remoteRevoked) setNotice("Signed out locally. Remote revocation was not confirmed; disconnect the app in ChatGPT usage settings.");
      await refresh();
    } catch (error) {
      setState({ ...state, status: "error", message: error.message });
    } finally {
      setBusy(false);
    }
  };
  const selectAccount = async (clientId) => {
    setBusy(true);
    setNotice("");
    try {
      setState(await request(`account?client_id=${encodeURIComponent(clientId)}`, "POST"));
    } catch (error) {
      setState({ ...state, status: "error", message: error.message });
    } finally {
      setBusy(false);
    }
  };
  const refreshModels = async () => {
    setBusy(true);
    try {
      const { models } = await request("models", "POST");
      setNotice(`Refreshed ${models.length} available models.`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  };
  const signedIn = state.authenticated && state.planUsage;
  (0, import_react.useEffect)(() => {
    if (!signedIn) return void 0;
    const timer = setInterval(refresh, 3e4);
    return () => clearInterval(timer);
  }, [signedIn, refresh]);
  const signingIn = state.status === "signing-in";
  const label = signingIn ? "Waiting for browser sign-in\u2026" : signedIn ? `Signed in${state.label ? `: ${state.label}` : ""}` : state.status === "loading" ? "Checking sign-in status\u2026" : state.authenticated ? "Signed in; ChatGPT plan usage is not authorized" : "Signed out";
  return h(
    "section",
    { style: { display: "flex", flexDirection: "column", gap: 12, maxWidth: 640 } },
    h("h2", { style: { margin: 0 } }, "OpenAI Codex"),
    h("p", { style: { margin: 0 } }, "Use your ChatGPT plan without an OpenAI API key. Models are provided by the active account."),
    h(
      "div",
      { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: 16, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10 } },
      h("span", null, label),
      state.status === "loading" ? null : h("button", { type: "button", disabled: busy, onClick: signedIn || signingIn ? signOut : () => signIn() }, signedIn ? "Sign out" : signingIn ? "Cancel sign-in" : "Continue with ChatGPT")
    ),
    state.accounts?.length ? h(
      "div",
      { style: { display: "flex", gap: 8 } },
      h(
        "select",
        { "aria-label": "ChatGPT account", disabled: busy || signingIn, value: state.accounts.find((account) => account.active)?.clientId ?? "", onChange: (event) => selectAccount(event.target.value) },
        ...state.accounts.map((account) => h("option", { key: account.clientId, value: account.clientId }, `${account.label}${account.authenticated ? "" : " (signed out)"}`))
      ),
      h("button", { type: "button", disabled: busy || signingIn, onClick: () => signIn(true) }, "Add account")
    ) : null,
    state.authenticated && !state.planUsage && !signingIn ? h("button", { type: "button", disabled: busy, onClick: signOut }, "Sign out") : null,
    signedIn && !signingIn ? h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 12 } },
      h("span", null, "Using ChatGPT plan"),
      h("a", { href: "https://chatgpt.com/settings/usage", target: "_blank", rel: "noopener noreferrer" }, "Manage usage"),
      h("button", { type: "button", disabled: busy, onClick: refreshModels }, "Refresh models")
    ) : null,
    signedIn ? h(QuotaPanel, { quota: state.quota }) : null,
    state.status === "error" ? h("p", { style: { color: "var(--dsw-alias-state-error-primary)" } }, state.message) : null,
    notice ? h("p", { role: "status" }, notice) : null
  );
}
var name = "dsh-codex-oauth-client";
var inject = ["slots"];
function apply(ctx) {
  ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "dsh-codex-oauth", order: 15, label: () => "OpenAI Codex" }, CodexSettings));
}
return module.exports;}});
