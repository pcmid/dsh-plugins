# 授权（OAuth）与重试策略

本文是 `@pcmid/dsh-mcp-skills` 0.2.0 的补充约定，Host 与 Client 都以它为准。基础接口见 [host-api.md](host-api.md)。

## 1. 重试策略

用户要求：**第一次连接失败不自动重试，靠手动重试；连接成功过之后再断开，才自动重连。**

DSH 的 mcp-client 本身不区分这两种失败（启动失败也会按 `reconnect` 退避重试 10 次），mcp-manager 又固定 `failOnStartupError: false`。所以本插件这样做：

- **Client 写入的每个服务器条目都带 `reconnect: { enabled: false }`。** 添加、批量导入、编辑保存都写；编辑内置配置的服务器时作为覆盖写入。切换启用开关不写。之后 DSH 不再自己重试：启动失败直接变成 `failed / reconnect-disabled`；连上后断开也变成 `failed / reconnect-disabled`。
- **Host 半边的重连监督器（supervisor）补上「连上后断开再重连」。**
  - 监听 `ctx.on('mcp-manager/status', (name, status) => …)`。
  - 每个服务器有 `armed` 标记：收到 `connected` 时置为 true，attempts 清零。
  - 收到 `{ state: 'failed', reason: 'reconnect-disabled' }` 时：
    - `armed` 为 true 且错误不是授权失败 → 安排自动重连：`ctx.mcpManager.restart(name)`，延迟 1s、2s、4s … 上限 30s，最多 `reconnectMaxAttempts`（默认 10）次。期间如果再次收到 `failed / reconnect-disabled`，attempts+1，继续安排；用完次数 → `gaveUp`，`armed=false`。
    - `armed` 为 false → 什么都不做（首次失败，等用户手动重试）。
  - 授权失败（`lastError` 匹配 `/\b401\b|requires authorization|unauthori[sz]ed|invalid_token/i`）不自动重连：有 OAuth 授权记录且有 refresh token → 先刷新令牌（刷新成功写入凭据后 mcp-client 会自己重连，见 §2.5）；否则标记授权失效。
  - 收到 `disabled` 或服务器从 `mcpManager.list()` 消失 → 清空该服务器的监督状态、取消计时器。
  - 只处理 `failed / reconnect-disabled`，所以不带 `reconnect.enabled: false` 的服务器（手写配置、DSH 默认）保持 DSH 原有行为，Client 照旧显示 DSH 的「重试中」。
  - 插件 Config（非 volatile，只能在 `cordis.patch.yml` 改）：`reconnectAfterConnected: boolean = true`（false 时监督器不做自动重连）、`reconnectMaxAttempts: number = 10`。
- **手动重试统一走 Host 路由 `mcp-settings/retry`**（不要再用 `ctx.remote.mcpManager.restart`）：取消待执行的自动重连，`armed=false`，attempts 清零，清除 `gaveUp`，然后 `restart(name)`。手动重试成功 → 收到 `connected` → 重新 armed；失败 → 停在失败，不自动重试。

## 2. 授权

DSH 的 mcp-manager 没有 OAuth（`needs-auth` 状态位保留、未实现）。本插件在 Host 半边实现 MCP 授权规范（OAuth 2.1 授权码 + PKCE，RFC 9728 / 8414 / 7591 / 8707），只针对 `streamable-http` 服务器。

### 2.1 判断是否需要授权：`mcp-settings/auth-check`

payload `{ url: string }` → value
```ts
| { kind: 'none' }                                   // 不带凭据就能访问
| { kind: 'oauth', issuer: string, scopes?: string[], registration: boolean }  // 需要 OAuth 授权
| { kind: 'token', status: 401 }                     // 要凭据，但找不到 OAuth 元数据：只能在请求头里填令牌
| { kind: 'forbidden', status: 403 }
| { kind: 'unreachable', error: string }
```
- 做法：对 `url` 发 `POST`，`Content-Type: application/json`、`Accept: application/json, text/event-stream`、`MCP-Protocol-Version: 2025-06-18`，body 为 JSON-RPC `initialize`（clientInfo `dsh-mcp-skills`）。超时 10 秒。拿到 2xx 后如果响应头带 `Mcp-Session-Id`，补发一个 `DELETE` 结束会话（忽略失败）。
- 401：解析 `WWW-Authenticate: Bearer` 参数（`resource_metadata`、`scope`、`error`），按 §2.2 发现元数据；发现成功 → `oauth`，失败 → `token`。
- 只允许 `http:`/`https:`；`http:` 只允许回环地址（`localhost`、`127.0.0.0/8`、`::1`），否则 `bad-request`（OAuth 规范要求 HTTPS）。
- 结果按 url 缓存 60 秒。

### 2.2 元数据发现
1. 受保护资源元数据（RFC 9728）：优先用 `resource_metadata`；否则依次试 `<origin>/.well-known/oauth-protected-resource<path>`、`<origin>/.well-known/oauth-protected-resource`。取 `authorization_servers[0]` 作为 issuer，`scopes_supported` 作为候选 scope，`resource`（缺省为规范化后的服务器 URL：去掉 fragment，保留 path）。
2. 授权服务器元数据：issuer 有路径时依次试 `<origin>/.well-known/oauth-authorization-server<path>`、`<origin>/.well-known/openid-configuration<path>`、`<issuer>/.well-known/openid-configuration`；没有路径时试 `<origin>/.well-known/oauth-authorization-server`、`<origin>/.well-known/openid-configuration`。需要 `authorization_endpoint`、`token_endpoint`；`code_challenge_methods_supported` 存在且不含 `S256` 时报错。
3. 兼容旧规范（2025-03-26）：找不到受保护资源元数据时，把 MCP 服务器的 origin 当 issuer 再试第 2 步；仍失败 → 不是 OAuth（`token`）。
- 每次请求超时 10 秒，响应体上限 1 MiB，只跟随同 scheme 的重定向，最多 3 次。

### 2.3 发起授权：`mcp-settings/auth-start`
payload `{ server: string, url: string, clientId?: string, clientSecret?: string }` → value
```ts
{ flowId: string, authUrl: string, redirectUri: string, ref: string, header: 'Authorization', template: string }
```
- `ref` = `MCP_<NAME>_OAUTH`，NAME 为服务器名转大写、非 `[A-Z0-9]` 换成 `_`（与 Client 的 `mcpRefPart` 相同）。`template` = `Bearer ${credential:<ref>}`。Client 负责保证条目的 `headers.Authorization` 等于 `template`。
- 回调地址：Host 在本机起一个临时 HTTP 监听，同时绑 `127.0.0.1` 和 `::1`（`::1` 失败忽略），端口优先用该服务器授权记录里上次的端口，占用时改用随机端口。`redirectUri` = `http://localhost:<port>/callback`。不监听其他网卡。
- 客户端注册：授权记录里有同一 issuer、同一 `redirectUri` 的客户端就复用；否则用 payload 里的 `clientId`/`clientSecret`；否则走动态注册（RFC 7591）：`POST registration_endpoint`，`{ client_name: 'DeepSeek Harness', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }`。没有 `registration_endpoint` 且没给 `clientId` → 错误码 `oauth-client-required`（Client 让用户填 Client ID）。
- PKCE S256；`state` 32 字节随机；授权 URL 带 `response_type=code`、`client_id`、`redirect_uri`、`code_challenge`、`code_challenge_method=S256`、`state`、`resource`，以及 `scope`（取 401 里的 `scope`，否则 `scopes_supported` 用空格连接；都没有就不带）。
- 同一服务器同时只有一个进行中的流程：再次 start 会取消旧的。流程 10 分钟过期；过期、完成或取消后关闭监听。
- 回调 `GET /callback?code&state`（或 `?error&error_description`）：校验 state，用授权码换令牌（`grant_type=authorization_code`、`code`、`redirect_uri`、`client_id`、`code_verifier`、`resource`；有 client_secret 时按注册结果的 `token_endpoint_auth_method` 用 `client_secret_basic` 或 `client_secret_post`），然后返回一个中英双语的简单页面：成功「授权完成，可以关闭此页面回到 DSH。」，失败写明原因。页面不含令牌。

### 2.4 手动完成与取消
- `mcp-settings/auth-complete`：payload `{ flowId, callbackUrl }`。浏览器跳不回来时（例如在另一台设备上打开授权页），用户把地址栏里的回调 URL 粘贴进来，Host 解析 `code`/`state` 后按回调同样处理。value `{ ok: true }`。
- `mcp-settings/auth-cancel`：payload `{ flowId }` → `{ ok: true }`。
- `mcp-settings/auth-forget`：payload `{ server }` → `{ ok: true }`。有 `revocation_endpoint` 就尽力撤销 refresh token（失败忽略），删除授权记录，`unset` 掉 `ref`。删除服务器时 Client 也要调用它。

### 2.5 存储与续期
- 授权记录：`ctx.credentials.modifyRecord('mcp-skills/oauth-<enc>', …)`，`kind: 'grant'`。DSH 的凭据键必须正好是 `<scope>/<id>` 两段、每段 `^[a-z][a-z0-9-]*$`（否则凭据文件下次启动时无法读取），所以服务器名编码成 `<enc>`：`[a-z0-9]` 原样，`-` 写成 `--`，`_` 写成 `-0`，大写字母写成 `-` 加小写（例如 `my-server` → `mcp-skills/oauth-my--server`，`GitHub_2` → `mcp-skills/oauth--git-hub-02`）。Client 不需要知道这个键。payload：
  ```ts
  { version: 1, server, serverUrl, resource, issuer,
    endpoints: { authorization, token, registration?, revocation? },
    client: { clientId, clientSecret?, authMethod, redirectUri, port },
    tokens: { refreshToken?, expiresAt?: number, scope?: string },
    updatedAt: number }
  ```
- 访问令牌只写进凭据引用：`ctx.credentials.set(ref, access_token)`。mcp-client 监听 `credentials/reference-updated`，引用一变就用新值重连（包括停在 `failed` 或 `waiting-credentials` 的服务器）。
- 续期：Host 启动时读出所有 `mcp-skills/oauth-*` 记录，在 `expiresAt - 120s`（至少 5 秒后）用 refresh token 换新令牌，记录在 `modifyRecord` 里读-改-写（refresh token 轮换时一起更新），成功后 `set(ref)`。网络错误每分钟重试，直到过期；`invalid_grant` 等明确拒绝 → 授权状态 `expired`，到 `expiresAt` 时 `unset(ref)`，服务器随之进入 `waiting-credentials`。
- 没有 `expires_in` 的令牌不安排续期。

### 2.6 状态
授权状态并入 §3 的 `mcp-settings/state`：
```ts
auth?: {
  state: 'authorized' | 'expired' | 'error'
  issuer: string            // 显示用：授权服务器的 host
  expiresAt?: number
  canRefresh: boolean
  error?: string
}
flow?: {
  flowId: string
  status: 'pending' | 'exchanging' | 'done' | 'error' | 'cancelled'
  authUrl: string
  redirectUri: string
  startedAt: number
  error?: string
}
```
`done`/`error`/`cancelled` 的 flow 保留 2 分钟，供 Client 显示结果。

## 3. 状态推送：`mcp-settings/state`

payload `{ since?: number }` → value `{ version: number, servers: Record<string, ServerState> }`
- `version` 单调递增；监督状态、授权状态、流程状态任一变化时加一。
- `since` 等于当前 `version` 时请求挂起，直到有变化或 20 秒超时（超时返回同一个 version）。Client 在 MCP 页打开期间循环调用（失败后 2 秒重连），页面卸载时停止。
- `ServerState`：
  ```ts
  { armed: boolean
    retry?: { attempt: number, max: number, nextAt: number, lastError?: string }   // 已安排自动重连
    gaveUp?: { attempts: number, lastError?: string, at: number }
    authFailure?: { lastError: string, at: number }   // 最近一次失败像授权失败
    auth?: …; flow?: … }                               // 见 §2.6
  ```
  没有任何状态的服务器不出现在 `servers` 里。

## 4. 手动重试：`mcp-settings/retry`
payload `{ server }` → `{ ok: true }`。语义见 §1。缺少 `mcpManager` 服务时 `unavailable`。

## 5. Client 交互

- **状态文案**（覆盖原映射；DSH 默认的 `reconnecting` 保持原样）：
  | 条件 | 卡片状态 | 详情 |
  |---|---|---|
  | `failed / reconnect-disabled` 且有 `retry` | 「重新连接中（n/m）」warn | 提示卡：「连接断开，x 秒后自动重连」+ 原始错误 +「立即重试」 |
  | 同上且有 `gaveUp` | 「重连失败」error | 「已自动重连 n 次仍失败」+ 错误 +「重试」 |
  | 同上，错误像授权失败 | 「需要授权」warn | 见下 |
  | 同上，其他 | 「连接失败」error | 「连接失败，不会自动重试。检查配置后点「重试」。」+ 错误 +「重试」 |
  | `waiting-credentials` 且 `Authorization` 用的是本服务器的 `_OAUTH` 引用 | 「需要授权」warn | 见下 |
- **需要授权**：
  - 卡片第三行显示「需要授权」，右侧多一个小按钮「授权」（点它不进入详情）。
  - 详情状态区是警告提示卡：「这个服务器需要登录授权，授权后自动连接。」+ 主按钮「授权」。
  - 如果只是 401 而 `mcp-settings/auth-check` 结果是 `token`：提示「服务器拒绝了请求（401），但没有提供 OAuth 授权。请在请求头里填写访问令牌，例如 Authorization: Bearer …」，不显示「授权」。Client 对这类服务器调用一次 `mcp-settings/auth-check` 并缓存结果。
- **点「授权」**：
  1. 调 `mcp-auth-start { server, url }`。
  2. 条目的 `headers.Authorization` 不等于返回的 `template` 时，先写入（`set ['servers', name, 'headers', 'Authorization']`，同时写 `reconnect.enabled: false`）。
  3. `window.open(authUrl, '_blank', 'noopener')`。DSH 桌面版会用系统浏览器打开；网页版被拦截时，靠下面的链接兜底。
  4. 显示授权面板（详情页状态区；卡片上显示「等待授权…」）：
     - 文案「已在浏览器打开 <issuer> 的授权页，完成后会自动连接。」
     - 链接「重新打开授权页」（`<a href target=_blank rel=noopener>`）、「取消」。
     - 折叠项「浏览器没有跳回来？」：输入框 +「完成授权」，调 `mcp-settings/auth-complete`。
  5. flow 变为 `exchanging` →「正在获取令牌…」；`done` →「授权成功，正在连接…」（之后由 manager 状态接管）；`error` → 错误文案 +「重新授权」；`oauth-client-required` → 展开 Client ID / Client Secret（可选）输入框，再点「授权」时带上。
- **已授权的服务器**：详情页「配置」上方加「授权」小节：「已授权 · <issuer> · 令牌 x 分钟后过期，会自动续期」（没有 refresh token 时写「过期后需要重新授权」）；按钮「重新授权」「退出授权」（调 `mcp-settings/auth-forget`，保留请求头，服务器回到「需要授权」）。授权失效（`expired`）时整块变成 warn：「授权已失效，请重新授权」。
- **请求头编辑器**：值等于本服务器 `_OAUTH` 模板的 `Authorization` 行显示为只读行：键 `Authorization`、值「由 OAuth 授权管理」，没有删除和密钥按钮。
- **添加表单**：远程 URL 变化时（防抖 600ms）调 `mcp-settings/auth-check`，URL 下方显示：
  - `oauth` →「需要登录授权（<issuer>），添加后会打开授权页。」info；主按钮变成「添加并授权」，保存时直接写入 `Authorization` 模板头，保存成功后立即走「点授权」流程。
  - `token` →「服务器要求访问令牌（401）：请在请求头里填写。」warn。
  - `forbidden` →「服务器拒绝访问（403）。」warn。
  - `unreachable` →「暂时连不上：<error>。仍可添加。」muted。
  - `none` 不显示。检查中显示小转圈「正在检查是否需要授权…」。
- **重试按钮**全部改调 `mcp-settings/retry`。
- **删除服务器**时额外调用 `mcp-settings/auth-forget`（失败忽略）。
