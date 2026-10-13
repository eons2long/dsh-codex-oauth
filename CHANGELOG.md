# Changelog

## 0.3.0 — 2026-10-13

### Upgrade requirements

- Requires Node.js 22+ and the DSH 0.2.0-rc.2 adapter contract.
- Sign in again with the native Sign in with ChatGPT flow. The plugin keeps legacy credentials but cannot use them for native inference.
- Device-code login is no longer supported. Configure supported request options as described in the README.

### Changes

- Implement DSH's official `LlmAdapter` directly, removing the pi-ai dependency. Use native OAuth, the account's live model catalog, and the public Responses API.
- Add account registration, selection, credential renewal and revocation, with verified ID tokens and serialized rotating refreshes.
- Preserve reasoning/tool replay and normalize historical tool call IDs to the API's 64-character limit.
- Supply stable DSH session headers for prompt-cache reuse and allow DSH's automatic compaction budget without sending an unsupported API output cap.
- Add English Web quota bars, compact TUI quota summaries, and `/codex-usage` details. Prefer response quota data; fall back to WHAM with the plugin's retained, unexpired legacy Codex credentials. Quota checks do not call a model.
- Include an optional, manually applied dsh-tui 0.14.0 patch that places quota alongside model and reasoning effort. Narrow terminals truncate fields without an extra quota row.

### Quota limitations

WHAM reports Codex subscription limits; equivalence to native SIWC application limits is unconfirmed. Matching email claims are required but do not prove the same workspace. Legacy credentials are neither imported from Pi/Codex apps nor refreshed by the quota lookup. Missing or expired credentials leave quota unavailable. These source qualifications are documented rather than added to the UI.

### Validation

33 automated behavior tests pass. Native inference, cache affinity, quota lookup, and TUI display were also exercised during local development. The inline layout was checked at normal and 40-column widths.
