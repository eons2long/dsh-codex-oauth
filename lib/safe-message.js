export function safeMessage(error) {
  return String(error?.message ?? error)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]")
    .replace(/([?&](?:code|token|refresh_token|access_token|id_token)=)[^&#\s]+/giu, "$1[redacted]")
    .replace(/(["']?(?:access_token|refresh_token|id_token|authorization_code|code_verifier|token|code)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^,}\s]+)/giu, "$1[redacted]")
    .replace(/(\bBearer\s+)[^\s,]+/giu, "$1[redacted]")
    .slice(0, 500);
}
