import { createCodexAdapter } from "./adapter.js";
import { PiCodexCredentialStore, OPENAI_CODEX_PROVIDER, PI_AUTH_FILE } from "./store.js";

export const name = "llm-codex-oauth";
export const inject = ["llm"];

export { OPENAI_CODEX_PROVIDER, PI_AUTH_FILE, PiCodexCredentialStore, createCodexAdapter };

export function apply(ctx) {
  const credentials = new PiCodexCredentialStore();
  ctx.llm.registerAdapter(
    [OPENAI_CODEX_PROVIDER],
    createCodexAdapter(credentials, () => ctx.get?.("attachments")),
  );
}
