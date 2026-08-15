# dsh-codex-oauth

[English](README.md) | 中文

一个独立的 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) 插件，通过 OpenAI Codex OAuth 使用 ChatGPT Plus/Pro 订阅模型。

**不需要安装 Pi。** 插件使用 `@earendil-works/pi-ai` 提供的 Codex provider，以及 DSH 公共的 `dsh-llm-pi-ai` 适配器，支持流式输出、工具调用、推理、图片、replay、上下文压缩、OAuth 自动刷新和 Codex 模型目录。

这是 ChatGPT Codex 后端接入，不是普通的 OpenAI Platform API Key 适配器。

## 安装

```bash
dsh plugin --profile web add dsh-codex-oauth
dsh web
```

如果使用 `npx`：

```bash
npx @deepseek-ai/dsh plugin --profile web add dsh-codex-oauth
npx @deepseek-ai/dsh web
```

## 登录

插件拥有独立的 OAuth 登录流程和凭据文件。新用户不需要安装 Pi，也不需要复制任何 token。

### Web UI

打开 **设置 → OpenAI Codex**，点击 **使用 ChatGPT 登录**。插件会打开浏览器完成 OAuth 授权；返回 DSH 后，在模型选择器中选择 `openai-codex`。

### 命令行登录

```bash
dsh plugin --profile web exec dsh-openai-codex login
```

无图形浏览器的机器：

```bash
dsh plugin --profile web exec dsh-openai-codex login --device-code
```

查看状态和退出登录：

```bash
dsh plugin --profile web exec dsh-openai-codex status
dsh plugin --profile web exec dsh-openai-codex logout
```

浏览器登录会打开 OpenAI 授权页面，并通过 localhost 回调完成。登录后，在 DSH 模型选择器中选择 `openai-codex`。

### 凭据存储

凭据默认存储在：

```text
~/.dsh/.openai-codex-auth.json
```

也可以通过 `DSH_HOME` 改变目录。文件采用原子写入、仅所有者可读写（`0600`），登录、刷新和退出登录使用跨进程文件锁。

插件**不会**读取或修改：

```text
~/.pi/agent/auth.json
~/.codex/auth.json
```

## 开发与测试

```bash
npm test
```

测试需要当前 DSH profile 提供 DSH 和 `pi-ai` peer dependencies。

## 限制

- ChatGPT 套餐资格、模型权限、配额和后端行为由 OpenAI 控制，可能变化；
- Codex 端点不是公开的 OpenAI Platform API 端点；
- 文件系统、Shell、MCP、权限、附件等能力仍由当前 DSH profile 提供。

## 许可证

MIT
