# Codex Provider

通过本机 `codex app-server` 为 DSH 提供模型调用。包名 `@pcmid/dsh-codex-provider`，插件 ID 和 Provider ID 均为 `codex-provider`。

登录由 Codex CLI 管理，复用它的 ChatGPT 登录或 API 配置。插件不读取、复制或保存 OAuth token。工具仍全部由 DSH 执行，权限、并行度、日志和插件钩子照常生效。

## 安装与选择模型

需要 DSH `0.2.2-rc.1` 和 Codex CLI。已在 Codex `0.166.0-alpha.6`（ChatGPT 桌面版自带的 CLI：`/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`）上验证。插件依赖 app-server 的实验性接口，升级 Codex 后应重新运行端到端测试。

```sh
codex login
dsh plugin --profile desktop add link:/absolute/path/to/plugins/dsh-codex-provider
```

安装插件不会启动 Codex。在 **设置 → 模型 → 添加模型提供商** 选择 **Codex Provider**，点击 **保存** 后启用，再在模型选择器选择它的模型。模型列表来自 app-server 的 `model/list`；也可在插件配置里用 `models` 固定列表。其他供应商的请求不会经过 Codex。

添加或 **编辑** 时只有一项 **codex 路径**（配置键 `codexPath`，可用 `~` 表示家目录）：插件用这个 Codex 可执行文件运行 `app-server --stdio`。留空时从 `PATH` 查找 `codex`；桌面应用找不到时填写完整路径，例如 ChatGPT 自带的 `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`。插件需要自己启动 app-server，才能用启动参数关掉 Codex 本会注入请求的内容，因此不支持连接已经在运行的 app-server。

插件配置示例（对应 profile 的 `cordis.patch.yml`）：

```yaml
- id: codex-provider
  config:
    providers:
      codex-provider:
        # codexPath: ~/.local/bin/codex
    # codexHome: /absolute/path/to/.codex
    # models: [gpt-5.6-sol]
    # contextWindow: 272000
    timeoutMs: 600000
    idleTimeoutMs: 1800000
```

省略 `providers.codex-provider` 时供应商保持未启用。`codexHome` 未设置时沿用进程环境及 Codex 默认目录；需要登录时在同一目录执行 `CODEX_HOME=/absolute/path codex login`。

`contextWindow` 未设置时，模型窗口按以下顺序取值：Codex 在请求后报告的窗口；[models.dev](https://models.dev/api.json) 中 `openai` 供应商对应模型的 `limit.context`；都没有时按 128000 计算。models.dev 的数据缓存在 `<DSH_HOME>/codex-provider/models-dev.json`，超过一天后在下一次查询模型信息时后台更新；没有缓存时等待第一次拉取，最多 15 秒。拉取失败只记录警告，一小时后再试。models.dev 记录的是 OpenAI API 的上限（如 gpt-6-sol 为 1050000），通常大于 ChatGPT 登录的 Codex 实际允许的窗口（如 272000 的 95%），因此 Codex 报告的值优先；第一次请求超出实际窗口时，Codex 返回上下文超限错误，由 DSH 压缩后重试。

## DSH 如何调度

1. 第一次使用时启动一个常驻的 `codex app-server` 进程，`idleTimeoutMs` 内没有请求后关闭。
2. 每个 DSH 会话对应一个 ephemeral Codex 线程。DSH 系统提示词作为线程的 base instructions，DSH 工具按原名作为 `dynamicTools` 传入。Codex 不接受的名字（如 `exec`、`exec_command`、`mcp__*`）会改写：`mcp__a__b` 变为 `mcp_a__b`，其余加稳定的哈希后缀。
3. 模型调用 DSH 工具时，插件把这批调用作为本次 DSH 步骤的结果交回 Harness，Codex 的这一轮停在未答复的 `item/tool/call` 请求上。DSH 照常执行工具；下一次 DSH 请求用真实结果答复这些请求，同一轮继续生成。上一轮结束后的新用户消息追加到同一线程。因此模型跨步骤保留历史、加密推理和 prompt cache 身份，不需要重放。
4. 当前 Codex 模型使用 code mode：模型在 `exec` 脚本里调用 DSH 工具。同一脚本同时发起的调用（`Promise.all`）作为一批交给 DSH，结果返回后脚本继续执行。
5. 每一步把 Codex 的原始输出项（包括加密推理、脚本及其输出）记录在 assistant 消息的私有重放元数据里。请求不能严格接上线程时（上下文压缩、历史被编辑或重试、工具列表/系统提示词/模型/推理强度变化、进程重启、空闲线程被释放），插件新建线程，用 DSH 历史和这些记录重建。其他供应商的消息按文本和工具调用块重建。

辅助请求（标题、摘要等带 `purpose` 的请求）使用单独的临时线程，结束后立即释放。取消、单步超时、消费方提前结束或出错时，中断这一轮并丢弃线程，下一次请求重建。

## 不让 Codex 加进请求的内容

app-server 进程用配置覆盖关闭了 Codex 本会注入模型请求的内容：Codex 的权限、apps、协作模式和 skills 说明，环境上下文，AGENTS.md；原生 shell、`view_image`、sleep、多代理、goals、浏览器、computer use、图像生成和 `request_user_input` 工具；网页搜索；apps、插件、hooks 和 memories；以及用户 Codex 配置里的全部 MCP 服务器。Codex 的状态和日志写入临时目录，只有认证来自 `CODEX_HOME`。审批和交互输入请求回绝给 Codex。上下文压缩由 DSH 负责，Codex 的自动压缩关闭。

模型看到的是：DSH 系统提示词、DSH 历史、DSH 工具，以及 code mode 模型调用 DSH 工具所需的 Codex `exec`/`wait` 工具及其说明。

## 当前边界

- 这是实验性 provider。`dynamicTools`、`experimentalRawEvents` 和 `rawResponseItem/completed` 是 app-server 的实验性或内部接口，可能随 Codex 版本变化。协议对不上时插件报错，不做猜测。
- 当前只声明文本输入。图片和文件由 DSH 先转换为文本或附件提示；送到插件的其他非文本块会被拒绝。其他供应商的推理摘要不作为文本重放。
- `reasoningEffort` 会传给 Codex。app-server 没有对应的 `temperature`、`maxTokens`、`stop` 参数，这些 DSH 参数不生效。
- code mode 下，DSH 工具运行超过脚本的让出时间（约 30 秒）时，Codex 会向模型返回 `Script running`，模型可能用 `wait` 轮询。每次轮询是一次小的模型请求，其输出出现在下一个 DSH 步骤的开头。
- 部分模型仍会收到 Codex 加入的一段简短多代理模式说明，当前 Codex 版本没有关闭它的配置项。
- 重建的线程有新的 prompt cache 身份，它的第一次请求没有缓存命中。
- 不提供网页登录界面。缺少登录时运行 `codex login`。

## 验证

```sh
npm install --no-save --no-package-lock
npm test          # 用内存中的 app-server 模拟器测试适配器状态机，以及 JSON-RPC 传输
npm run test:e2e  # 真实 Codex CLI 对接本机 Responses fixture，不需要账号，不调用付费模型
npm run test:client
```

测试通过 `test/hooks.mjs` 解析 `@deepseek-ai/*`，默认使用仓库旁已构建的 `deepseek-harness` checkout，也可用 `CORDIS_ENTRY`、`SCHEMASTERY_ENTRY`、`DSH_LLM_ENTRY` 指定。`test:e2e` 需要允许监听 `127.0.0.1`，可通过 `CODEX_BIN` 指定 CLI。`test:client` 使用 Harness checkout 里的 React、Testing Library 和 jsdom，也可用 `DSH_CLIENT_TEST_PACKAGE` 指定能解析这些依赖的 `package.json`。

参考：[Codex app-server](https://learn.chatgpt.com/docs/app-server)。
