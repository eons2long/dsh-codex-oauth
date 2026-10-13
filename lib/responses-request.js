import { createHash } from "node:crypto";
import { LlmError, fileHandleText, offloadedImageText, requestImageHandleText, requiredImageOffload } from "@deepseek-ai/dsh-llm";

export const RESPONSES_REPLAY_PROTOCOL = "openai-responses-v1";
export function wireToolName(name) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : `dsh_${createHash("sha256").update(name).digest("hex").slice(0,32)}`;
}
function wireCallId(id) {
  if (typeof id !== "string" || !id) throw new LlmError("Tool call ID must be a non-empty string", "INVALID_REQUEST");
  // Older adapters store composite IDs. Hash the whole ID to keep calls with a shared prefix distinct.
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : `call_dsh_${createHash("sha256").update(id).digest("hex").slice(0,40)}`;
}
export function toolMap(tools = []) {
  const names = new Map();
  for (const tool of tools) {
    const wire = wireToolName(tool.name);
    if (names.has(wire)) throw new LlmError("Duplicate or conflicting tool names", "INVALID_REQUEST");
    names.set(wire, tool.name);
  }
  return names;
}
export const blockFingerprint = (block) => createHash("sha256").update(JSON.stringify(block)).digest("hex");

function nativeReplay(block, metadata, binding, source) {
  const state = source?.replayState;
  if (state?.response?.protocol !== RESPONSES_REPLAY_PROTOCOL || state.response.clientId !== binding.clientId
    || source.provider !== "openai-codex" || source.model !== binding.model || state.response.model !== binding.model
    || metadata?.fingerprint !== blockFingerprint(block)) return undefined;
  const item = metadata.item;
  if (!item || typeof item !== "object" || !["message", "function_call", "reasoning"].includes(item.type)) return undefined;
  if (block.type === "reasoning" && item.type !== "reasoning") return undefined;
  if (block.type === "tool-call" && (item.type !== "function_call" || item.call_id !== String(block.id)
    || item.name !== wireToolName(block.name) || item.arguments !== block.arguments)) return undefined;
  if (block.type === "text" && (item.type !== "message" || item.content?.length !== 1
    || (item.content[0].text ?? item.content[0].refusal) !== block.text)) return undefined;
  return structuredClone(item);
}

function appendItem(input, item) {
  const last = input.at(-1);
  if (item.type === "message" && item.id && last?.type === "message" && last.id === item.id) last.content.push(...item.content);
  else input.push(item);
}

export async function responsesRequest(options, binding, attachments, resolveAccess) {
  // DSH's summarizer always supplies maxTokens. This route cannot enforce an
  // output cap, so omit that internal budget rather than disabling compaction.
  for (const key of ["temperature", "maxTokens", "stop"]) {
    if (key === "maxTokens" && options.purpose === "compaction") continue;
    if (options[key] !== undefined) throw new LlmError(`ChatGPT plan usage does not support ${key}; leave it unset`, "UNSUPPORTED_OPTION");
  }
  const names = toolMap(options.tools);
  if (binding.info.reasoning?.efforts.length && options.reasoningEffort !== undefined
    && !binding.info.reasoning.efforts.some((level) => level.id === options.reasoningEffort)) throw new LlmError("The selected model does not advertise that reasoning effort", "UNSUPPORTED_OPTION");
  const versions = new Map();
  for (const message of options.messages) for (const block of message.content) {
    if (block.type !== "image" || block.offloaded) continue;
    if (!attachments) throw new LlmError("Image input requires the DSH attachment service", "UNSUPPORTED_CONTENT");
    if (binding.info.inputModalities && !binding.info.inputModalities.includes("image")) throw new LlmError("The selected model does not accept images", "UNSUPPORTED_CONTENT");
    const ref = block.attachment;
    if (!versions.has(ref.attachmentId)) {
      const scale = Math.min(1, Math.sqrt(4_194_304 / (ref.width * ref.height)));
      versions.set(ref.attachmentId, await attachments.readImageRequest(ref, { width: Math.max(1, Math.floor(ref.width * scale)), height: Math.max(1, Math.floor(ref.height * scale)), maxBytes: 1_048_576 }, options.signal));
    }
  }
  const offloadImages = requiredImageOffload(options.messages, { representation: "base64", maxBytes: 32 * 1024 * 1024 }, (block) => versions.get(block.attachment.attachmentId)?.bytes ?? 0);
  if (offloadImages > 0) throw new LlmError("Request images exceed the adapter's 32 MiB base64 budget", "IMAGE_OFFLOAD_REQUIRED", { offloadImages });
  const textContent = async (blocks) => {
    const content = [];
    for (const block of blocks) {
      if (block.type === "text") content.push({ type: "input_text", text: block.text });
      else if (block.type === "image") {
        const access = resolveAccess?.(block.attachment);
        if (block.offloaded) content.push({ type: "input_text", text: offloadedImageText(block.attachment, access) });
        else {
          const version = versions.get(block.attachment.attachmentId);
          content.push({ type: "input_text", text: requestImageHandleText(block.attachment, version, access) });
          content.push({ type: "input_image", image_url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString("base64")}`, detail: "auto" });
        }
      } else if (block.type === "file") {
        const access = attachments?.fileHostPath?.(block.attachment);
        content.push({ type: "input_text", text: fileHandleText(block.attachment, access ? resolveAccess?.(block.attachment, access)?.readonlyPath : undefined) });
      } else if (!["tool-addition", "tool-removal"].includes(block.type)) throw new LlmError(`Unsupported ${block.type} in request content`, "UNSUPPORTED_CONTENT");
    }
    return content;
  };
  const input = [];
  let instructions = options.system;
  const messages = options.messages;
  for (const [messageIndex, message] of messages.entries()) {
    options.signal?.throwIfAborted();
    if (!["assistant", "tool", "system", "developer", "user"].includes(message.role)) throw new LlmError("Unsupported message role", "UNSUPPORTED_CONTENT");
    if (message.role === "assistant") {
      for (const [index, block] of message.content.entries()) {
        const metadata = message.source?.replayState?.blocks?.[index];
        const native = nativeReplay(block, metadata, binding, message.source);
        if (native) {
          if (native.type === "function_call") native.call_id = wireCallId(native.call_id);
          appendItem(input, native); continue;
        }
        if (block.type === "text") input.push({ role: "assistant", content: [{ type: "output_text", text: block.text, annotations: [] }] });
        else if (block.type === "tool-call") input.push({ type: "function_call", call_id: wireCallId(block.id), name: wireToolName(block.name), namespace: "dsh", arguments: block.arguments });
        else if (block.type !== "reasoning") throw new LlmError(`Unsupported assistant ${block.type}`, "UNSUPPORTED_CONTENT");
      }
    } else if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: wireCallId(message.source?.callId), output: await textContent(message.content) });
    } else if (message.role === "system" && messageIndex === 0 && instructions === undefined) {
      instructions = (await textContent(message.content)).map((part) => part.text ?? "").join("\n");
    } else {
      const content = await textContent(message.content);
      if (content.length) input.push({ role: ["system", "developer"].includes(message.role) ? "developer" : "user", content });
    }
  }
  return {
    body: {
      model: binding.model, input, store: false, stream: true,
      ...(instructions !== undefined ? { instructions } : {}),
      ...(options.reasoningEffort !== undefined ? { reasoning: { effort: String(options.reasoningEffort), summary: "auto" } } : {}),
      ...(names.size ? { tools: [{ type: "namespace", name: "dsh", description: "Tools executed by DeepSeek Harness", tools: options.tools.map((tool) => ({
        type: "function", name: wireToolName(tool.name), description: tool.description, parameters: tool.parameters, strict: false,
      })) }] } : {}),
    },
    names,
  };
}
