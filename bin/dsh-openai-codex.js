#!/usr/bin/env node
import { spawn } from "node:child_process";
import { accounts, authPath, login, logout, status } from "../lib/auth.js";
import { CodexCredentialStore } from "../lib/store.js";
import { safeMessage } from "../lib/safe-message.js";

function openBrowser(raw) {
  const url = new URL(raw);
  if (url.origin !== "https://auth.openai.com") throw new Error("Refusing to open an unexpected OAuth URL");
  const command = process.platform === "darwin" ? ["open", url.href] : process.platform === "win32" ? ["rundll32.exe", "url.dll,FileProtocolHandler", url.href] : ["xdg-open", url.href];
  const child = spawn(command[0], command.slice(1), { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {}); child.unref();
}
function help() {
  console.log("Usage: dsh-openai-codex login [--new-account]\n       dsh-openai-codex <logout|status|accounts>\n       dsh-openai-codex use <client-id>\n       dsh-openai-codex models [--refresh]");
}
const [action, ...flags] = process.argv.slice(2);
if (!action || action === "--help" || action === "-h") { help(); process.exit(0); }
if (flags.includes("--device-code")) {
  console.error("ChatGPT plan OAuth requires browser authorization with a local callback; --device-code is unavailable. Run login on your local computer.");
  process.exit(1);
}
const valid = action === "login" ? flags.length <= 1 && (!flags.length || flags[0] === "--new-account")
  : action === "models" ? flags.length <= 1 && (!flags.length || flags[0] === "--refresh")
  : action === "use" ? flags.length === 1 && !flags[0].startsWith("-")
  : ["logout", "status", "accounts"].includes(action) && !flags.length;
if (!valid) { help(); process.exit(1); }
const store = new CodexCredentialStore();
try {
  if (action === "status") {
    const value = await status(store);
    if (!value.authenticated) { console.log("OpenAI Codex for dsh: signed out; run login to authorize ChatGPT plan usage"); process.exitCode = 1; }
    else console.log(`OpenAI Codex for dsh: signed in as ${value.label}; ChatGPT plan usage ${value.planUsage ? "enabled" : "not authorized"}; refresh is automatic`);
  } else if (action === "logout") {
    const result = await logout(store);
    console.log("OpenAI Codex for dsh: signed out; account registration retained for later sign-in");
    if (!result.remoteRevoked) console.log("Remote session revocation could not be confirmed. You can disconnect the app at https://chatgpt.com/settings/usage");
  } else if (action === "accounts") {
    const list = await accounts(store);
    for (const account of list) console.log(`${account.active ? "*" : " "} ${account.clientId}\t${account.label}\t${account.authenticated ? "signed in" : "signed out"}`);
    if (!list.length) console.log("No saved ChatGPT account registrations");
  } else if (action === "use") {
    await store.select(flags[0]);
    console.log("Selected ChatGPT account registration");
  } else if (action === "models") {
    const { createCodexAdapter } = await import("../lib/adapter.js");
    const adapter = createCodexAdapter(store);
    try {
      for (const model of await adapter.listModels("openai-codex", { refresh: flags.includes("--refresh") })) console.log(`${model.id}\t${model.name}`);
    } finally { adapter.dispose(); }
  } else {
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error("Sign-in cancelled"));
    process.once("SIGINT", cancel);
    try {
      const value = await login(store, {
        signal: controller.signal,
        notify: (event) => {
          if (event.type !== "auth_url") return;
          const display = new URL(event.url);
          display.searchParams.delete("id_token_hint");
          console.log(`Open this URL to sign in:\n${display.href}`);
          openBrowser(event.url);
        },
      }, { newAccount: flags.includes("--new-account") });
      console.log(`OpenAI Codex for dsh: signed in; credentials saved to ${authPath()}`);
      console.log(value.planUsage ? "Eligible requests use your ChatGPT plan. Manage usage: https://chatgpt.com/settings/usage" : "ChatGPT plan usage was not authorized. Run login again to enable it.");
    } finally { process.removeListener("SIGINT", cancel); }
  }
} catch (error) {
  console.error(`dsh-openai-codex: ${safeMessage(error)}`);
  process.exitCode = 1;
}
