# dsh-codex-oauth Standalone Login Specification

## Goal

Allow new users to sign in and use ChatGPT Codex subscription models by installing only the DSH plugin. Pi is not required, and the plugin does not read `~/.pi/agent/auth.json`.

## User flow

### CLI (v1)

1. Install the plugin and restart DSH.
2. Run `dsh-openai-codex login`.
3. The plugin opens the OpenAI OAuth authorization page.
4. Approve the authorization in the browser.
5. Complete sign-in through the localhost callback.
6. DSH uses the `openai-codex` model.

Use `login --device-code` on machines without a graphical browser.

### Web

The DSH Settings page provides sign-in status, browser-based OAuth sign-in, and a sign-out button.

### Commands

The plugin provides:

```bash
dsh plugin --profile web exec dsh-openai-codex login
dsh plugin --profile web exec dsh-openai-codex status
dsh plugin --profile web exec dsh-openai-codex logout
```

On machines without a graphical browser, use `dsh-openai-codex login --device-code`.

## Credentials

- Stored at `$DSH_HOME/.openai-codex-auth.json`, defaulting to `~/.dsh/.openai-codex-auth.json`.
- The format is versioned JSON with `version` and `credential` fields.
- `credential` retains `type`, `access`, `refresh`, `expires`, and `accountId`.
- Writes are atomic, and the file uses owner-only permissions (`0600`); the directory uses `0700`.
- Refresh, sign-in, and sign-out use a cross-process file lock.
- The plugin does not read, copy, or modify `~/.pi/agent/auth.json` or `~/.codex/auth.json`.

## API and models

- Use `openaiCodexProvider` from `@earendil-works/pi-ai`.
- Use DSH's public `PiAiAdapter`.
- Use the Codex Responses endpoint rather than pretending to be a regular OpenAI Platform API.
- Preserve streaming output, tool calls, reasoning, images, replay, and context compaction.
- New agents inherit the available model from the Codex catalog instead of hard-coding a model that may not exist.

## Security boundaries

- OAuth passwords, authorization codes, access tokens, and refresh tokens must not appear in logs, sessions, Git, or error messages.
- The Web login callback accepts only same-origin localhost requests and returns `no-store`.
- Removing the plugin does not delete credentials automatically; sign-out must be explicit.
- Do not implement a regular OpenAI API-key compatibility layer.

## Explicitly out of scope

- Do not depend on Pi.
- Do not import Pi's auth file.
- Do not modify DSH source code.
- The first version does not include standalone search, image generation, or a quota dashboard; those belong to a later phase.

## Acceptance criteria

- In a clean environment, installing the plugin and running `status` reports signed out.
- After CLI OAuth sign-in, `status` reports signed in without printing a token.
- When an access token expires, a request refreshes it automatically and persists the new credential.
- Deleting the Pi auth file does not affect the DSH plugin.
- The Web profile loads `openai-codex`, and the shared DSH adapter's image, tool, and replay tests continue to pass.
