# Host API（Client ↔ Host）

Host 半边在 `index.js` 里用 `ctx.connection.fetch.register()` 注册精确路由 `POST /api/mcp-skills/<op>`（只有 owner Peer 能到达），请求体是 Connection RPC 信封 `{ type: 'client-request', rpcId, payload }`，响应 `{ type: 'server-response', rpcId, result }`，`result` 是 `{ ok: true, value }` 或 `{ ok: false, error: { code, message } }`。Client 用 `ctx.connection.rpc.call('/api', 'mcp-skills/<op>', payload)` 调用（与 `@pcmid/dsh-remote-relay` 相同）。

错误码：`bad-request`（参数不对）、`not-found`、`exists`（目标已存在）、`forbidden`（路径不在允许的根目录里或只读）、`invalid`（技能内容不合法，message 说明原因）、`git-failed`、`unavailable`（缺少所需服务）、`internal`。

路径在 value 里都是绝对路径；另外给 `displayPath`：把 home 换成 `~`。

## 类型

```ts
type RootId = 'project-dsh' | 'project-agents' | 'user-dsh' | 'user-agents'

interface SkillRoot {
  id: RootId
  scope: 'project' | 'user'
  path: string; displayPath: string
  rank: number            // 100 / 200 / 400 / 500
  exists: boolean
}

interface SkillItem {
  id: string              // 唯一：指令文件的绝对路径；内置技能没有路径时为 `builtin:<name>`
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean // !disable-model-invocation
  userInvocable: boolean  // user-invocable，默认 true
  root: RootId | null     // null = 内置 / 插件提供 / 其他来源
  scope: 'project' | 'user' | 'builtin'
  source: string          // 注册表的 source，例如 'user-agents'、'bundled'、'runtime'
  path?: string; displayPath?: string   // 指令文件
  dir?: string            // 技能目录（bundle）或文件本身（flat）
  layout: 'bundle' | 'flat' | 'builtin'
  editable: boolean       // 在可写根目录里、是根目录的直接子项
  active: boolean         // 同名里生效的那个
  shadowedBy?: { id: string; displayPath?: string; root: RootId | null }
  invalid?: string        // frontmatter 解析失败的原因；此时 name 取目录名
}
```

## 技能

### `skills-list`
payload `{ cwd?: string }`（工作区路径；不给就不列项目技能）
value `{ projectRoot?: string, roots: SkillRoot[], skills: SkillItem[], complete: boolean }`
- 扫描各根目录的直接子项：`<root>/<entry>/SKILL.md` 与 `<root>/<entry>.md`；跳过以 `.` 开头的项和 `~/.dsh/skills/.system`；目录项可以是符号链接。
- 内置技能来自 `ctx.skills.snapshot({ cwd, scope })`（scope 用 `ctx.agentPresets.acquireScope()` 得到默认预设的 scope，用完 `await using` 释放；缺少这些服务时跳过内置，并把 `complete` 设为 false）。注册表里路径不属于这四个根目录的条目算内置（`root: null`、`scope: 'builtin'`、只读）。
- `active`：有注册表结果时以注册表胜出项的路径为准（比较 realpath），否则按 rank。
- 排序：按 scope（project → user → builtin），组内按名字。

### `skills-read`
payload `{ id: string, cwd?: string }`（id 必须出现在同一 cwd 下 `skills-list` 的结果里）
value `{ item: SkillItem, body: string, files: string[], filesTotal: number }`
- `body` 是 frontmatter 之后的正文（去掉开头一个空行）。内置技能用 `ctx.skills.get(name, { cwd, scope })` 的 `content`。
- `files`：技能目录里除 SKILL.md 外的文件相对路径（深度 ≤ 4，跳过 `.git`、`node_modules`，最多 50 个），`filesTotal` 是总数（上限 1000 时停止计数）。

### `skills-save`
payload
```ts
{
  cwd?: string
  target: { create: true, root: RootId } | { create: false, id: string }
  name: string            // create 时用作目录名；编辑时必须等于原名（第一版不支持改名）
  description: string
  whenToUse?: string      // 空字符串 = 删除该键
  modelInvocable: boolean
  userInvocable: boolean
  body: string
}
```
value `{ item: SkillItem }`
- 校验：名字 `^[a-z0-9]+(-[a-z0-9]+)*$` 且 ≤ 64；description 去空白后非空；目标根目录要可写（不存在就创建）。新建时目标已存在 → `exists`。
- 写 frontmatter 时保留原文件里其他键和注释，只替换 / 插入 / 删除这五个键：`name`、`description`、`whenToUse`、`disable-model-invocation`（仅在为 true 时写入，false 时删除该键）、`user-invocable`（仅在为 false 时写入，true 时删除该键）。字符串值写成 JSON 双引号字符串（合法的 YAML）。
- 原子写：先写同目录临时文件再 rename。

### `skills-delete`
payload `{ id: string, cwd?: string }` → value `{ removed: string }`（被删除的路径）
- 只允许 `editable` 的项。bundle 删除整个目录；目录项是符号链接时只删链接；flat 删除文件。

### `skills-scan`
payload `{ source: string }` → value
```ts
{
  scanId: string
  label: string           // 'anthropics/skills' 或缩写后的本地路径
  candidates: Array<{
    key: string           // 相对扫描根的目录，'.' 表示根本身
    name: string          // frontmatter name；无效时取目录名
    description: string
    valid: boolean
    error?: string
    fileCount: number
  }>
}
```
- `source` 可以是：`https://github.com/<o>/<r>[.git][/tree/<ref>[/<subpath>]]`、`github.com/<o>/<r>...`、`<o>/<r>`、任意 `https://…/*.git` 或 `git@…` 地址、本地绝对路径或 `~/…`。
- Git：`git clone --depth 1 [--branch <ref>] <url> <tmp>`，环境 `GIT_TERMINAL_PROMPT=0`，超时 90 秒；`/tree/<ref>/<subpath>` 的 ref 取第一个路径段。临时目录在 `os.tmpdir()/dsh-mcp-skills-*`，15 分钟后或安装后或插件卸载时删除。
- 扫描深度 ≤ 5，跳过 `.git`、`node_modules`；找到 `SKILL.md` 的目录就是一个候选，不再往它的子目录找。最多 500 个候选。

### `skills-install`
payload `{ scanId: string, cwd?: string, root: RootId, items: Array<{ key: string, overwrite: boolean }> }`
value `{ installed: string[], skipped: string[], failed: Array<{ name: string, error: string }> }`
- 目标 `<root>/<name>`；已存在且 `overwrite` 为 false → skipped；为 true → 先删再复制。复制时跳过 `.git`，保留符号链接本身（不解引用到技能目录外）。

## MCP

### `mcp-tools`
payload `{ server: string }` → value `{ tools: Array<{ name: string, description: string }> }`
- 来自 `ctx.tools.schemas()`（全局视图），取名字以 `mcp__<server>__` 开头的工具；`name` 去掉这个前缀；`description` 保留全文（Client 只显示第一行）。缺少 tools 服务 → `unavailable`。
