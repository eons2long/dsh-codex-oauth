import { LlmError } from "@deepseek-ai/dsh-llm";
import { responseError } from "./openai-http.js";
import { blockFingerprint, RESPONSES_REPLAY_PROTOCOL } from "./responses-request.js";

export async function* readSSE(body, signal, activity = () => {}) {
  if (!body) throw new LlmError("OpenAI returned no response stream", "INVALID_RESPONSE");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  const cancel = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  function parse(packet) {
    if (packet.length > 16 * 1024 * 1024) throw new LlmError("OpenAI stream event exceeds 16 MiB", "INVALID_RESPONSE");
    const data = packet.split(/\r\n|\n|\r/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data || data === "[DONE]") return undefined;
    let event;
    try { event = JSON.parse(data); } catch { throw new LlmError("OpenAI returned malformed stream data", "INVALID_RESPONSE"); }
    if (!event || typeof event.type !== "string") throw new LlmError("OpenAI returned an invalid stream event", "INVALID_RESPONSE");
    return event;
  }
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) { buffer += decoder.decode(); break; }
      activity();
      buffer += decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
        const packet = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const event = parse(packet);
        if (event) yield event;
      }
      if (buffer.length > 16 * 1024 * 1024) throw new LlmError("OpenAI stream event exceeds 16 MiB", "INVALID_RESPONSE");
    }
    const event = parse(buffer);
    if (event) yield event;
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function tokenUsage(usage) {
  if (!usage) return undefined;
  const input = usage.input_tokens, output = usage.output_tokens;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  if (![input, output, cached].every((value) => Number.isSafeInteger(value) && value >= 0) || cached > input) {
    throw new LlmError("OpenAI returned invalid token usage", "INVALID_RESPONSE");
  }
  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  return { inputTokens: input - cached, outputTokens: output,
    ...(Number.isSafeInteger(usage.total_tokens) && usage.total_tokens === input + output ? { totalTokens: usage.total_tokens } : {}),
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(Number.isSafeInteger(reasoning) && reasoning >= 0 && reasoning <= output ? { reasoningTokens: reasoning } : {}),
  };
}

export async function* responsesStream(events, binding, names, headers) {
  const items = new Map(), blocks = new Map(), order = [];
  const invalid = (message) => { throw new LlmError(message, "INVALID_RESPONSE"); };
  function* start(key, type, itemIndex, partIndex) {
    if (blocks.has(key)) return blocks.get(key);
    const block = { index: order.length, type, itemIndex, partIndex, text: "", arguments: "", closed: false };
    blocks.set(key, block); order.push(block);
    yield { type: "block-start", index: block.index, blockType: type };
    return block;
  }
  function toolName(item) {
    if (item.namespace && item.namespace !== "dsh") invalid("OpenAI returned a tool call in an unexpected namespace");
    const name = names.get(item.name);
    if (!name) invalid("OpenAI returned a tool call that was not offered");
    return name;
  }
  function* added(item, index) {
    items.set(index, item);
    if (item.type === "reasoning") yield* start(`${index}:reasoning`, "reasoning", index);
    else if (item.type === "function_call") {
      if (typeof item.call_id !== "string" || !item.call_id) invalid("OpenAI returned a tool call without a call ID");
      const block = yield* start(`${index}:function`, "tool-call", index);
      block.id = item.call_id; block.name = toolName(item);
      if (!block.announced) {
        block.announced = true;
        block.arguments = typeof item.arguments === "string" ? item.arguments : "";
        yield { type: "tool-call-delta", index: block.index, id: block.id, name: block.name, argumentsDelta: block.arguments };
      }
    } else if (item.type !== "message") invalid(`Unsupported OpenAI output item: ${item.type}`);
  }
  function* text(key, type, itemIndex, partIndex, delta) {
    if (typeof delta !== "string") invalid("OpenAI returned a non-text delta");
    const block = yield* start(key, type, itemIndex, partIndex);
    if (block.closed) invalid("OpenAI sent a delta after a completed block");
    block.text += delta;
    yield { type: type === "text" ? "text-delta" : "reasoning-delta", index: block.index, text: delta };
  }
  function* close(block, item, part) {
    if (block.closed) return;
    let content, native;
    if (block.type === "tool-call") {
      const args = item.arguments;
      if (typeof args !== "string" || !args.startsWith(block.arguments)) invalid("OpenAI returned inconsistent tool-call arguments");
      const rest = args.slice(block.arguments.length);
      if (rest) yield { type: "tool-call-delta", index: block.index, id: block.id, argumentsDelta: rest };
      try { const parsed = JSON.parse(args); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); }
      catch { invalid("OpenAI returned invalid tool-call arguments"); }
      content = { type: "tool-call", id: block.id, name: block.name, arguments: args };
      native = { ...item, namespace: "dsh" };
    } else {
      const final = block.type === "reasoning" ? (item.summary ?? []).map((part) => part.text ?? "").join("\n\n") : part?.text ?? part?.refusal ?? "";
      if (!final.startsWith(block.text)) invalid("OpenAI returned inconsistent response text");
      const rest = final.slice(block.text.length);
      if (rest) yield { type: block.type === "text" ? "text-delta" : "reasoning-delta", index: block.index, text: rest };
      content = { type: block.type, text: final };
      native = block.type === "reasoning" ? item : { ...item, content: [part] };
    }
    block.closed = true; block.content = content;
    block.replay = { fingerprint: blockFingerprint(content), item: structuredClone(native) };
    yield { type: "block-end", index: block.index, block: content };
  }
  function* done(item, index) {
    if (!items.has(index)) yield* added(item, index);
    items.set(index, item);
    if (item.type === "message") {
      if (!Array.isArray(item.content)) invalid("OpenAI returned a message without content");
      for (const [partIndex, part] of item.content.entries()) {
        if (!["output_text", "refusal"].includes(part.type)) invalid(`Unsupported OpenAI message content: ${part.type}`);
        const block = yield* start(`${index}:text:${partIndex}`, "text", index, partIndex);
        yield* close(block, item, part);
      }
    } else {
      const block = blocks.get(`${index}:${item.type === "reasoning" ? "reasoning" : "function"}`);
      if (!block) invalid("OpenAI returned inconsistent output item types");
      yield* close(block, item);
    }
  }
  for await (const event of events) {
    const index = event.output_index;
    if ((event.type.startsWith("response.output_item.") || ["response.content_part.added", "response.output_text.delta", "response.refusal.delta", "response.reasoning_summary_text.delta", "response.function_call_arguments.delta"].includes(event.type))
      && (!Number.isSafeInteger(index) || index < 0)) invalid("OpenAI returned an invalid output index");
    if (["response.content_part.added", "response.output_text.delta", "response.refusal.delta"].includes(event.type)
      && (!Number.isSafeInteger(event.content_index) || event.content_index < 0)) invalid("OpenAI returned an invalid content index");
    switch (event.type) {
      case "response.output_item.added": yield* added(event.item, index); break;
      case "response.output_item.done": yield* done(event.item, index); break;
      case "response.content_part.added":
        if (["output_text", "refusal"].includes(event.part?.type)) yield* start(`${index}:text:${event.content_index}`, "text", index, event.content_index);
        break;
      case "response.output_text.delta":
      case "response.refusal.delta": yield* text(`${index}:text:${event.content_index}`, "text", index, event.content_index, event.delta); break;
      case "response.reasoning_summary_text.delta": {
        const block = yield* start(`${index}:reasoning`, "reasoning", index);
        if (block.lastSummaryIndex !== undefined && block.lastSummaryIndex !== event.summary_index) yield* text(`${index}:reasoning`, "reasoning", index, undefined, "\n\n");
        block.lastSummaryIndex = event.summary_index;
        yield* text(`${index}:reasoning`, "reasoning", index, undefined, event.delta);
        break;
      }
      case "response.function_call_arguments.delta": {
        const block = blocks.get(`${index}:function`);
        if (!block || block.closed || typeof event.delta !== "string") invalid("OpenAI returned an invalid tool-call delta");
        block.arguments += event.delta;
        yield { type: "tool-call-delta", index: block.index, id: block.id, argumentsDelta: event.delta };
        break;
      }
      case "response.failed": {
        const usage = tokenUsage(event.response?.usage);
        if (usage) yield { type: "usage", usage };
        throw responseError({ error: event.response?.error }, undefined, headers);
      }
      case "error": throw responseError({ error: event }, undefined, headers);
      case "response.incomplete": {
        const usage = tokenUsage(event.response?.usage);
        if (usage) yield { type: "usage", usage };
        if (event.response?.incomplete_details?.reason !== "max_output_tokens") throw new LlmError("OpenAI response ended incomplete", "INCOMPLETE_RESPONSE", { requestId: headers?.get("x-request-id") ?? undefined });
        yield { type: "finish", reason: { kind: "max-tokens" } };
        return;
      }
      case "response.completed": {
        const response = event.response;
        if (!response || (response.status && response.status !== "completed") || !Array.isArray(response.output)) invalid("OpenAI returned an invalid completed response");
        for (const [itemIndex, item] of response.output.entries()) yield* done(item, itemIndex);
        if (order.some((block) => !block.closed)) invalid("OpenAI completed a response with unfinished blocks");
        const usage = tokenUsage(response.usage);
        if (usage) yield { type: "usage", usage };
        if (!order.some((block) => block.type === "tool-call" || (block.type === "text" && block.content.text.trim()))) throw new LlmError("OpenAI completed a response without visible content or tool calls", "EMPTY_RESPONSE");
        yield { type: "finish", reason: { kind: order.some((block) => block.type === "tool-call") ? "tool-calls" : "stop" }, replayState: {
          response: { protocol: RESPONSES_REPLAY_PROTOCOL, clientId: binding.clientId, model: binding.model, id: response.id },
          blocks: order.map((block) => block.replay),
        } };
        return;
      }
    }
  }
  throw new LlmError("OpenAI stream ended without a terminal response event", "TRANSPORT", { requestId: headers?.get("x-request-id") ?? undefined });
}
