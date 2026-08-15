# dsh-codex-oauth 独立登录规格

## 目标

让新用户只安装 DSH 插件即可登录并使用 ChatGPT Codex 订阅，不要求安装 Pi，也不读取或修改 `~/.pi/agent/auth.json`。

## 用户流程

### CLI（第一版）

1. 安装插件并重启 DSH；
2. 执行 `dsh-openai-codex login`；
3. 插件打开 OpenAI OAuth 授权页；
4. 用户在浏览器中批准；
5. localhost 回调完成登录；
6. DSH 使用 `openai-codex` 模型。

无图形浏览器时使用 `login --device-code`。

### Web

在 DSH 设置页提供登录状态、浏览器 OAuth 登录和退出登录按钮。

### 命令

提供：

```bash
dsh plugin --profile web exec dsh-openai-codex login
dsh plugin --profile web exec dsh-openai-codex status
dsh plugin --profile web exec dsh-openai-codex logout
```

无图形浏览器时提供 `login --device-code`。

## 凭据

- 存储位置：`$DSH_HOME/.openai-codex-auth.json`，默认 `~/.dsh/.openai-codex-auth.json`；
- 格式：版本化 JSON，字段为 `version` 和 `credential`；
- `credential` 保留 `type`, `access`, `refresh`, `expires`, `accountId`；
- 原子写入，文件权限 `0600`，目录权限 `0700`；
- 刷新、登录、登出使用跨进程文件锁；
- 不读取、复制、修改 `~/.pi/agent/auth.json` 或 `~/.codex/auth.json`。

## API 与模型

- 使用 `@earendil-works/pi-ai` 的 `openaiCodexProvider`；
- 使用 DSH 公共 `PiAiAdapter`；
- 使用 Codex Responses endpoint，不伪装成普通 OpenAI Platform API；
- 保留流式输出、工具调用、推理、图片、replay 和 compaction；
- 新建 agent 默认模型沿用 Codex catalog 中的可用模型，不硬编码不存在的模型。

## 安全边界

- OAuth 密码、授权码、access token、refresh token 不进入日志、session、Git 或错误信息；
- Web 登录回调只接受 localhost 同源请求，并返回 `no-store`；
- 插件移除不自动删除凭据；登出必须由用户明确执行；
- 不实现普通 OpenAI API Key 兼容层。

## 明确不做

- 不依赖 Pi；
- 不导入 Pi 的 auth 文件；
- 不修改 DSH 源码；
- 第一版不加入独立搜索、图片生成和额度面板；这些属于后续功能。

## 验收标准

- 干净环境安装插件后，`status` 返回 signed out；
- CLI OAuth 登录后，`status` 返回 signed in，且不打印 token；
- access token 过期后请求会自动刷新并持久化；
- 删除 Pi auth 文件不影响 DSH 插件；
- Web profile 能加载 `openai-codex`，且公共 DSH adapter 的图片、工具和 replay 测试继续通过。
