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

重新加载对应的 DSH profile。插件默认不启用运行实例、不启动 Codex；在 **设置 → 模型 → 添加供应商** 选择 **Codex Provider**，点击 **使用 Codex Provider** 后启用，再在模型选择器选择它的模型。默认通过 app-server 的 `model/list` 获取列表；也可在插件配置里指定 `models`。其他供应商的请求不会经过 Codex。

供应商卡片提供默认收起的 **高级设置（选填）**：

- **Codex 命令行路径**：留空时执行 `codex`，由 `PATH` 查找；也可填写可执行文件的完整路径。
- **拦截 Codex 原生工具**：默认关闭，允许 Codex 执行可用的原生工具。开启后禁用原生工具及环境访问；模型误调用时，由 Codex 将工具不可用的结果反馈给模型继续生成。两种模式都不会再因原生工具调用抛出 `Unexpected Codex response item` 或 `Codex attempted a non-DSH tool`。

已有的 `openai-codex` 配置不会自动迁移；这次接入的 provider 是 `codex-provider`。

插件配置示例（对应 profile 的 `cordis.patch.yml`）：

```yaml
- id: codex-provider
  config:
    providers:
      codex-provider:
        advanced:
          # command: /absolute/path/to/codex
          interceptNativeTools: false
    # codexHome: /absolute/path/to/.codex
    # 可选：不自动发现，直接展示这些模型
    # models: [your-model-id]
    contextWindow: 128000
    timeoutMs: 600000
```

省略 `providers.codex-provider` 时供应商保持未启用。高级设置的 `command` 是可执行文件路径，不是 shell 命令；桌面进程找不到 `codex` 时填写绝对路径。旧的顶层 `command` 不再控制新供应商卡片，请将自定义路径移到高级设置。`codexHome` 未设置时沿用进程环境及 Codex 默认目录；需要登录时在同一目录执行 `CODEX_HOME=/absolute/path codex login`。

## DSH 如何调度

1. 每次 DSH 模型请求启动一个临时 app-server 进程和 ephemeral thread。
2. 系统提示词来自 DSH，历史通过 `thread/inject_items` 按原生消息角色和工具调用 ID 导入。工具定义通过 `dynamicTools` 传入，使用稳定别名避免与 Codex 内置工具撞名。
3. Codex 处理原生工具并继续生成，插件累计这些上游请求的用量。收到完整的 DSH 工具批次后，等待同批原生工具返回结果，再将 DSH 调用交还 Harness；不向 Codex 伪造工具成功结果。
4. DSH 的正常 agent loop 执行 DSH 工具，负责权限、并行度、日志和插件钩子。`exec` 内嵌的 DSH 工具调用会收到改为直接调用的提示，由模型重新选择，避免双方互相等待。
5. DSH 下一次模型请求携带真实工具结果。已完成的原生调用及结果保存在 assistant 的私有重放元数据里，随后一并导入 Codex。

因此 DSH 的工具列表变化、上下文压缩、重试及模型切换不会继续使用遗留的 Codex 会话。取消、超时、消费方提前结束或卸载插件会关闭子进程。

## 当前边界

- 这是实验性 provider。`dynamicTools` 和 `experimentalRawEvents` 需要开启实验性 API；`rawResponse/completed` 更被 Codex 明确标为内部接口，不能依赖其跨版本兼容性。`thread/inject_items` 在当前普通协议定义中，不能一概归为实验性。缺少必要响应事件时插件会报错。
- 每一步都会启动进程并重放历史，增加启动延迟；缓存命中率及费用不能按 Codex CLI 的持久会话估算。
- 当前声明文本输入。图片和文件由 DSH 转换为文本/附件提示；未投影的非文本块会明确报错。历史推理摘要不作为公开 assistant 文本重放。
- `reasoningEffort` 会传给 Codex。app-server 没有对应的 `temperature`、`maxTokens`、`stop` 参数；当前不执行这些 DSH 参数，实际生成限制由 Codex/模型决定。`contextWindow` 是 DSH 的预算，不改变模型容量，默认采用保守的 128000。
- 子进程仍使用临时工作目录和只读沙箱。关闭拦截会启用原生 `exec`、保留 Codex 可用的本地工具配置；工作区操作优先走 DSH 工具。浏览器、应用、MCP、插件、子代理及自动压缩继续禁用。审批和交互输入请求会回绝给 Codex，由模型继续处理，不弹出另一套审批界面。
- 原生运行状态只在本次 DSH 模型请求内保留；跨 DSH 步骤重放的是已完成的调用结果，不恢复后台进程或 `exec` 的活动 cell。不要依赖这类状态跨 DSH 工具批次存活。
- 原生工具不可用不会直接使 DSH 本轮失败；CLI 不存在、认证失败、网络故障和总超时仍会正常报告。
- 不提供网页登录界面。认证状态及刷新由本机 Codex 管理；缺少登录时运行 `codex login`。

## 验证

```sh
npm install --no-save --no-package-lock
npm test
npm run test:codex
npm run test:e2e
npm run test:client
```

`npm test` 覆盖 DSH 工具批次、结果重放、取消、隔离、错误及 JSON-RPC 流。测试也可通过仓库现有的 hooks 使用旁边已构建的 `deepseek-harness` checkout。

`test:codex` 使用真实 CLI 和临时配置验证协议，不需要登录，也不调用付费模型。`test:e2e` 使用真实 CLI 和本机 Responses SSE fixture 验证原生 `exec` 的执行/拦截、继续生成及 DSH 工具结果重放，需要允许监听 `127.0.0.1`；它验证 provider 边界，不启动完整 DSH UI。可通过 `CODEX_BIN` 指定 CLI。

`test:client` 使用旁边 Harness checkout 已安装的 React、React DOM、Testing Library 和 jsdom，检查高级设置折叠、默认值、启用、保存和失败提示。也可用 `DSH_CLIENT_TEST_PACKAGE` 指定能解析这些依赖的 `package.json` 路径，或在当前包安装这些测试依赖。

参考：[Codex app-server](https://learn.chatgpt.com/docs/app-server)。
