import React, { useCallback, useEffect, useState } from "react";

const STATUS = "/plugins/dsh-codex-oauth/auth/status";
const LOGIN = "/plugins/dsh-codex-oauth/auth/login";
const LOGOUT = "/plugins/dsh-codex-oauth/auth/logout";
const h = React.createElement;

async function request(path, method = "GET") {
  const response = await fetch(path, { method, credentials: "same-origin", headers: { accept: "application/json" } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

function CodexSettings() {
  const [state, setState] = useState({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => request(STATUS).then(setState).catch((error) => setState({ status: "error", message: error.message })), []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (state.status !== "signing-in") return undefined;
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [refresh, state.status]);
  const signIn = () => {
    setBusy(true); setState({ status: "signing-in" });
    const popup = window.open(LOGIN, "_blank", "noopener,noreferrer");
    if (!popup) { setBusy(false); setState({ status: "error", message: "Please allow popups to sign in" }); }
    else setTimeout(() => setBusy(false), 500);
  };
  const signOut = async () => { setBusy(true); try { await request(LOGOUT, "POST"); setState({ status: "signed-out" }); } catch (error) { setState({ status: "error", message: error.message }); } finally { setBusy(false); } };
  const signedIn = state.status === "signed-in";
  const label = state.status === "signed-in" ? "已登录" : state.status === "signing-in" ? "等待浏览器完成登录…" : state.status === "loading" ? "检查登录状态…" : state.status === "error" ? "登录失败" : "未登录";
  return h("section", { style: { display: "flex", flexDirection: "column", gap: 12, maxWidth: 640 } },
    h("h2", { style: { margin: 0 } }, "OpenAI Codex"),
    h("p", { style: { margin: 0, color: "var(--dsw-alias-label-secondary)" } }, "使用 ChatGPT Plus/Pro 的 Codex 订阅，无需 OpenAI API Key。"),
    h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: 16, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10 } },
      h("span", null, label),
      state.status === "loading" ? null : h("button", { type: "button", disabled: busy || state.status === "signing-in", onClick: signedIn ? signOut : signIn }, signedIn ? "退出登录" : "使用 ChatGPT 登录")),
    state.status === "error" ? h("p", { style: { color: "var(--dsw-alias-state-error-primary)" } }, state.message) : null,
    h("p", { style: { margin: 0, color: "var(--dsw-alias-label-secondary)", fontSize: 13 } }, "凭据保存在 DSH_HOME/.openai-codex-auth.json，不会读取 Pi 或 Codex CLI 的登录文件。"));
}

export const name = "dsh-codex-oauth-client";
export const inject = ["slots"];
export function apply(ctx) {
  ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "dsh-codex-oauth", order: 15, label: () => "OpenAI Codex" }, CodexSettings));
}
