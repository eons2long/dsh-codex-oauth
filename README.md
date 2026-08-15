# dsh-codex-oauth

[English](README.md) | [中文](README.zh.md)

DSH adapter that uses the same OpenAI Codex OAuth credential as Pi:
`~/.pi/agent/auth.json` → `openai-codex`.

It uses Pi's installed `@earendil-works/pi-ai` Codex provider and DSH's public
`dsh-llm-pi-ai` adapter, including the official Codex Responses transport, images,
tool calls, reasoning replay, compaction, and OAuth refresh. It does not copy the
token into an API-key environment variable.

## Install

```bash
dsh plugin --profile web add dsh-codex-oauth
```

For a manual profile install, add the package to the profile and include this
entry in its `cordis.patch.yml`:

```yaml
- insert:
    - id: llm-codex-oauth
      name: dsh-codex-oauth
```

The profile must also include the normal `llm` service. Restart:

```bash
npx @deepseek-ai/dsh web
```

Then select provider `openai-codex` in the model picker.

## Scope

The plugin delegates message conversion, streaming, image attachments, tool calls,
reasoning replay, and compaction to DSH's public `dsh-llm-pi-ai` adapter. It only
bridges the credential store to Pi's existing OAuth document.

The plugin reads/writes `~/.pi/agent/auth.json` and never prints token values.
Because Pi and DSH do not share a cross-application lock, avoid starting both at the
same time while an OAuth refresh may occur; a future version may use a separate DSH
credential file and its own login flow to remove that race.

## License

MIT
