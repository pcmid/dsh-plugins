# Host API（Client ↔ Host）

Host 半边在 `index.js` 里用 `ctx.connection.fetch.register()` 注册两组精确路由（只有 owner Peer 能到达），MCP 页和技能页各用一组，互不依赖：

- **MCP**：`POST /api/pcmid/mcp-settings/<op>`，op 为 `tools`、`state`、`retry`、`auth-check`、`auth-start`、`auth-complete`、`auth-cancel`、`auth-forget`。
- **技能**：`POST /api/pcmid/skill-settings/<op>`，op 为 `list`、`read`、`save`、`delete`、`repos-list`、`repos-add`、`repos-get`、`repos-refresh`、`repos-remove`、`repos-install`、`repos-update`。

（不能用 `/api/mcp`、`/api/skills`：DSH 自己的 Remote 已经占用了 `/api/skills/list` 这类路径。）

请求体是 Connection RPC 信封 `{ type: 'client-request', rpcId, payload }`，响应 `{ type: 'server-response', rpcId, result }`，`result` 是 `{ ok: true, value }` 或 `{ ok: false, error: { code, message, details } }`。Client 用 `ctx.connection.rpc.call('/api', 'pcmid/<组>/<op>', payload)` 调用（与 `@pcmid/dsh-remote-relay` 相同），即 `createRpc(ctx, API_MCP | API_SKILLS)`。

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
  origin?: SkillOrigin    // 0.2：从技能仓库安装、并且有安装记录的技能
}

/** 0.2：已安装技能和来源仓库的关系。 */
interface SkillOrigin {
  repoId: string
  repoLabel: string       // 'anthropics/skills'
  key: string             // 技能在仓库里的目录（相对仓库扫描根），'.' 表示根本身
  updateAvailable: boolean // 仓库缓存里的版本和安装时的版本不同
  modified: boolean       // 安装后本地文件被改过
  installedAt: number     // ms
}
```

## 技能

### `skill-settings/list`
payload `{ cwd?: string }`（工作区路径；不给就不列项目技能）
value `{ projectRoot?: string, roots: SkillRoot[], skills: SkillItem[], complete: boolean }`
- 扫描各根目录的直接子项：`<root>/<entry>/SKILL.md` 与 `<root>/<entry>.md`；跳过以 `.` 开头的项和 `~/.dsh/skills/.system`；目录项可以是符号链接。
- 内置技能来自 `ctx.skills.snapshot({ cwd, scope })`（scope 用 `ctx.agentPresets.acquireScope()` 得到默认预设的 scope，用完 `await using` 释放；缺少这些服务时跳过内置，并把 `complete` 设为 false）。注册表里路径不属于这四个根目录的条目算内置（`root: null`、`scope: 'builtin'`、只读）。
- `active`：有注册表结果时以注册表胜出项的路径为准（比较 realpath），否则按 rank。
- 排序：按 scope（project → user → builtin），组内按名字。
- 0.2：有安装记录的项带 `origin`（只读仓库缓存，不联网）。

### `skill-settings/read`
payload `{ id: string, cwd?: string }`（id 必须出现在同一 cwd 下 `list` 的结果里）
value `{ item: SkillItem, body: string, files: string[], filesTotal: number }`
- `body` 是 frontmatter 之后的正文（去掉开头一个空行）。内置技能用 `ctx.skills.get(name, { cwd, scope })` 的 `content`。
- `files`：技能目录里除 SKILL.md 外的文件相对路径（深度 ≤ 4，跳过 `.git`、`node_modules`，最多 50 个），`filesTotal` 是总数（上限 1000 时停止计数）。

### `skill-settings/save`
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

### `skill-settings/delete`
payload `{ ids: string[], cwd?: string }`（0.2：批量；仍接受旧的单个 `id`）
value `{ removed: Array<{ id: string, name: string, path: string }>, failed: Array<{ id: string, name: string, error: string }> }`
- 每个 id 都必须出现在同一 cwd 下新读取的 `list` 里，并且 `editable`；不满足的进 `failed`，不影响其他项。一次最多 200 个。
- bundle 删除整个目录；目录项是符号链接时只删链接；flat 删除文件。
- 被删技能如果有安装记录（`origin`），同时删掉这条记录。

## 技能仓库（0.2）

技能仓库是用户添加的技能来源：一个 git 仓库（可带子目录和分支）或一个本地文件夹。仓库列表、安装记录保存在 `<dshHome>/mcp-skills/state.json`（`version: 1`，原子写，权限 0600）；git 仓库的工作副本缓存在 `<dshHome>/mcp-skills/repos/<id>/`。0.1 的 `skills-scan` / `skills-install` 路由删除，导入一律通过仓库。

```ts
interface Repository {
  id: string              // 规范化来源（kind + url/path + ref + subpath）的 sha256 前 12 位，同一来源只有一个
  label: string           // 只是仓库名，不带子目录：GitHub 'owner/repo'；其他 git：仓库名；本地：缩写路径。子目录看 subpath / source
  kind: 'git' | 'local'
  source: string          // 用户输入（规范化后），用于显示
  url?: string            // git clone 地址
  webUrl?: string         // GitHub 时 'https://github.com/owner/repo[/tree/ref/subpath]'
  ref?: string            // 分支或标签；没有就是默认分支
  subpath?: string        // 只扫描这个子目录
  path?: string; displayPath?: string   // 本地文件夹
  addedAt: number
  checkedAt?: number      // 上次成功取到最新内容的时间（git: fetch；本地：扫描）
  commit?: string         // git：当前缓存的提交（完整 40 位）
  lastError?: string      // 上次检查失败的原因；成功后清空
  skillCount: number      // 有效技能数（来自缓存）
  installedCount: number  // 有安装记录、且目录还在的技能数（同一技能装在多个位置算一个）
  updateCount: number     // 其中 updateAvailable 的技能数
}

interface RepoSkill {
  key: string             // 相对扫描根的目录，'.' 表示根本身
  name: string            // frontmatter name；无效时取目录名
  description: string
  valid: boolean
  error?: string          // 无效原因（格式错误、许可证限制等）
  fileCount: number
  alsoAt?: string[]       // 仓库里同名的其他目录（常见于给不同 Agent 的副本，如 .openclaw/skills/<name>），已折叠不列出
  installs: Array<{       // 同名、已在本机（同一 cwd 下的四个根目录里）的副本
    skillId: string       // 对应 list 的 SkillItem.id
    root: RootId
    path: string; displayPath: string   // 技能目录
    tracked: boolean      // 有来自本仓库这个 key 的安装记录
    updateAvailable: boolean            // tracked 时才可能为 true
    modified: boolean                   // tracked 时才可能为 true
    active: boolean
  }>
}

interface RepoDetail { repository: Repository, skills: RepoSkill[] }
```

规则：
- **内容哈希**：一个技能目录的哈希 = 按相对路径排序后，逐个文件 `相对路径 \0 内容`（符号链接用 `相对路径 \0 -> 目标`）的 sha256；跳过 `.git`；最多 1000 个文件、深度 8，超过时把截断标记也算进哈希。
- **安装记录**：`{ path（安装后的技能目录，绝对路径）, repoId, key, name, sourceHash（安装时仓库里该目录的哈希）, installedHash（安装后本地目录的哈希）, commit?, installedAt, updatedAt? }`。
- `updateAvailable` = 仓库缓存里该 key 目录的当前哈希 ≠ `sourceHash`。`modified` = 本地目录当前哈希 ≠ `installedHash`。
- **认领**：读取仓库详情时，如果某个同名副本没有任何安装记录、但内容哈希和仓库里的完全相同，就为它补一条记录（视为从这个仓库装的）。内容不同、或已经记录为别的仓库的，`tracked: false`。
- 安装记录对应的目录不存在了，读取时顺手删掉这条记录。
- **同名折叠**：同一个名字只列一个候选，按「有效 → 不在隐藏目录（以 `.` 开头）里 → 层级浅 → 目录名排序」挑选，其余目录放进 `alsoAt`。被折叠的目录仍能按 key 安装和更新（已有安装记录不受影响），`skillCount` 按折叠后计数。
- 已知许可证限制：`anthropics/skills` 里的 `docx`、`pdf`、`pptx`、`xlsx` 四个技能标为 `valid: false`，`error` 写 'Licensed for use within Anthropic products only; not installable'。
- 状态文件的写入和所有安装、更新、删除一起走同一个串行队列。

### `skill-settings/repos-list`
payload `{ cwd?: string }` → value `{ repositories: Repository[] }`（按添加时间排序；计数只读缓存，不联网）

### `skill-settings/repos-add`
payload `{ source: string, subpath?: string }` → value `RepoDetail & { existing: boolean }`
- `source` 接受的格式同旧 `skills-scan`：`https://github.com/<o>/<r>[.git][/tree/<ref>[/<subpath>]]`、`github.com/...`、`<o>/<r>`、其他 `https://…/*.git`、`git@…`、`ssh://`、`file://`、本地绝对路径或 `~/…`。`subpath` 参数和 URL 里的子目录二选一，都有时用参数。
- 已有同一来源 → 不联网，直接返回它，`existing: true`。
- git：`git clone --depth 1 [--branch <ref>] -- <url> <cache>`（`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`，超时 90 秒）。本地：检查文件夹存在。
- 扫描（深度 ≤ 5，跳过 `.git`、`node_modules`，找到 `SKILL.md` 就是一个候选，最多 500 个）后一个有效技能都没有 → `invalid`（'No SKILL.md found under …'），不保存，删掉缓存。克隆失败 → `git-failed`，不保存。
- 成功：保存，`checkedAt` = 现在。

### `skill-settings/repos-get`
payload `{ id: string, cwd?: string }` → value `RepoDetail`
- 只读缓存，不联网（缓存目录丢了就当作需要检查：返回 `skills: []`，`repository.lastError` 写 'Not downloaded yet; check for updates'）。

### `skill-settings/repos-refresh`
payload `{ id: string, cwd?: string }` → value `RepoDetail`
- git：缓存在就 `git fetch --depth 1 origin <ref 或 HEAD>` + `git reset --hard FETCH_HEAD` + `git clean -ffdx`；缓存不在就重新克隆。本地：重新扫描。
- 成功：更新 `checkedAt`、`commit`，清空 `lastError`。失败：写 `lastError`，返回 `git-failed`，缓存保持原样。

### `skill-settings/repos-remove`
payload `{ id: string }` → value `{ removed: string, forgotten: number }`
- 删除缓存目录、仓库条目，以及它的全部安装记录（数量是 `forgotten`）。已经装好的技能保留。

### `skill-settings/repos-install`
payload `{ id: string, cwd?: string, root: RootId, items: Array<{ key: string, overwrite: boolean }> }`
value `{ installed: Array<{ name, path }>, skipped: Array<{ name, reason: 'exists' | 'identical' }>, failed: Array<{ name, error }> }`
- 从缓存复制到 `<root>/<name>`，复制方式同 0.1（暂存后替换、跳过 `.git`、保留符号链接本身）。
- 目标已存在：内容和仓库完全相同 → 不复制，补安装记录，记为 `skipped: identical`；不同且 `overwrite: false` → `skipped: exists`；`overwrite: true` → 替换。
- 每个成功安装（以及 identical）写一条安装记录。最多 500 项。

### `skill-settings/repos-update`
payload `{ id: string, cwd?: string, items: Array<{ path: string, force: boolean }> }`
value `{ updated: Array<{ name, path }>, skipped: Array<{ name, path, reason: 'modified' | 'current' }>, failed: Array<{ name, path, error }> }`
- `path` 必须是本仓库的一条安装记录，而且仍是某个技能根目录（用户根，或给定 cwd 的项目根）的直接子项，否则进 `failed`（'forbidden'）。
- 已经是最新（哈希相同）→ `skipped: current`。本地改过且 `force: false` → `skipped: modified`。否则用缓存内容替换整个目录，更新记录的哈希、`commit`、`updatedAt`。
- 不联网：先 `repos-refresh` 再更新。

## MCP

### `mcp-settings/tools`
payload `{ server: string }` → value `{ tools: Array<{ name: string, description: string }> }`
- 来自 `ctx.tools.schemas()`（全局视图），取名字以 `mcp__<server>__` 开头的工具；`name` 去掉这个前缀；`description` 保留全文（Client 只显示第一行）。缺少 tools 服务 → `unavailable`。

### 重连与授权（0.2）
`mcp-settings/state`、`retry`、`auth-check`、`auth-start`、`auth-complete`、`auth-cancel`、`auth-forget` 的约定见 [auth-retry.md](auth-retry.md)。Host 实现在 `host/mcp-routes.js`（接线与插件 Config）、`host/supervisor.js`、`host/oauth*.js`、`host/mcp-state.js`。新增错误码：`oauth-client-required`（授权服务器不支持动态注册，需要填 Client ID）、`oauth-failed`（发现、注册、换取令牌失败或授权服务器拒绝，message 说明原因）。
