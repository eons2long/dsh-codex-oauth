import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/dist/providers/openai-codex.js";
import { CallId, LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";

const PROVIDER = "codex-oauth";
const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");

// ponytail: one small serialized file store; Pi already owns the credential format.
class PiAuthStore {
  lock = Promise.resolve();

  async readAll() {
    try {
      return JSON.parse(await readFile(AUTH_FILE, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      throw error;
    }
  }

  async read(providerId) {
    return (await this.readAll())[providerId];
  }

  async list() {
    const auth = await this.readAll();
    return Object.entries(auth).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(providerId, fn) {
    const run = this.lock.then(async () => {
      const auth = await this.readAll();
      const next = await fn(auth[providerId]);
      if (next !== undefined) auth[providerId] = next;
      await mkdir(dirname(AUTH_FILE), { recursive: true });
      const tmp = `${AUTH_FILE}.dsh-tmp`;
      await writeFile(tmp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, AUTH_FILE);
      return next;
    });
    this.lock = run.catch(() => {});
    return run;
  }

  async delete(providerId) {
    const run = this.lock.then(async () => {
      const auth = await this.readAll();
      delete auth[providerId];
      await writeFile(AUTH_FILE, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
    });
    this.lock = run.catch(() => {});
    return run;
  }
}

function parseArgs(raw) {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function textOf(blocks) {
  return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function contextOf(options) {
  if (options.messages.some((message) => message.content.some((block) => block.type === "image")))
    throw new LlmError("Codex OAuth plugin does not support image content yet", "UNSUPPORTED_CONTENT");
  const toolNames = new Map();
  const messages = [];
  for (const message of options.messages) {
    if (message.role === "system") {
      messages.push({ role: "user", content: textOf(message.content), timestamp: 0 });
      continue;
    }
    if (message.role === "assistant") {
      const content = [];
      for (const block of message.content) {
        if (block.type === "text") content.push({ type: "text", text: block.text });
        if (block.type === "reasoning") content.push({ type: "thinking", thinking: block.text });
        if (block.type === "tool-call") {
          toolNames.set(block.id, block.name);
          content.push({ type: "toolCall", id: block.id, name: block.name, arguments: parseArgs(block.arguments) });
        }
      }
      messages.push({
        role: "assistant", content, api: "dsh-foreign", provider: "dsh-foreign", model: "dsh-foreign",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop", timestamp: 0,
      });
      continue;
    }
    const text = textOf(message.content);
    const results = message.content.filter((block) => block.type === "tool-result");
    if (text || results.length === 0) messages.push({ role: "user", content: text, timestamp: 0 });
    for (const result of results) {
      messages.push({
        role: "toolResult", toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? "unknown",
        content: [{ type: "text", text: textOf(result.content) || "(no output)" }],
        isError: result.isError ?? false, timestamp: 0,
      });
    }
  }
  return {
    ...(options.system === undefined ? {} : { systemPrompt: options.system }),
    messages,
    ...(options.tools?.length ? { tools: options.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) } : {}),
  };
}

function usageOf(usage) {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
  };
}

async function* chunksOf(events) {
  const toolIds = new Map();
  for await (const event of events) {
    if (event.type === "text_start") yield { type: "block-start", index: event.contentIndex, blockType: "text" };
    else if (event.type === "text_delta") yield { type: "text-delta", index: event.contentIndex, text: event.delta };
    else if (event.type === "text_end") yield { type: "block-end", index: event.contentIndex, block: { type: "text", text: event.content } };
    else if (event.type === "thinking_start") yield { type: "block-start", index: event.contentIndex, blockType: "reasoning" };
    else if (event.type === "thinking_delta") yield { type: "reasoning-delta", index: event.contentIndex, text: event.delta };
    else if (event.type === "thinking_end") yield { type: "block-end", index: event.contentIndex, block: { type: "reasoning", text: event.content } };
    else if (event.type === "toolcall_start") {
      const block = event.partial.content[event.contentIndex];
      const known = { id: block?.id ?? "", name: block?.name ?? "" };
      toolIds.set(event.contentIndex, known);
      yield { type: "block-start", index: event.contentIndex, blockType: "tool-call" };
    } else if (event.type === "toolcall_delta") {
      const known = toolIds.get(event.contentIndex) ?? { id: "", name: "" };
      yield { type: "tool-call-delta", index: event.contentIndex, id: CallId(known.id), name: known.name, argumentsDelta: event.delta };
    } else if (event.type === "toolcall_end") {
      yield { type: "block-end", index: event.contentIndex, block: { type: "tool-call", id: CallId(event.toolCall.id), name: event.toolCall.name, arguments: JSON.stringify(event.toolCall.arguments) } };
    } else if (event.type === "done") {
      yield { type: "usage", usage: usageOf(event.message.usage) };
      const kind = event.message.stopReason === "toolUse" ? "tool-calls" : event.message.stopReason === "length" ? "max-tokens" : "stop";
      yield { type: "finish", reason: { kind } };
      return;
    } else if (event.type === "error") {
      yield { type: "usage", usage: usageOf(event.error.usage) };
      yield { type: "finish", reason: { kind: event.error.stopReason === "aborted" ? "aborted" : "error", failure: { message: event.error.errorMessage ?? "Codex error", code: "PROVIDER_ERROR" } } };
      return;
    }
  }
  throw new LlmError("Codex stream ended without a terminal event", "STREAM_CLOSED");
}

class CodexAdapter extends LlmAdapter {
  constructor(models) {
    super();
    this.models = models;
  }

  providerInfo(provider) { return { id: provider, name: "OpenAI Codex (Pi OAuth)" }; }

  listModels(provider) {
    return Promise.resolve(this.models.getModels(provider).map((model) => ({
      provider, id: model.id, name: model.name, inputModalities: model.input,
    })));
  }

  resolveModel(provider, model) {
    const resolved = this.models.getModel(provider, model);
    if (!resolved) return Promise.resolve({ provider, id: model, name: model });
    return Promise.resolve({ provider, id: resolved.id, name: resolved.name, inputModalities: resolved.input, context: { contextWindow: resolved.contextWindow }, defaultMaxTokens: resolved.maxTokens });
  }

  async *stream(options) {
    const model = this.models.getModel(PROVIDER, options.model);
    if (!model) throw new LlmError(`Unknown Codex model: ${options.model}`, "UNKNOWN_MODEL");
    const events = this.models.streamSimple(model, contextOf(options), {
      signal: options.signal,
      ...(options.reasoningEffort && options.reasoningEffort !== "off" ? { reasoning: options.reasoningEffort } : {}),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
      maxRetries: 0,
    });
    yield* chunksOf(events);
  }
}

export const name = "llm-codex-oauth";
export const inject = ["llm"];
export function apply(ctx) {
  const models = createModels({ credentials: new PiAuthStore() });
  models.setProvider(openaiCodexProvider());
  ctx.llm.registerAdapter([PROVIDER], new CodexAdapter(models));
}
