import { createCodexAdapter } from "./adapter.js";
import { CodexCredentialStore, OPENAI_CODEX_PROVIDER, authPath } from "./store.js";
import { registerWebAuth } from "./web-auth.js";
import { registerQuotaUi } from "./quota-ui.js";
export { login, logout, status } from "./auth.js";

export const name = "llm-codex-oauth";
export const inject = ["llm"];

export { OPENAI_CODEX_PROVIDER, CodexCredentialStore, authPath, createCodexAdapter };

export function apply(ctx) {
  const credentials = new CodexCredentialStore();
  const adapter = createCodexAdapter(credentials, () => ctx.get?.("attachments"), {
    mapHostPath: (path) => ctx.get?.("fs")?.processPathFromHostPath(path),
    onModelsChanged: () => ctx.emit?.("llm/adapters-updated"),
  });
  ctx.llm.registerAdapter(
    [OPENAI_CODEX_PROVIDER],
    adapter,
  );
  ctx.effect?.(() => () => adapter.dispose());
  registerWebAuth(ctx, credentials, { adapter });
  registerQuotaUi(ctx, adapter);
}
