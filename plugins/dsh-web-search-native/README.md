# @pcmid/dsh-web-search-native

为 DSH 内置的 `web_search` 工具提供搜索后端，使用模型接口自带的搜索能力。它另外在“插件 → 网页搜索与获取”页面下方加一节“搜索渠道”。

## 搜索渠道

“接口原生搜索”下面是一个渠道下拉：

| 选择 | 行为 |
|---|---|
| 跟随会话（默认） | 用发起搜索的会话自己的供应商、模型和思考能力，不展开任何额外设置 |
| 某个渠道 | **所有**网页搜索都用这个渠道的这个模型和思考等级，不看会话用的是哪个供应商 |

选“跟随会话”时不展开下面的模型和思考等级；选渠道后才展开，并且只显示这一个渠道的设置，不是把所有渠道列出来。

- **模型**：这个渠道可选的模型。
- **思考等级**：选定模型后出现，选项来自该模型自己的能力；不选则用该渠道的默认值。
- **接口**：只有 OpenAI 协议（`openai-responses`）的渠道显示。`自动` 先用 `alpha/search`，失败时回退 `Responses`；手动选 `Alpha Search` 或 `Responses` 后不再回退。
- **不支持的供应商**：协议不是 `anthropic-messages` 或 `openai-responses` 的供应商不出现在渠道列表里。

地址、密钥、请求头都取自所选供应商在“模型”设置里的路由（`baseURL`、`apiKeyEnv`、`headers`），本插件不单独配置。

固定渠道时有一个后果需要注意：**即使当前会话用的是别的供应商，搜索请求也会发到固定渠道。** 例如会话在 ccmax，渠道固定在 pool，那么搜索计费落在 pool，且搜索内容会发往 pool。

两种协议随渠道走：

- **Anthropic Messages：** 每个查询发起一次 Messages 请求，携带接口原生的 `web_search` 服务端工具（`web_search_20250305`），由接口完成搜索。接口接受了工具却没有执行搜索时会明确报错，不会返回空结果。
- **OpenAI Responses：** 默认先调 `alpha/search`（携带 `commands.search_query`），返回有效结果就直接使用；接口不支持或请求失败时回退到 Responses（携带 `web_search` 服务端工具和 `include: web_search_call.action.sources`）。一次失败会在内存里记住 10 分钟，这期间直接走 Responses。取消搜索不会触发回退，也不会被记成失败。

`alpha/search` 的 `encrypted_output` 是不透明数据，始终忽略。返回给模型的答案会把接口私有的引用标记换成指向来源的链接。

## 结果

- 来源列表取自接口返回的结构化结果（标题、URL、摘要）；Anthropic Messages 上被引用的结果排在前面，引用片段作为来源摘要。
- 可选答案正文由 `answer` 控制，默认开启。
- Anthropic Messages 遇到 `pause_turn` 时自动续跑，最多续 3 次。

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `providerId` | `native-search` | 提供方 id；在官方页面的“网页搜索提供方”里它会以“接口原生搜索”出现 |
| `followSession` | `true` | 搜索渠道是否跟随会话 |
| `searchProvider` | 空 | 固定渠道的供应商，`followSession` 为 `false` 时有效 |
| `searchModel` | 空 | 固定渠道的模型 |
| `searchReasoningEffort` | 空 | 固定渠道的思考等级，空表示用该渠道的默认值 |
| `searchTransport` | `auto` | OpenAI 接口：`auto` / `alpha-search` / `responses` |
| `toolType` | `web_search_20250305` | Anthropic Messages 的服务端工具类型 |
| `maxUses` | `3` | 单个查询内模型最多执行的原生搜索次数 |
| `maxTokens` | `4096` | 每次请求的 `max_tokens`，thinking 输出也计入 |
| `thinkingEffort` | `low` | 搜索模型没有指定等级时使用 |
| `answer` | `true` | 是否让模型附带简短的引用式回答 |
| `allowedDomains` / `blockedDomains` | `[]` | 透传为 `allowed_domains` / `blocked_domains`，两者只能设置一个；Responses 接口没有对应参数 |
| `anthropicVersion` | `2023-06-01` | `anthropic-version` 请求头 |

## 费用

每个查询都是一次按所选模型计费的请求：包括接口的搜索次数费用，以及作为输入 token 计费的搜索结果（在 `claude-haiku-5-5` 上实测约 1.4 万输入 token）。`web_search` 一次调用最多可并发 10 个查询；自动回退也可能产生额外费用。只发送查询和搜索提示，不复制整段会话。

## 排查

接口报错时，错误信息会写明实际请求的模型和主机，例如 `HTTP 400 from pw.prismai.work for model gpt-6-luna: ...`。

每次搜索还会通过 `ctx.logger` 输出一行 `native web search on <供应商>/<模型> via <协议>`，并注明是跟随会话还是固定渠道。桌面版进程的 stdout 和 stderr 指向 `/dev/null`，所以在桌面版里看不到这一行；要核对成功请求用的模型，请看网关的用量记录。

## 已知限制

- **不改官方页面。** 官方的“网页搜索与获取”页仍然由 DSH 提供：标题、图标、搜索提供方和网页获取提供方都属于它。本插件只在它的内容下方加一节“搜索渠道”（`plugins.detail.section`），并且只在这一页显示。这一节没有保存按钮：选“跟随会话”立即生效，选了渠道后在选定模型时生效，之后改思考等级或接口也立即生效。停用本插件后那一节消失，官方页面本身不受影响。
- **搜索渠道不在“网页搜索提供方”紧下方。** 官方页面内部没有给插件留插入位置，插件能加内容的地方只有整页内容下方。替换整页可以放回原位，但当前 DSH 的插件列表会把被替换的官方条目也列出来（它用 `slots.entries` 而不是 `entriesOfSlot`），列表里就会出现两张“网页搜索与获取”。
- **自动探测只在内存里。** 重启后 `自动` 会重新先试 `alpha/search`。
- **文案只有中文和英文**，其他语言显示英文。
