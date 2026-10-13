import { LlmError, attributionHeaders, isContextWindowExceededError } from "@deepseek-ai/dsh-llm";
import { safeMessage } from "./safe-message.js";

export const OPENAI_API = "https://api.openai.com/v1";
export const OPENAI_ISSUER = "https://auth.openai.com";

function failureCode(code, status, message) {
  if (code === "subscription_sharing_usage_limit_exceeded") return "ACCOUNT_QUOTA_EXCEEDED";
  if (["subscription_sharing_usage_unavailable", "subscription_sharing_user_unavailable"].includes(code)) return "SERVER";
  if (["subscription_sharing_invalid_user", "subscription_sharing_user_not_eligible", "chatpass_v2_scope_not_authorized", "chatpass_v2_invalid_authorization_context"].includes(code)) return "AUTH";
  if (code === "subscription_sharing_unsupported_capability") return "INVALID_REQUEST";
  if (code === "context_length_exceeded" || isContextWindowExceededError(message)) return "CONTEXT_WINDOW_EXCEEDED";
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "RATE_LIMIT";
  if (status >= 500) return "SERVER";
  return status >= 400 ? "INVALID_REQUEST" : "OPENAI_ERROR";
}

export function responseError(body, status, headers = new Headers(), secrets = []) {
  const detail = body?.error;
  const providerCode = typeof detail === "string" ? detail : detail?.code;
  let message = detail?.message ?? body?.error_description ?? body?.detail ?? providerCode ?? `OpenAI request failed${status ? ` (HTTP ${status})` : ""}`;
  if (typeof message !== "string") message = "OpenAI request failed";
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, "[redacted]");
  const retryAfter = headers.get("retry-after");
  const delay = retryAfter === null ? NaN : /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
  const error = new LlmError(safeMessage(message), failureCode(providerCode, status, message), {
    ...(status ? { status } : {}),
    ...(headers.get("x-request-id") ? { requestId: headers.get("x-request-id") } : {}),
    ...(Number.isFinite(delay) && delay > 0 ? { providerRetryAfterMs: delay } : {}),
  });
  error.providerCode = providerCode;
  error.param = detail?.param;
  return error;
}

export async function readJSON(response) {
  try { return await response.json(); }
  catch { throw new LlmError(`OpenAI returned invalid JSON (HTTP ${response.status})`, "INVALID_RESPONSE", { status: response.status }); }
}

export async function openaiFetch(url, options = {}, fetcher = globalThis.fetch) {
  const headers = new Headers(attributionHeaders());
  for (const [name, value] of new Headers(options.headers)) headers.set(name, value);
  try { return await fetcher(url, { ...options, headers, redirect: "error" }); }
  catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    throw new LlmError("Could not reach OpenAI", "TRANSPORT", { cause: error });
  }
}

export async function fetchJSON(url, options = {}, fetcher) {
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(15_000)]);
  const response = await openaiFetch(url, { ...options, signal }, fetcher);
  const body = await readJSON(response);
  if (!response.ok) {
    const form = options.body instanceof URLSearchParams ? options.body : undefined;
    throw responseError(body, response.status, response.headers, [
      new Headers(options.headers).get("authorization")?.replace(/^Bearer /, ""),
      form?.get("code"), form?.get("code_verifier"), form?.get("refresh_token"), form?.get("token"),
    ]);
  }
  return body;
}
