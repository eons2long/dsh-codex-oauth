import { createModels } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { OPENAI_CODEX_PROVIDER } from "./store.js";

const STREAM_IDLE_TIMEOUT_MS = 300_000;

function tokenProvider(provider) {
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        name: "OpenAI Codex OAuth bearer token",
        async resolve({ credential }) {
          return credential?.access
            ? { auth: { apiKey: credential.access }, source: "Pi OAuth" }
            : undefined;
        },
      },
    },
  };
}

export function createCodexAdapter(credentials, resolveAttachments) {
  const provider = openaiCodexProvider();
  const profiles = new Map([[OPENAI_CODEX_PROVIDER, {
    provider: OPENAI_CODEX_PROVIDER,
    displayName: "OpenAI Codex",
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, "dsh-llm-codex-oauth retryPolicy"),
    configuredMaxTokens: new Map(),
    piProvider: tokenProvider(provider),
  }]]);
  const models = createModels({ credentials });
  models.setProvider(provider);
  return new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => (await models.getAuth(OPENAI_CODEX_PROVIDER))?.auth.apiKey,
    resolveAttachments,
  });
}
