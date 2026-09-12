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
var STATUS = "/plugins/dsh-codex-oauth/auth/status";
var LOGIN = "/plugins/dsh-codex-oauth/auth/login";
var LOGOUT = "/plugins/dsh-codex-oauth/auth/logout";
var h = import_react.default.createElement;
async function request(path, method = "GET") {
  const response = await fetch(path, { method, credentials: "same-origin", headers: { accept: "application/json" } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value && typeof value === "object" && typeof value.error === "string" ? value.error : `HTTP ${response.status}`);
  return value;
}
function CodexSettings() {
  const [state, setState] = (0, import_react.useState)({ status: "loading" });
  const [busy, setBusy] = (0, import_react.useState)(false);
  const refresh = (0, import_react.useCallback)(() => request(STATUS).then(setState).catch((error) => setState({ status: "error", message: error.message })), []);
  (0, import_react.useEffect)(() => {
    refresh();
  }, [refresh]);
  (0, import_react.useEffect)(() => {
    if (state.status !== "signing-in") return void 0;
    const timer = setInterval(refresh, 1e3);
    return () => clearInterval(timer);
  }, [refresh, state.status]);
  const signIn = async () => {
    const popup = window.open("about:blank", "_blank");
    if (!popup) {
      setState({ status: "error", message: "Please allow popups to sign in" });
      return;
    }
    popup.opener = null;
    setBusy(true);
    setState({ status: "signing-in" });
    try {
      const challenge = await request(LOGIN, "POST");
      popup.location.replace(challenge.url);
    } catch (error) {
      popup?.close();
      setState({ status: "error", message: error.message });
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    setBusy(true);
    try {
      await request(LOGOUT, "POST");
      setState({ status: "signed-out" });
    } catch (error) {
      setState({ status: "error", message: error.message });
    } finally {
      setBusy(false);
    }
  };
  const signedIn = state.status === "signed-in";
  const label = state.status === "signed-in" ? "Signed in" : state.status === "signing-in" ? "Waiting for the browser to finish signing in\u2026" : state.status === "loading" ? "Checking sign-in status\u2026" : state.status === "error" ? "Sign-in failed" : "Signed out";
  return h(
    "section",
    { style: { display: "flex", flexDirection: "column", gap: 12, maxWidth: 640 } },
    h("h2", { style: { margin: 0 } }, "OpenAI Codex"),
    h("p", { style: { margin: 0, color: "var(--dsw-alias-label-secondary)" } }, "Use Codex with a ChatGPT Plus/Pro subscription; no OpenAI API key is required."),
    h(
      "div",
      { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: 16, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10 } },
      h("span", null, label),
      state.status === "loading" ? null : h("button", { type: "button", disabled: busy || state.status === "signing-in", onClick: signedIn ? signOut : signIn }, signedIn ? "Sign out" : "Sign in with ChatGPT")
    ),
    state.status === "error" ? h("p", { style: { color: "var(--dsw-alias-state-error-primary)" } }, state.message) : null
  );
}
var name = "dsh-codex-oauth-client";
var inject = ["slots"];
function apply(ctx) {
  ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "dsh-codex-oauth", order: 15, label: () => "OpenAI Codex" }, CodexSettings));
}
return module.exports;}});
