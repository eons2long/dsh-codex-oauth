# dsh-codex-oauth

[English](README.md) | 中文

让 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness)
复用 Pi 已登录的 ChatGPT Plus/Pro Codex OAuth，在不使用 OpenAI Platform API Key 的情况下调用 `openai-codex` 模型。

本插件不是普通的 OpenAI API 适配器，也不会把 ChatGPT 订阅变成通用 API 凭据。它使用 Pi 的 Codex provider、官方 Codex Responses 传输和 DSH 公共的 `dsh-llm-pi-ai` 适配器。

## 功能

- 复用 `~/.pi/agent/auth.json` 中的 `openai-codex` OAuth 凭据；
- access token 过期时自动使用 refresh token 更新；
- 使用 Pi 同款 Codex 模型目录；
- 支持流式输出、工具调用、推理、图片输入、replay 和上下文压缩；
- 不读取或打印 API Key，也不会把 token 放进环境变量。

## 安装

将插件安装到 dsh 的 `web` profile：

```bash
dsh plugin --profile web add dsh-codex-oauth
dsh web
```

如果使用的是 `npx` 版本：

```bash
npx @deepseek-ai/dsh plugin --profile web add dsh-codex-oauth
npx @deepseek-ai/dsh web
```

启动后，在模型选择器中选择：

```text
Provider: openai-codex
```

也可以手动把下面的条目加入 profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: llm-codex-oauth
      name: dsh-codex-oauth
```

## 前置条件

Pi 必须已经完成 OpenAI Codex 登录，并且存在：

```text
~/.pi/agent/auth.json
```

文件中应有 `openai-codex` OAuth 条目。插件不会替用户登录，也不会要求复制 token。

## 凭据与并发注意事项

插件只使用 Pi 的现有凭据文件，并会在 OAuth 刷新后写回该文件。Pi 与 DSH 并不共享同一个跨应用锁，因此在 token 可能刷新时，不建议同时运行 Pi 和 DSH。

卸载插件不会删除 Pi 的登录凭据。若要退出登录，请通过 Pi 自己的 `/logout` 完成。

## 限制

- ChatGPT 订阅权限、模型目录、配额和 Codex 后端行为由 OpenAI 控制，可能变化；
- 插件依赖 DSH 的公共 `dsh-llm-pi-ai` 适配器，需与当前 DSH 版本兼容；
- 这是 Codex 后端接入，不是公开的 OpenAI Platform API；
- DSH 的其他能力（文件系统、Shell、MCP、权限、附件等）仍由当前 profile 提供。

## 开发与测试

```bash
npm test
```

测试需要 DSH 和 Pi 的依赖已经安装或由 DSH profile 提供。

## 许可证

MIT
