#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { authPath, login, logout, status } from "../lib/auth.js";
import { safeMessage } from "../lib/safe-message.js";

function openBrowser(raw) {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Refusing to open a non-HTTPS OAuth URL");
  const command = process.platform === "darwin" ? ["open", url.href] : process.platform === "win32" ? ["rundll32.exe", "url.dll,FileProtocolHandler", url.href] : ["xdg-open", url.href];
  const child = spawn(command[0], command.slice(1), { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {}); child.unref();
}
function help() {
  console.log("Usage: dsh-openai-codex <login|logout|status> [--device-code]");
}

const [action, ...flags] = process.argv.slice(2);
if (!action || action === "--help" || action === "-h") { help(); process.exit(0); }
if (!["login", "logout", "status"].includes(action) || flags.some((flag) => flag !== "--device-code") || (action !== "login" && flags.length)) { help(); process.exit(1); }
try {
  if (action === "status") {
    const value = await status();
    if (!value.authenticated) { console.log("OpenAI Codex for dsh: signed out"); process.exitCode = 1; }
    else console.log(`OpenAI Codex for dsh: signed in; refresh is automatic`);
  } else if (action === "logout") {
    await logout(); console.log(`OpenAI Codex for dsh: signed out; removed ${authPath()}`);
  } else {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await login(undefined, {
        prompt: async (prompt) => {
          if (prompt.type === "select") return flags.includes("--device-code") ? "device_code" : "browser";
          return readline.question(`${prompt.message}: `, { signal: prompt.signal });
        },
        notify: (event) => {
          if (event.type === "auth_url") { console.log(`Open this URL to sign in:\n${event.url}`); openBrowser(event.url); }
          else if (event.type === "device_code") { console.log(`Open ${event.verificationUri} and enter ${event.userCode}`); openBrowser(event.verificationUri); }
          else if (event.message) console.log(event.message);
        },
      });
    } finally { readline.close(); }
    console.log(`OpenAI Codex for dsh: signed in; credentials saved to ${authPath()}`);
  }
} catch (error) {
  console.error(`dsh-openai-codex: ${safeMessage(error)}`);
  process.exitCode = 1;
}
