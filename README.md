# dsh-codex-oauth

[English](README.md) | [中文](README.zh.md)

Use ChatGPT plan models in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) through [OpenAI's direct OAuth integration](https://developers.openai.com/siwc/token-sharing-open-source). Version 0.3 implements DSH's official `LlmAdapter` directly and has no `pi-ai` or `dsh-llm-pi-ai` dependency.

The plugin handles browser authorization, account selection, rotating token refresh, current account model discovery, and Responses streaming. It translates DSH tools, images and conversation history, and preserves completed encrypted reasoning for subsequent turns. Filesystem access, tool execution, permissions and context compaction remain DSH responsibilities.

## Requirements and installation

Requires Node.js 22 or newer and DSH `0.2.0-rc.2` compatible `dsh-llm` and `dsh-atomic-write` packages. Version 0.3 no longer supports the old DSH 0.1 adapter contract.

Install into the profile you actually run:

```bash
dsh plugin --profile dsh-tui add -w dsh-codex-oauth@^0.3.0
dsh --profile dsh-tui
```

For a source checkout:

```bash
npm install
npm run build
npm pack --ignore-scripts
dsh plugin --profile dsh-tui add -w "file:$PWD/dsh-codex-oauth-0.3.0.tgz"
dsh --profile dsh-tui
```

For the Web surface, use `--profile web` and launch `dsh web`.

Installing the archive also avoids pnpm reusing an older local directory's file list when upgrading an existing source installation.

If the TUI profile also loads its built-in subscription OAuth module, exclude `openai-codex` from `dsh-tui-auth` so this plugin owns that provider. In `$DSH_HOME/profiles/dsh-tui/cordis.patch.yml` (default `~/.dsh/profiles/dsh-tui/cordis.patch.yml`):

```yaml
- id: dsh-tui-auth
  config:
    providers: [anthropic, xai, meta]
```

Preserve any existing `credentialsFile` and `modelOverrides` in that block. Retain only providers supported by your installed TUI. Restart the profile after upgrading the plugin.

## Sign in and choose a model

```bash
dsh plugin --profile dsh-tui exec dsh-openai-codex login
dsh plugin --profile dsh-tui exec dsh-openai-codex status
dsh plugin --profile dsh-tui exec dsh-openai-codex models --refresh
```

Authorize the application in the browser and allow ChatGPT plan usage. The local callback binds to `127.0.0.1:1455`, falling back to another loopback port when necessary. This flow requires browser authorization; `--device-code` is unavailable.

In the Web UI, open **Settings → OpenAI Codex**, select **Continue with ChatGPT**, and return after authorization. The section offers account selection, cancellation, sign-out, model refresh and a [manage usage link](https://chatgpt.com/settings/usage). Identity-only authorization is shown separately; sign in again to authorize plan usage.

Choose provider `openai-codex` in DSH's model picker. Models come from the selected account's live catalog, including new releases such as GPT-6.1 Sol when the account has access. The plugin preserves the server's display names and ordering, caches the catalog for five minutes, and supports explicit refresh. It does not maintain a fixed model list.

## Accounts and credentials

```bash
dsh plugin --profile dsh-tui exec dsh-openai-codex login --new-account
dsh plugin --profile dsh-tui exec dsh-openai-codex accounts
dsh plugin --profile dsh-tui exec dsh-openai-codex use <client-id>
dsh plugin --profile dsh-tui exec dsh-openai-codex logout
```

Each account retains its issued application registration. Reauthorization reuses that registration and verifies the same identity. Sign-out attempts remote revocation, clears the selected account's local tokens and keeps the registration for later sign-in. It leaves other accounts intact. Cancelling a pending login preserves the previous account.

Credentials are stored in `$DSH_HOME/.openai-codex-auth.v2.json`, defaulting to `~/.dsh/.openai-codex-auth.v2.json`. The versioned document keeps a stable host identifier, account registrations and the active selection. Writes are atomic; the directory is owner-only and the file is `0600` on POSIX. A cross-process lock serializes token rotation. Temporary refresh failures preserve credentials; terminal refresh failures clear expired authorization.

**Upgrade from 0.2:** sign in again using the new authorization flow. Legacy `.openai-codex-auth.json` credentials cannot authorize this API route and are left untouched. The plugin never imports or changes `~/.pi/agent/auth.json` or `~/.codex/auth.json`.

## Supported behavior and limits

Requests use `https://api.openai.com/v1/responses` with OAuth, `store: false`, `stream: true` and the required history in `input`. No API key is required. Usage is subject to ChatGPT plan eligibility and application quotas; the plugin never falls back to API key billing.

DSH's session identity supplies stable `session-id` and `x-client-request-id` headers for ordinary and compaction calls. This preserves the gateway's session affinity for prompt-cache reuse; cache hits are still not guaranteed. Calls without a session identity omit these headers.

- DSH function tools run locally, grouped in a Responses namespace. All offered definitions are sent; native Responses `tool_search` is unavailable on this route.
- Text and images use DSH attachments. Files and offloaded images are represented by local handles for DSH tools; this plugin does not upload files to OpenAI's Files API.
- Reasoning effort and context metadata come from the live catalog when advertised. Replay state is reused only for unchanged blocks from the same model and account. Compacted or edited messages use the remaining DSH history.
- `temperature`, `maxTokens` and `stop` fail with `UNSUPPORTED_OPTION` when set, because this ChatGPT plan route does not support them. Leave them unset in your agent configuration.
- DSH history summarization (`purpose: compaction`) accepts the `maxTokens` budget supplied automatically by its compaction backend and omits it from the API request. Automatic and manual DSH compaction can run, but the backend's summary output cap is not enforced by this route. The existing history prefix is preserved before the appended summarization instruction.
- Only a completed response is successful. Usage-limit failures, incomplete responses and interrupted streams have distinct failure semantics. Account quotas stop retries; transient provider failures use DSH's retry policy.
- Hosted Responses image generation, file search, Code Interpreter, computer use, MCP and audio/video are outside this adapter. Local DSH capabilities remain available as function tools.

See OpenAI's [current preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

## Development

### Quota display

Web settings show English remaining-quota bars and reset timestamps. The TUI status line shows a compact summary; `/codex-usage` expands all available windows and their last-update times. Windows are labeled by the server's duration (300 minutes is 5h, 10,080 minutes is Weekly), not their primary/secondary position.

The compact summary is `codex 81% 4h36m 50% 5d4m`, with shorter windows first. `*` marks stale data; `?` means the reset time is unavailable. For dsh-tui 0.14.0, `node scripts/patch-tui-quota-placement.mjs [path/to/Chat.js]` moves just this contribution into the model/effort footer row below the input box and saves sibling backups of Chat.js and StatusLine.js. The existing field layout truncates narrow rows rather than adding a quota row. This is a local host patch because the public status API only supports placement above the prompt. Reinstalling/upgrading the TUI may remove it; the patch refuses unsupported versions.

For an npm-installed TUI profile, apply the optional patch with:

```bash
node "${DSH_HOME:-$HOME/.dsh}/profiles/dsh-tui/node_modules/dsh-codex-oauth/scripts/patch-tui-quota-placement.mjs"
```

Restart the TUI afterward. Without this patch the summary uses the standard position above the input box. Installation never applies the patch automatically.

The adapter observes `x-codex-*` response headers and `codex.rate_limits` stream events from normal requests. When these do not provide fresh data, the display queries `https://chatgpt.com/backend-api/wham/usage` with the plugin's retained legacy Codex credentials in `.openai-codex-auth.json`, beside its native auth file. It does not read Pi or Codex app credentials, change the inference route, or call a model. Successful lookups are cached for 60 seconds; failures back off for 30 seconds. Concurrent displays share one request.

This fallback reports Codex subscription limits, which have not been proven identical to the native SIWC application's limits. The saved credentials must have matching email claims; matching email does not establish the same workspace. This qualification belongs to the documentation, not the UI. Missing, expired, unrelated, or rejected legacy credentials leave quota unavailable. The lookup does not refresh or modify the legacy login: renew that login separately when it expires.

Snapshots stay in memory, clear on account changes/sign-out, and become stale after five minutes or a reported reset. Failed queries preserve the previous snapshot; passing a reset timestamp never fabricates a fresh 100% allowance. Source formats are parsed independently rather than merging windows from different endpoints.

```bash
npm install
npm test
# Optional: requires a signed-in test account; uses ChatGPT plan allowance.
DSH_HOME=/path/to/test-home npm run test:live -- gpt-6.1-sol
```

`npm test` builds the Web bundle and checks OAuth identity validation, concurrent refresh, account changes, Web route boundaries, streamed errors, tool and reasoning replay, attachments and integration with DSH's official runtime. The live check performs a three-turn tool round trip and verifies history replay.

## License

MIT
