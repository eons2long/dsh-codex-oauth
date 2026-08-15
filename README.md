# dsh-codex-oauth

[English](README.md) | [中文](README.zh.md)

A standalone [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin for using ChatGPT Plus/Pro Codex models through OpenAI's Codex OAuth flow. Pi is **not** required.

It uses the official `openaiCodexProvider` from `@earendil-works/pi-ai` and DSH's public `dsh-llm-pi-ai` adapter. It supports streaming, tool calls, reasoning, images, replay, compaction, automatic token refresh, and the Codex model catalog.

This is the ChatGPT Codex backend, not a general OpenAI Platform API-key adapter.

## Install

```bash
dsh plugin --profile web add dsh-codex-oauth
dsh web
```

For an `npx` installation:

```bash
npx @deepseek-ai/dsh plugin --profile web add dsh-codex-oauth
npx @deepseek-ai/dsh web
```

## Sign in

The plugin owns its own credential file and login flow. No Pi installation or token copying is needed.

### Web UI

Open **Settings → OpenAI Codex** and click **Sign in with ChatGPT**. A browser window opens for the OAuth approval; after it completes, return to DSH and select `openai-codex` in the model picker.

### CLI

```bash
dsh plugin --profile web exec dsh-openai-codex login
# headless machines:
dsh plugin --profile web exec dsh-openai-codex login --device-code

dsh plugin --profile web exec dsh-openai-codex status
dsh plugin --profile web exec dsh-openai-codex logout
```

The browser login opens OpenAI's authorization page and completes through a localhost callback. `--device-code` is the fallback for machines without a usable browser.

After signing in, choose `openai-codex` in the DSH model picker.

### Credentials

Credentials are stored at:

```text
$DSH_HOME/.openai-codex-auth.json
```

The default is `~/.dsh/.openai-codex-auth.json`. The file is written atomically with owner-only permissions, and refresh/login/logout operations use a cross-process file lock. The plugin never reads or modifies `~/.pi/agent/auth.json` or `~/.codex/auth.json`.

## Development

```bash
npm test
```

`npm test` rebuilds the Web bundle before running the smoke checks.

The test requires the DSH and `pi-ai` peer dependencies supplied by a DSH profile.

## Limitations

- ChatGPT plan eligibility, model access, quotas, and backend behavior are controlled by OpenAI and may change.
- Codex endpoints are not public OpenAI Platform API endpoints.
- Filesystem, shell, MCP, permissions, attachments, and other DSH capabilities come from the active profile.

## License

MIT
