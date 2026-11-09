# @local/dsh-web-search-native

为 DSH 内置的 `web_search` 工具提供搜索后端，使用模型接口自带的搜索能力，在设置页显示为“接口原生搜索”。

目前支持 Anthropic Messages 接口：每个查询发起一次 Messages 请求，携带接口原生的 `web_search` 服务端工具（`web_search_20250305`），由接口完成搜索。

- 请求优先使用**小模型**（`@local/dsh-model-defaults` 提供的 `smallModel` 服务，在模型设置页选择）。没装那个插件、没设置小模型，或小模型当前不可用时，使用发起搜索的对话**当前选中的模型**，子代理用它自己的模型。
- 地址、密钥和请求头都取自所选模型的路由（`llm-pi-ai` 配置里的 `baseURL`、`apiKeyEnv`、`headers`），本插件不单独配置。
- 当前对话的推理强度不会带到搜索请求里；只有小模型上明确选择的强度才生效，否则使用 `thinkingEffort`。
- `web_search_tool_result` 中的结果成为来源列表（标题、URL、`page_age` 作为日期）。
- 模型回答中的引用（`web_search_result_location`）决定来源排序，被引用的片段作为来源摘要。
- 模型在搜索之后写的简短回答作为可选的答案正文（可用 `answer: false` 关闭）。
- 遇到 `pause_turn` 时自动续跑，最多续 3 次。

## 哪些路由能搜索

路由必须在配置里同时声明 `api: anthropic-messages`、`baseURL` 和 `apiKeyEnv`，且密钥能解析。这一判断按模型步骤进行：

- 小模型或当前步骤的路由满足时，`web_search` 出现在模型的工具列表里。
- 小模型不可用，且当前路由也不满足时（OpenAI 兼容路由、DeepSeek 官方路由、未显式声明这些字段的目录路由、只靠 OAuth 登录的路由、密钥缺失），该步骤不提供 `web_search`。

小模型“不可用”指：它的路由不满足上述条件、路由的模型列表里已没有它，或密钥解析不到。这些情况都会退回当前模型，不会报错。

路由支持原生搜索但选中的模型不支持时，工具仍然可见，调用会返回接口的报错，其中写明模型名。

既没有可用的小模型，也不是由对话发起的搜索（例如其他插件直接调用 `ctx.web.search()`），会直接报错。

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `providerId` | `native-search` | 提供方 id；注册了多个搜索提供方时，在设置页选中它，或把 `web.searchProvider` 设为它 |
| `toolType` | `web_search_20250305` | 服务端工具类型 |
| `maxUses` | `3` | 单个查询内模型最多执行的原生搜索次数 |
| `maxTokens` | `4096` | 每次请求的 `max_tokens`，thinking 输出也计入 |
| `thinkingEffort` | `low` | 路由把模型标记为 `compat.forceAdaptiveThinking` 时，发送 `thinking: { type: adaptive }` 和这个 `output_config.effort`（小模型明确选了强度时用小模型的）；其他模型发送 `thinking: { type: disabled }` |
| `answer` | `true` | 是否让模型附带简短的引用式回答 |
| `allowedDomains` / `blockedDomains` | `[]` | 透传为 `allowed_domains` / `blocked_domains`，两者只能设置一个 |
| `anthropicVersion` | `2023-06-01` | `anthropic-version` 请求头 |

## 费用

每个查询都是一次按所选模型计费的请求：包括接口的搜索次数费用，以及作为输入 token 计费的搜索结果（在 `claude-haiku-5-5` 上实测约 1.4 万输入 token）。`web_search` 一次调用最多可并发 10 个查询。

## 排查

接口报错时，错误信息会写明实际请求的模型，例如 `HTTP 400 from api.prismai.work for model claude-opus-5-5: ...`。

每次搜索还会通过 `ctx.logger` 输出一行 `native web search on <路由>/<模型>`。桌面版进程的 stdout 和 stderr 指向 `/dev/null`，所以在桌面版里看不到这一行；要核对成功请求用的模型，请看网关的用量记录。
