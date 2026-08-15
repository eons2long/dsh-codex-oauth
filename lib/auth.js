import { createModels } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { CodexCredentialStore, OPENAI_CODEX_PROVIDER, authPath } from "./store.js";

function models(store) {
  const value = createModels({ credentials: store });
  value.setProvider(openaiCodexProvider());
  return value;
}

export async function login(store = new CodexCredentialStore(), interaction) {
  await models(store).login(OPENAI_CODEX_PROVIDER, "oauth", interaction);
}
export async function logout(store = new CodexCredentialStore()) {
  await store.delete(OPENAI_CODEX_PROVIDER);
}
export async function status(store = new CodexCredentialStore()) {
  const credential = await store.read(OPENAI_CODEX_PROVIDER);
  return credential?.type === "oauth" ? { authenticated: true, expiresAt: new Date(credential.expires) } : { authenticated: false };
}
export { authPath };
