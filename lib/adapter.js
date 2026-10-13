import { LlmAdapter, LlmError, resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { getCredential } from "./auth.js";
import { CodexModelCatalog } from "./models.js";
import { OPENAI_CODEX_PROVIDER, authPath } from "./store.js";
import { openaiFetch, OPENAI_API, readJSON, responseError } from "./openai-http.js";
import { responsesRequest } from "./responses-request.js";
import { readSSE, responsesStream } from "./responses-stream.js";
import { QuotaTracker, quotaHeaders, quotaEvent } from "./quota.js";
import { CodexQuotaLookup } from "./quota-lookup.js";

const STREAM_IDLE_TIMEOUT_MS = 300_000;
export class CodexAdapter extends LlmAdapter {
  #active = new Set();
  #requestSequence = 0;
  constructor(credentials, resolveAttachments, options = {}) {
    super();
    this.credentials = credentials;
    this.resolveAttachments = resolveAttachments;
    this.options = options;
    this.quotas = new QuotaTracker();
    this.quotaLookup = new CodexQuotaLookup(credentials.filename ?? authPath(), { fetch: options.fetch, now: options.now });
    this.catalog = new CodexModelCatalog(credentials, options);
    this.retryPolicy = resolveRetryPolicy(undefined, "dsh-codex-oauth retryPolicy");
    this.unsubscribe = credentials.subscribe((state) => {
      this.quotas.accountChanged(state);
      this.quotaLookup.reset();
      this.catalog.invalidate();
      for (const request of this.#active) if (!state.authenticated || request.clientId !== state.clientId) request.controller.abort(new LlmError("ChatGPT account changed or signed out", "ABORTED"));
      options.onModelsChanged?.();
    });
  }
  providerInfo(provider) { this.assertProvider(provider); return { id: provider, name: "OpenAI Codex (ChatGPT plan)" }; }
  providerRetryPolicy(provider) { this.assertProvider(provider); return this.retryPolicy; }
  assertProvider(provider) { if (provider !== OPENAI_CODEX_PROVIDER) throw new LlmError("Codex adapter does not own this provider", "NO_ADAPTER"); }
  async listModels(provider, options) { this.assertProvider(provider); return this.catalog.list(options); }
  async resolveModel(provider, model, signal) { this.assertProvider(provider); return this.catalog.resolve(model, signal); }
  async quotaSnapshot() {
    const document = await this.credentials.readDocument();
    const account = document?.registrations.find((entry) => entry.clientId === document.activeClientId);
    if (!account?.access) { this.quotas.clear(); this.quotaLookup.reset(); return this.quotas.snapshot(); }
    const binding = { clientId: document.activeClientId, generation: document.generation ?? 0 };
    this.quotas.activate(binding);
    const passive = this.quotas.snapshot();
    if (passive.available && passive.buckets.every((bucket) => bucket.windows.every((window) => !window.stale))) return passive;
    const queried = await this.quotaLookup.snapshot(account, binding);
    const current = await this.credentials.readDocument();
    if (current?.activeClientId !== binding.clientId || (current?.generation ?? 0) !== binding.generation || !current?.registrations.find((entry) => entry.clientId === binding.clientId)?.access) {
      this.quotaLookup.reset(); return { available: false, buckets: [] };
    }
    return queried.available ? queried : this.quotas.snapshot();
  }
  async prepareCall(provider, model, signal) {
    const initial = await this.credentials.readDocument();
    const info = await this.resolveModel(provider, model, signal);
    const document = await this.credentials.readDocument();
    if (document?.activeClientId !== initial?.activeClientId || (document?.generation ?? 0) !== (initial?.generation ?? 0)) throw new LlmError("The selected ChatGPT account changed during call preparation", "AUTH");
    const binding = { clientId: document?.activeClientId, generation: document?.generation ?? 0, model, info };
    return { model: info, stream: (options) => this.streamPrepared(options, binding) };
  }
  async *stream(options) {
    const prepared = await this.prepareCall(options.provider, options.model, options.signal);
    yield* prepared.stream(options);
  }
  async *streamPrepared(options, binding) {
    this.assertProvider(options.provider);
    if (options.model !== binding.model) throw new LlmError("Prepared Codex model does not match the request", "INVALID_REQUEST");
    const controller = new AbortController();
    const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), controller.signal]);
    let watchdog;
    const activity = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => controller.abort(new LlmError("OpenAI stream idle timeout", "TIMEOUT")), this.options.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS);
      watchdog.unref?.();
    };
    const request = { controller, clientId: binding.clientId };
    this.#active.add(request);
    try {
      const document = await this.credentials.readDocument();
      if (document?.activeClientId !== binding.clientId || (document?.generation ?? 0) !== binding.generation) throw new LlmError("The selected ChatGPT account changed after call preparation", "AUTH");
      const credential = await getCredential(this.credentials, { ...this.options, clientId: binding.clientId, signal });
      const attachments = this.resolveAttachments?.();
      const resolveAccess = (ref, hostPath) => {
        if (!hostPath) return attachments?.imageHostPath ? resolveImageAttachmentAccess(attachments, (path) => this.options.mapHostPath?.(path), ref) : undefined;
        const readonlyPath = this.options.mapHostPath?.(hostPath);
        return readonlyPath ? { readonlyPath } : undefined;
      };
      const { body, names } = await responsesRequest({ ...options, signal }, binding, attachments, resolveAccess);
      signal.throwIfAborted();
      const current = await this.credentials.readDocument();
      if (current?.activeClientId !== binding.clientId || (current?.generation ?? 0) !== binding.generation) throw new LlmError("The selected ChatGPT account changed during request preparation", "AUTH");
      // The ChatGPT plan gateway needs stable session headers to reuse its
      // prompt cache, including the summarizer's calls within the same session.
      const sessionHeaders = options.sessionId === undefined ? {} : {
        "session-id": String(options.sessionId), "x-client-request-id": String(options.sessionId),
      };
      this.quotas.activate(binding);
      const sequence = ++this.#requestSequence;
      activity();
      const response = await openaiFetch(`${OPENAI_API}/responses`, {
        method: "POST", signal, headers: { authorization: `Bearer ${credential.access}`, "content-type": "application/json", accept: "text/event-stream", ...sessionHeaders }, body: JSON.stringify(body),
      }, this.options.fetch);
      this.quotas.update(binding, quotaHeaders(response.headers), sequence);
      if (!response.ok) throw responseError(await readJSON(response), response.status, response.headers, [credential.access]);
      // The ChatGPT plan route can omit Content-Type on a valid SSE response.
      const contentType = response.headers.get("content-type");
      if (contentType && !contentType.startsWith("text/event-stream")) throw new LlmError("OpenAI did not return an event stream", "INVALID_RESPONSE");
      const quotas = this.quotas;
      async function* observedEvents() {
        for await (const event of readSSE(response.body, signal, activity)) {
          quotas.update(binding, quotaEvent(event), sequence);
          yield event;
        }
      }
      yield* responsesStream(observedEvents(), binding, names, response.headers);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error;
    } finally {
      clearTimeout(watchdog);
      this.#active.delete(request);
      controller.abort(new LlmError("OpenAI request finished", "ABORTED"));
    }
  }
  dispose() {
    this.quotaLookup.dispose();
    this.unsubscribe();
    for (const request of this.#active) request.controller.abort(new LlmError("Codex adapter disposed", "ABORTED"));
    this.#active.clear();
  }
}
export function createCodexAdapter(credentials, resolveAttachments, options) { return new CodexAdapter(credentials, resolveAttachments, options); }
