# Codex Provider

通过本机 `codex app-server` 为 DSH 提供模型调用。包名 `@pcmid/dsh-codex-provider`，插件 ID 和 Provider ID 均为 `codex-provider`。

登录由 Codex CLI 管理，复用它的 ChatGPT 登录或 API 配置。插件不读取、复制或保存 OAuth token，也不需要配置 Pi 的 `openai-codex` provider。

## 安装与选择模型

需要 DSH `0.2.2-rc.1` 和 Codex CLI。当前适配的协议版本为 **Codex 0.167.0**，依赖实验性接口，升级 Codex 后应重新运行协议及端到端测试。

```sh
codex --version
codex login
dsh plugin --profile desktop add link:/absolute/path/to/plugins/dsh-codex-provider
```

重新加载对应的 DSH profile，在模型选择器选择 **Codex Provider** 下的模型。默认通过 app-server 的 `model/list` 获取列表；也可在插件配置里指定 `models`。

已有的 `openai-codex` 配置不会自动迁移；这次接入的 provider 是 `codex-provider`。

插件配置示例（对应 profile 的 `cordis.patch.yml`）：

```yaml
- id: codex-provider
  config:
    command: codex
    # codexHome: /absolute/path/to/.codex
    # 可选：不自动发现，直接展示这些模型
    # models: [your-model-id]
    contextWindow: 128000
    timeoutMs: 600000
```

`command` 是可执行文件路径，不是 shell 命令。桌面进程找不到 `codex` 时填写绝对路径。`codexHome` 未设置时沿用进程环境及 Codex 默认目录；需要登录时在同一目录执行 `CODEX_HOME=/absolute/path codex login`。

## DSH 如何调度

1. 每次 DSH 模型请求启动一个临时 app-server 进程和 ephemeral thread。
2. 系统提示词来自 DSH，历史通过 `thread/inject_items` 按原生消息角色和工具调用 ID 导入。工具定义通过 `dynamicTools` 传入，使用稳定别名避免与 Codex 内置工具撞名。
3. 插件读取一次上游模型响应，返回文本、推理摘要和完整的工具调用批次。收到 `rawResponse/completed` 后结束这次工具请求，不等待整个 Codex turn 结束，也不向 Codex 伪造工具结果。
4. DSH 的正常 agent loop 执行工具，负责权限、并行度、日志和插件钩子。
5. DSH 下一次模型请求携带真实工具结果，插件从这份最新历史重新构造会话。

因此 DSH 的工具列表变化、上下文压缩、重试及模型切换不会继续使用遗留的 Codex 会话。取消、超时、消费方提前结束或卸载插件会关闭子进程。

## 当前边界

- 这是实验性 provider。`dynamicTools` 和 `experimentalRawEvents` 需要开启实验性 API；`rawResponse/completed` 更被 Codex 明确标为内部接口，不能依赖其跨版本兼容性。`thread/inject_items` 在当前普通协议定义中，不能一概归为实验性。缺少必要响应事件时插件会报错。
- 每一步都会启动进程并重放历史，增加启动延迟；缓存命中率及费用不能按 Codex CLI 的持久会话估算。
- 当前声明文本输入。图片和文件由 DSH 转换为文本/附件提示；未投影的非文本块会明确报错。历史推理摘要不作为公开 assistant 文本重放。
- `reasoningEffort` 会传给 Codex。app-server 没有对应的 `temperature`、`maxTokens`、`stop` 参数；当前不执行这些 DSH 参数，实际生成限制由 Codex/模型决定。`contextWindow` 是 DSH 的预算，不改变模型容量，默认采用保守的 128000。
- 子进程在临时工作目录运行，禁用环境访问、shell、浏览器、应用、MCP、插件及自动压缩等能力，并使用只读沙箱。部分 Codex 内置控制工具仍可能出现在模型工具列表；若模型选择它们，插件中止这一步并报错，不把它们当成 DSH 工具或批准执行。该方案不提供一个支持任意 Codex 版本的“移除全部原生工具”接口。
- 不提供网页登录界面。认证状态及刷新由本机 Codex 管理；缺少登录时运行 `codex login`。

## 验证

```sh
npm install --no-save --no-package-lock
npm test
npm run test:codex
npm run test:e2e
```

`npm test` 覆盖 DSH 工具批次、结果重放、取消、隔离、错误及 JSON-RPC 流。测试也可通过仓库现有的 hooks 使用旁边已构建的 `deepseek-harness` checkout。

`test:codex` 使用真实 CLI 和临时配置验证协议，不需要登录，也不调用付费模型。`test:e2e` 使用真实 CLI 和本机 Responses SSE fixture 验证两次模型请求之间的工具往返，需要允许监听 `127.0.0.1`；它验证 provider 边界，不启动完整 DSH UI。可通过 `CODEX_BIN` 指定 CLI。

参考：[Codex app-server](https://learn.chatgpt.com/docs/app-server)。
