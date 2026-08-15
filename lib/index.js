import { createCodexAdapter } from "./adapter.js";
import { CodexCredentialStore, OPENAI_CODEX_PROVIDER, authPath } from "./store.js";
export { login, logout, status } from "./auth.js";

export const name = "llm-codex-oauth";
export const inject = ["llm"];

export { OPENAI_CODEX_PROVIDER, CodexCredentialStore, authPath, createCodexAdapter };

export function apply(ctx) {
  const credentials = new CodexCredentialStore();
  ctx.llm.registerAdapter(
    [OPENAI_CODEX_PROVIDER],
    createCodexAdapter(credentials, () => ctx.get?.("attachments")),
  );
}
