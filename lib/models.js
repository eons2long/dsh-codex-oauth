import { LlmError } from "@deepseek-ai/dsh-llm";
import { getCredential } from "./auth.js";
import { OPENAI_CODEX_PROVIDER } from "./store.js";
import { fetchJSON, OPENAI_API } from "./openai-http.js";

const CACHE_TTL_MS = 5 * 60_000;
function modelInfo(entry) {
  if (typeof entry.slug !== "string" || !entry.slug) throw new LlmError("OpenAI returned an invalid model catalog entry", "INVALID_RESPONSE");
  const modalities = Array.isArray(entry.input_modalities) ? entry.input_modalities.filter((value) => value === "text" || value === "image") : undefined;
  const levels = Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels.filter((level) => typeof level.effort === "string" && level.effort)
    .map((level) => ({ id: level.effort, name: level.effort, ...(typeof level.description === "string" ? { description: level.description } : {}) })) : [];
  return {
    provider: OPENAI_CODEX_PROVIDER,
    id: entry.slug,
    name: typeof entry.display_name === "string" ? entry.display_name : entry.slug,
    ...(typeof entry.description === "string" ? { description: entry.description } : {}),
    ...(modalities ? { inputModalities: modalities } : {}),
    ...(Number.isSafeInteger(entry.context_window) && entry.context_window > 0 ? { context: { contextWindow: entry.context_window } } : {}),
    ...(levels.length ? { reasoning: {
      efforts: levels,
      ...(levels.some((level) => level.id === entry.default_reasoning_level) ? { defaultEffort: entry.default_reasoning_level } : {}),
    } } : {}),
  };
}

export class CodexModelCatalog {
  #cached;
  constructor(credentials, options = {}) { this.credentials = credentials; this.options = options; }
  invalidate() { this.#cached = undefined; }
  async read({ signal, refresh = false } = {}) {
    const initial = await this.credentials.readDocument();
    const selected = await this.credentials.read(OPENAI_CODEX_PROVIDER);
    if (!selected?.scopes.includes("chatgpt.tokens.use.direct")) { this.invalidate(); return undefined; }
    const credential = await getCredential(this.credentials, { ...this.options, signal, clientId: selected.clientId });
    const authorized = await this.credentials.readDocument();
    if (authorized?.activeClientId !== initial?.activeClientId || (authorized?.generation ?? 0) !== (initial?.generation ?? 0)) throw new LlmError("The selected ChatGPT account changed during model discovery", "AUTH");
    const now = this.options.now?.() ?? Date.now();
    const generation = initial?.generation ?? 0;
    if (!refresh && this.#cached?.clientId === credential.clientId && this.#cached.generation === generation && this.#cached.expires > now) return structuredClone(this.#cached);
    const response = await fetchJSON(`${OPENAI_API}/models`, { headers: { authorization: `Bearer ${credential.access}` }, signal }, this.options.fetch);
    if (!Array.isArray(response.models)) throw new LlmError("OpenAI returned an invalid model catalog", "INVALID_RESPONSE");
    const all = response.models.map((entry) => ({ info: modelInfo(entry), visible: entry.visibility === "list" }));
    if (new Set(all.map((entry) => entry.info.id)).size !== all.length) throw new LlmError("OpenAI returned duplicate model catalog entries", "INVALID_RESPONSE");
    const current = await this.credentials.readDocument();
    if (current?.activeClientId !== initial?.activeClientId || current?.activeClientId !== credential.clientId || (current?.generation ?? 0) !== generation) throw new LlmError("The selected ChatGPT account changed during model discovery", "AUTH");
    this.#cached = { clientId: credential.clientId, generation, expires: now + CACHE_TTL_MS, all };
    return structuredClone(this.#cached);
  }
  async list(options) { return (await this.read(options))?.all.filter((entry) => entry.visible).map((entry) => entry.info) ?? []; }
  async resolve(model, signal) {
    return (await this.read({ signal }))?.all.find((entry) => entry.info.id === model)?.info ?? { provider: OPENAI_CODEX_PROVIDER, id: model, name: model };
  }
}
