# dsh-llm-codex-oauth

DSH adapter that uses the same OpenAI Codex OAuth credential as Pi:
`~/.pi/agent/auth.json` → `openai-codex`.

It uses Pi's installed `@earendil-works/pi-ai` Codex provider, including the official
Codex Responses transport and OAuth refresh. It does not copy the token into an
API-key environment variable.

## Install

```bash
npm install --prefix ~/.dsh/profiles/web dsh-llm-codex-oauth
```

Add this entry to the active DSH profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: llm-codex-oauth
      name: dsh-llm-codex-oauth
```

The profile must also include the normal `llm` service. Restart:

```bash
npx @deepseek-ai/dsh web
```

Then select provider `openai-codex` in the model picker.

## Scope

Text, reasoning, tool calls, streaming, token refresh, and the model catalog are
covered. Images and durable replay metadata are intentionally not added in this
first version; use a new session after switching to this provider.

The plugin only reads/writes the existing Pi auth file and never prints tokens.
