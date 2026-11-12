// Skills settings page: two tabs over the Host routes `skills-*` and `repos-*`
// (docs/host-api.md). 已安装 lists, edits, creates, and batch-deletes skills;
// 技能仓库 adds repositories, installs from them, and checks for updates. The
// tab, the view, drafts, selections, and in-flight results live in the
// controller store, so closing and reopening Settings lands where the user left
// off and a slow repository download still finishes into the page.

const SK_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SK_NAME_MAX = 64;
const SK_ROOT_IDS = ['user-dsh', 'user-agents', 'project-dsh', 'project-agents'];
const SK_DEFAULT_LOCATION = 'user-dsh';
const SK_SCOPES = ['project', 'user', 'builtin'];
const SK_TABS = ['installed', 'repos'];
/** Select value for "hide project skills"; workspace paths are absolute, so they never start with ':'. */
const SK_NO_PROJECT = ':none';
const SK_HIGHLIGHT_MS = 2400;
const SK_SAVED_MS = 1800;
const SK_UPDATED_MS = 4000;
const SK_WORKSPACE_WAIT_MS = 1500;
/** A repository whose last successful check is older than this is checked again when its page opens. */
const SK_CHECK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** The delete confirmation names at most this many skills. */
const SK_BATCH_NAMES_MAX = 8;
/** Repository pages with more skills than this get a filter box. */
const SK_REPO_FILTER_MIN = 8;
const SK_REPO_SUGGESTIONS = [
  { label: 'Anthropic', source: 'anthropics/skills', subpath: 'skills' },
  { label: 'OpenAI', source: 'openai/skills', subpath: 'skills/.curated' },
  { label: 'Matt Pocock', source: 'mattpocock/skills' },
  { label: 'Cursor', source: 'cursor/plugins', subpath: 'pstack/skills' },
];
const SK_DRAFT_KEYS = ['name', 'description', 'whenToUse', 'modelInvocable', 'userInvocable', 'body'];
const SK_ROOT_FALLBACK = {
  'user-dsh': '~/.dsh/skills',
  'user-agents': '~/.agents/skills',
  'project-dsh': '.dsh/skills',
  'project-agents': '.agents/skills',
};
const SK_BADGE_LABELS = {
  dsh: 'sk_badgeDsh',
  agents: 'sk_badgeAgents',
  update: 'sk_badgeUpdate',
  modified: 'sk_badgeModified',
  manual: 'sk_badgeManual',
  noMenu: 'sk_badgeNoMenu',
  shadowed: 'sk_badgeShadowed',
  invalid: 'sk_badgeInvalid',
};
const SK_NAME_ERRORS = { required: 'sk_nameRequired', invalid: 'sk_nameInvalid', tooLong: 'sk_nameTooLong' };
/** Error contexts about a repository: their messages fall back to `sk_err_repo_<code>` before the generic one. */
const SK_REPO_CONTEXTS = ['repo', 'check', 'install', 'update', 'remove', 'repos'];
const SK_SKIP_REASONS = ['exists', 'identical', 'current', 'modified'];

addDict({
  sk_nav: '技能',
  sk_title: '技能',
  sk_intro: '技能是按需加载的任务说明。Agent 会根据描述自动使用，你也可以在输入框输入 / 调用。',
  sk_tabInstalled: '已安装',
  sk_tabRepos: '技能仓库',
  sk_tabBadge: '{n} 个技能有更新',
  sk_tabBadgeOne: '1 个技能有更新',
  sk_searchPlaceholder: '搜索技能',
  sk_new: '新建技能',
  sk_select: '选择',
  sk_selectedN: '已选 {n} 个',
  sk_selectAll: '全选',
  sk_selectNone: '全不选',
  sk_selectGroup: '选择「{group}」中的全部技能',
  sk_cannotSelect: '只读，不能删除',
  sk_deleteN: '删除 {n} 个',
  sk_batchTitle: '删除 {n} 个技能？',
  sk_batchTitleOne: '删除 1 个技能？',
  sk_batchBody: '会删除这些技能的整个目录。',
  sk_batchShared: '其中 {n} 个在通用目录里，Claude Code、Codex 等工具也会失去它们。',
  sk_batchSharedOne: '其中 1 个在通用目录里，Claude Code、Codex 等工具也会失去它。',
  sk_batchMore: '{names} 等 {n} 个',
  sk_batchNameAt: '{name}（{place}）',
  sk_projectLabel: '项目：',
  sk_projectPicker: '显示哪个项目的技能',
  sk_noProject: '不显示项目技能',
  sk_groupProject: '项目 · {name}',
  sk_groupUser: '个人',
  sk_groupBuiltin: '内置',
  sk_readOnly: '只读',
  sk_badgeDsh: 'DSH 专用',
  sk_badgeDshTip: '只有 DSH 读取这个目录',
  sk_badgeAgents: '通用',
  sk_badgeAgentsTip: 'Claude Code、Codex 等工具也会读取这个目录',
  sk_badgeRepoTip: '从技能仓库 {repo} 安装',
  sk_badgeUpdate: '有更新',
  sk_badgeUpdateTip: '技能仓库里有新版本',
  sk_badgeModified: '已修改',
  sk_badgeModifiedTip: '安装后在本地改过',
  sk_badgeManual: '仅手动调用',
  sk_badgeManualTip: 'Agent 不会自动加载，只能用 /名称 调用',
  sk_badgeNoMenu: '不在 / 菜单',
  sk_badgeNoMenuTip: '不能在输入框用 /名称 调用',
  sk_badgeShadowed: '被覆盖',
  sk_badgeShadowedTip: '{path} 里的同名技能优先级更高',
  sk_badgeInvalid: '格式错误',
  sk_builtinSource: '内置技能',
  sk_noDescription: '没有描述',
  sk_emptyTitle: '还没有技能',
  sk_emptyHint: '新建一个，或从技能仓库安装。',
  sk_browseRepos: '浏览技能仓库',
  sk_noMatch: '没有匹配「{query}」的技能',
  sk_incomplete: '暂时读不到内置技能，列表可能不完整。',
  sk_listLoading: '正在读取技能…',
  sk_resultInstalled: '已安装 {n} 个',
  sk_resultUpdated: '已更新 {n} 个',
  sk_resultRemoved: '已删除 {n} 个',
  sk_resultSkipped: '跳过 {n} 个',
  sk_resultFailed: '{n} 个失败',
  sk_resultFrom: '{label}：{text}',
  sk_resultRelations: '其中 {list}',
  sk_resultRelationsJoin: '、',
  sk_resultOverrides: '{n} 个会覆盖同名技能',
  sk_resultOverridesOne: '1 个会覆盖同名技能',
  sk_resultOverridden: '{n} 个被同名技能覆盖而不会生效',
  sk_resultOverriddenOne: '1 个被同名技能覆盖而不会生效',
  sk_resultOverriddenNames: '被覆盖、不会生效：{names}',
  sk_resultSep: '，',
  sk_skip_exists: '已存在，未覆盖：{names}',
  sk_skip_identical: '内容相同，已记录来源：{names}',
  sk_skip_current: '已是最新：{names}',
  sk_skip_modified: '本地改过，未更新：{names}',
  sk_nameSep: '、',
  sk_resultFailure: '{name}：{error}',
  sk_dismiss: '关闭',
  sk_createTitle: '新建技能',
  sk_name: '名称',
  sk_namePlaceholder: 'my-skill',
  sk_nameHint: '小写字母、数字和连字符，最长 64 个字符',
  sk_nameRequired: '请填写名称',
  sk_nameInvalid: '只能用小写字母、数字和连字符，连字符不能在开头或结尾',
  sk_nameTooLong: '名称最长 64 个字符',
  sk_nameExistsHere: '这个位置已经有同名技能',
  sk_shadowOverrides: '将覆盖「{label}」中的同名技能',
  sk_shadowOverridden: '会被「{label}」中的同名技能覆盖，不会生效',
  sk_tagOverrides: '覆盖同名',
  sk_tagOverridden: '会被覆盖',
  sk_nameToken: '名称',
  sk_location: '位置',
  sk_locUserDsh: '个人 · DSH 专用',
  sk_locUserAgents: '个人 · 通用',
  sk_locProjectDsh: '项目 · DSH 专用',
  sk_locProjectAgents: '项目 · 通用',
  sk_locShared: '{path} · Claude Code、Codex 等也会读取',
  sk_locGroupUser: '个人',
  sk_locGroupProject: '项目',
  sk_description: '描述',
  sk_descriptionHelp: 'Agent 根据描述判断什么时候用这个技能：写清楚它做什么、什么时候用。',
  sk_descriptionPlaceholder: '例如：整理会议纪要。用户给出会议记录或录音转写时使用。',
  sk_descriptionRequired: '请填写描述',
  sk_whenToUse: '使用时机',
  sk_whenToUsePlaceholder: '可选，补充说明在什么情况下使用',
  sk_invocation: 'Agent 使用方式',
  sk_invAuto: '自动',
  sk_invManual: '仅手动调用',
  sk_invAutoHint: 'Agent 会在合适的时候自动加载',
  sk_invManualHint: '只有你在输入框用 /{name} 调用时才加载，不占用 Agent 的技能目录',
  sk_userInvocable: '可以在输入框用 /{name} 调用',
  sk_unusable: 'Agent 不会自动加载，也不能用 / 调用，这个技能不会被用到。',
  sk_body: '说明',
  sk_bodyShortcutMac: '⌘ Enter 保存',
  sk_bodyShortcut: 'Ctrl+Enter 保存',
  sk_bodyTemplate: '## 何时使用\n\n…\n\n## 步骤\n\n1. …\n',
  sk_files: '附带文件',
  sk_filesMore: '还有 {n} 个',
  sk_bannerShadowed: '同名技能在 {path} 优先级更高，这个不会生效。',
  sk_bannerInvalid: '格式错误',
  sk_bannerInvalidHint: '修正后保存即可。',
  sk_readOnlyBuiltin: '这是 DSH 内置的技能，不能在这里修改。',
  sk_readOnlyOther: '这个技能不在可写的技能目录里，不能在这里修改。',
  sk_originFrom: '从技能仓库 {repo} 安装',
  sk_originFromKey: '从技能仓库 {repo} 安装（{key}）',
  sk_originUpdate: '技能仓库里有新版本',
  sk_originModified: '你在本地改过这个技能，更新会覆盖这些修改。',
  sk_viewRepo: '查看仓库',
  sk_update: '更新',
  sk_updating: '正在更新…',
  sk_updateDirty: '先保存或取消修改，再更新。',
  sk_updated: '已更新到最新版本',
  sk_updateSkippedModified: '这个技能在本地改过，没有更新。再点一次「更新」可以覆盖本地修改。',
  sk_updateModifiedTitle: '覆盖本地修改？',
  sk_updateModifiedBody: '你在本地改过 {name}，更新会用技能仓库里的版本替换整个目录。',
  sk_updateAnyway: '仍然更新',
  sk_create: '创建技能',
  sk_creating: '正在创建…',
  sk_saved: '已保存',
  sk_deleteSkill: '删除技能',
  sk_deleteTitle: '删除 {name}？',
  sk_deleteBody: '会删除整个技能目录 {path}。',
  sk_deleteBodyFile: '会删除技能文件 {path}。',
  sk_deleteShared: 'Claude Code、Codex 等工具也会失去这个技能。',
  sk_discardTitle: '放弃未保存的修改？',
  sk_discardBody: '离开后，这次的修改会丢失。',
  sk_discard: '放弃修改',
  sk_keepEditing: '继续编辑',
  sk_gone: '这个技能已经不存在了，可能已被删除或移走。',
  sk_backToList: '返回技能列表',
  sk_addTitle: '添加技能仓库',
  sk_addLabel: '技能仓库地址',
  sk_addPlaceholder: 'GitHub 链接、git 地址或本地文件夹',
  sk_add: '添加',
  sk_adding: '正在添加…',
  sk_addingGit: '正在下载仓库',
  sk_addingLocal: '正在读取文件夹',
  sk_addingHint: '大仓库可能要一分钟。可以先离开这里，完成后会出现在列表里。',
  sk_suggested: '推荐',
  sk_suggestionTitle: '添加 {source}',
  sk_reposHeading: '已添加的仓库',
  sk_reposEmpty: '还没有添加技能仓库。粘贴一个链接，或从推荐里选一个。',
  sk_reposLoading: '正在读取技能仓库…',
  sk_checkAll: '检查全部更新',
  sk_checkingAll: '正在检查 {i}/{n}…',
  sk_checkAllDone: '检查完毕，{n} 个技能有更新',
  sk_checkAllDoneOne: '检查完毕，1 个技能有更新',
  sk_checkAllNone: '检查完毕，没有更新',
  sk_checkAllFailed: '{n} 个仓库检查失败',
  sk_checkAllFailedOne: '1 个仓库检查失败',
  sk_repoSkills: '{n} 个技能',
  sk_repoSkillsOne: '1 个技能',
  sk_repoInstalled: '已安装 {n}',
  sk_repoChecked: '{ago}检查',
  sk_repoNeverChecked: '尚未检查',
  sk_repoUpdates: '{n} 个可更新',
  sk_repoUpdatesOne: '1 个可更新',
  sk_repoCheckFailed: '检查失败',
  sk_repoAdded: '已添加技能仓库 {label}',
  sk_repoExisting: '技能仓库 {label} 已经添加过了',
  sk_repoRemoved: '已移除技能仓库 {label}',
  sk_repoOpen: '打开',
  sk_openGithub: '在 GitHub 打开',
  sk_check: '检查更新',
  sk_checking: '正在检查…',
  sk_checkingMeta: '正在检查更新…',
  sk_commit: '提交 {sha}',
  sk_metaSep: ' · ',
  sk_lastError: '上次检查失败：{reason}',
  sk_updatesBanner: '{n} 个技能有更新',
  sk_updatesBannerOne: '1 个技能有更新',
  sk_updateAll: '全部更新',
  sk_filterSkills: '过滤技能',
  sk_repoSkillsHeading: '技能',
  sk_repoNoSkills: '这个仓库里还没有读到技能。点「检查更新」重新下载。',
  sk_repoFetching: '正在下载仓库内容…',
  sk_statusInstalled: '已安装',
  sk_statusExists: '同名已存在',
  sk_statusExistsTip: '已有同名技能：{places}',
  sk_statusInvalid: '不可安装',
  sk_errLicense: '许可证只允许在 Anthropic 自家产品里使用，不能安装。',
  sk_alsoAt: '仓库里还有给其他 Agent 用的同名副本（未列出）：\n{paths}',
  sk_installedAt: '安装在 {places}',
  sk_installTo: '安装到',
  sk_installN: '安装 {n} 个',
  sk_updateN: '更新 {n} 个',
  sk_installing: '正在安装…',
  sk_skip: '跳过',
  sk_overwrite: '覆盖',
  sk_conflictLabel: '{name} 已存在时',
  sk_willSkip: '{n} 个已存在的技能会跳过',
  sk_willSkipOne: '1 个已存在的技能会跳过',
  sk_willOverride: '{n} 个会覆盖其他位置的同名技能',
  sk_willOverrideOne: '1 个会覆盖其他位置的同名技能',
  sk_willBeOverridden: '{n} 个会被其他位置的同名技能覆盖而不生效',
  sk_willBeOverriddenOne: '1 个会被其他位置的同名技能覆盖而不生效',
  sk_noteSep: '；',
  sk_modifiedTitle: '{n} 个技能在本地改过',
  sk_modifiedTitleOne: '1 个技能在本地改过',
  sk_modifiedBody: '更新会用技能仓库里的版本覆盖这些修改：{names}',
  sk_modifiedSkipHint: '「跳过改过的」只更新其余 {n} 个。',
  sk_skipModified: '跳过改过的',
  sk_removeRepo: '移除仓库',
  sk_removeTitle: '移除 {label}？',
  sk_removeBody: '已安装的技能会保留，但以后不能从这里检查更新。',
  sk_remove: '移除',
  sk_repoGone: '这个技能仓库已经不存在了，可能已被移除。',
  sk_backToRepos: '返回技能仓库',
  sk_errLine: '{title}：{detail}',
  sk_err_transport: '无法连接 DSH',
  'sk_err_host-outdated': '需要重启 DSH 才能完成更新',
  sk_err_internal: '出错了',
  'sk_err_bad-request': '请求不正确',
  'sk_err_not-found': '找不到这个技能',
  sk_err_exists: '这个位置已经有同名技能',
  sk_err_forbidden: '没有权限：位置不在允许的技能目录里，或技能是只读的',
  sk_err_invalid: '技能内容不合法',
  'sk_err_git-failed': '无法下载仓库',
  sk_err_unavailable: 'DSH 缺少所需的服务',
  'sk_err_add_not-found': '找不到这个文件夹、仓库或子目录',
  'sk_err_add_bad-request': '无法使用这个来源',
  sk_err_add_invalid: '这里没有找到可安装的技能',
  'sk_err_repo_not-found': '找不到这个技能仓库，可能已被移除',
  'sk_err_install_not-found': '仓库内容还没有下载，请先检查更新',
  'sk_err_update_not-found': '仓库内容还没有下载，请先检查更新',
  sk_err_update_forbidden: '不能更新：没有从这个仓库安装的记录，或不在技能目录里',
  sk_failForbidden: '没有从这个仓库安装的记录，或不在技能目录里',
  sk_err_check_unavailable: '暂时不能检查更新',
  sk_err_update_failed: '更新失败',
  sk_err_delete_failed: '删除失败',
  sk_err_save_forbidden: '没有权限写入这个位置',
  sk_err_delete_forbidden: '这个技能是只读的，不能删除',
}, {
  sk_nav: 'Skills',
  sk_title: 'Skills',
  sk_intro: 'Skills are task instructions loaded on demand. The agent uses one when its description fits, and you can call one with / in the composer.',
  sk_tabInstalled: 'Installed',
  sk_tabRepos: 'Repositories',
  sk_tabBadge: '{n} skill updates available',
  sk_tabBadgeOne: '1 skill update available',
  sk_searchPlaceholder: 'Search skills',
  sk_new: 'New skill',
  sk_select: 'Select',
  sk_selectedN: '{n} selected',
  sk_selectAll: 'Select all',
  sk_selectNone: 'Select none',
  sk_selectGroup: 'Select all skills in “{group}”',
  sk_cannotSelect: 'Read-only; cannot be deleted',
  sk_deleteN: 'Delete {n}',
  sk_batchTitle: 'Delete {n} skills?',
  sk_batchTitleOne: 'Delete 1 skill?',
  sk_batchBody: 'This deletes the whole folder of each skill.',
  sk_batchShared: '{n} of them are in shared folders, so Claude Code, Codex, and other tools will lose them too.',
  sk_batchSharedOne: '1 of them is in a shared folder, so Claude Code, Codex, and other tools will lose it too.',
  sk_batchMore: '{names}, and {more} more',
  sk_batchNameAt: '{name} ({place})',
  sk_projectLabel: 'Project:',
  sk_projectPicker: 'Project whose skills to show',
  sk_noProject: 'Hide project skills',
  sk_groupProject: 'Project · {name}',
  sk_groupUser: 'Personal',
  sk_groupBuiltin: 'Built-in',
  sk_readOnly: 'Read-only',
  sk_badgeDsh: 'DSH only',
  sk_badgeDshTip: 'Only DSH reads this folder',
  sk_badgeAgents: 'Shared',
  sk_badgeAgentsTip: 'Claude Code, Codex, and other tools also read this folder',
  sk_badgeRepoTip: 'Installed from the skill repository {repo}',
  sk_badgeUpdate: 'Update available',
  sk_badgeUpdateTip: 'The repository has a newer version',
  sk_badgeModified: 'Modified',
  sk_badgeModifiedTip: 'Changed locally after it was installed',
  sk_badgeManual: 'Manual only',
  sk_badgeManualTip: 'The agent never loads it on its own; call it with /name',
  sk_badgeNoMenu: 'Not in / menu',
  sk_badgeNoMenuTip: 'Cannot be called with /name in the composer',
  sk_badgeShadowed: 'Overridden',
  sk_badgeShadowedTip: 'A skill with the same name in {path} takes priority',
  sk_badgeInvalid: 'Invalid format',
  sk_builtinSource: 'DSH built-ins',
  sk_noDescription: 'No description',
  sk_emptyTitle: 'No skills yet',
  sk_emptyHint: 'Create one, or install from a skill repository.',
  sk_browseRepos: 'Browse repositories',
  sk_noMatch: 'No skills match “{query}”',
  sk_incomplete: 'Built-in skills could not be read, so this list may be incomplete.',
  sk_listLoading: 'Loading skills…',
  sk_resultInstalled: 'Installed {n}',
  sk_resultUpdated: 'Updated {n}',
  sk_resultRemoved: 'Deleted {n}',
  sk_resultSkipped: 'skipped {n}',
  sk_resultFailed: '{n} failed',
  sk_resultFrom: '{label}: {text}',
  sk_resultRelations: 'of which {list}',
  sk_resultRelationsJoin: ' and ',
  sk_resultOverrides: '{n} override skills with the same name',
  sk_resultOverridesOne: '1 overrides a skill with the same name',
  sk_resultOverridden: '{n} are overridden by skills with the same name and not in effect',
  sk_resultOverriddenOne: '1 is overridden by a skill with the same name and not in effect',
  sk_resultOverriddenNames: 'Overridden, not in effect: {names}',
  sk_resultSep: ', ',
  sk_skip_exists: 'Already there, not overwritten: {names}',
  sk_skip_identical: 'Already identical, now tracked: {names}',
  sk_skip_current: 'Already up to date: {names}',
  sk_skip_modified: 'Changed locally, not updated: {names}',
  sk_nameSep: ', ',
  sk_resultFailure: '{name}: {error}',
  sk_dismiss: 'Dismiss',
  sk_createTitle: 'New skill',
  sk_name: 'Name',
  sk_namePlaceholder: 'my-skill',
  sk_nameHint: 'Lowercase letters, digits, and hyphens; up to 64 characters',
  sk_nameRequired: 'Enter a name',
  sk_nameInvalid: 'Use lowercase letters, digits, and hyphens, without a hyphen at the start or end',
  sk_nameTooLong: 'Use at most 64 characters',
  sk_nameExistsHere: 'This location already has a skill with this name',
  sk_shadowOverrides: 'Overrides the skill with the same name in “{label}”',
  sk_shadowOverridden: 'Overridden by the skill with the same name in “{label}”, so it will not take effect',
  sk_tagOverrides: 'Overrides',
  sk_tagOverridden: 'Overridden',
  sk_nameToken: 'name',
  sk_location: 'Location',
  sk_locUserDsh: 'Personal · DSH only',
  sk_locUserAgents: 'Personal · Shared',
  sk_locProjectDsh: 'Project · DSH only',
  sk_locProjectAgents: 'Project · Shared',
  sk_locShared: '{path} · Also read by Claude Code, Codex, and others',
  sk_locGroupUser: 'Personal',
  sk_locGroupProject: 'Project',
  sk_description: 'Description',
  sk_descriptionHelp: 'The agent reads the description to decide when to use this skill. Say what it does and when to use it.',
  sk_descriptionPlaceholder: 'For example: Summarizes meetings. Use when the user shares meeting notes or a transcript.',
  sk_descriptionRequired: 'Enter a description',
  sk_whenToUse: 'When to use',
  sk_whenToUsePlaceholder: 'Optional: more detail on when it applies',
  sk_invocation: 'How the agent uses it',
  sk_invAuto: 'Automatically',
  sk_invManual: 'Only when called',
  sk_invAutoHint: 'The agent loads it automatically when it fits',
  sk_invManualHint: 'Loads only when you call /{name} in the composer, and stays out of the agent’s skill list',
  sk_userInvocable: 'Can be called with /{name} in the composer',
  sk_unusable: 'The agent will not load it and it cannot be called with /, so this skill will never be used.',
  sk_body: 'Instructions',
  sk_bodyShortcutMac: '⌘ Enter to save',
  sk_bodyShortcut: 'Ctrl+Enter to save',
  sk_bodyTemplate: '## When to use\n\n…\n\n## Steps\n\n1. …\n',
  sk_files: 'Supporting files',
  sk_filesMore: '{n} more',
  sk_bannerShadowed: 'A skill with the same name in {path} has higher priority, so this one has no effect.',
  sk_bannerInvalid: 'Invalid format',
  sk_bannerInvalidHint: 'Fix it here and save.',
  sk_readOnlyBuiltin: 'This skill ships with DSH and cannot be changed here.',
  sk_readOnlyOther: 'This skill is outside the writable skill folders and cannot be changed here.',
  sk_originFrom: 'Installed from the skill repository {repo}',
  sk_originFromKey: 'Installed from the skill repository {repo} ({key})',
  sk_originUpdate: 'A newer version is available in the repository',
  sk_originModified: 'You changed this skill locally, and updating replaces those changes.',
  sk_viewRepo: 'View repository',
  sk_update: 'Update',
  sk_updating: 'Updating…',
  sk_updateDirty: 'Save or cancel your changes before updating.',
  sk_updated: 'Updated to the latest version',
  sk_updateSkippedModified: 'This skill was changed locally, so it was not updated. Select Update again to replace the local changes.',
  sk_updateModifiedTitle: 'Replace local changes?',
  sk_updateModifiedBody: 'You changed {name} locally. Updating replaces its whole folder with the repository version.',
  sk_updateAnyway: 'Update anyway',
  sk_create: 'Create skill',
  sk_creating: 'Creating…',
  sk_saved: 'Saved',
  sk_deleteSkill: 'Delete skill',
  sk_deleteTitle: 'Delete {name}?',
  sk_deleteBody: 'This deletes the whole skill folder {path}.',
  sk_deleteBodyFile: 'This deletes the skill file {path}.',
  sk_deleteShared: 'Claude Code, Codex, and other tools will lose this skill too.',
  sk_discardTitle: 'Discard unsaved changes?',
  sk_discardBody: 'Your changes will be lost if you leave.',
  sk_discard: 'Discard',
  sk_keepEditing: 'Keep editing',
  sk_gone: 'This skill no longer exists. It may have been deleted or moved.',
  sk_backToList: 'Back to skills',
  sk_addTitle: 'Add a skill repository',
  sk_addLabel: 'Repository address',
  sk_addPlaceholder: 'GitHub link, git URL, or local folder',
  sk_add: 'Add',
  sk_adding: 'Adding…',
  sk_addingGit: 'Downloading the repository',
  sk_addingLocal: 'Reading the folder',
  sk_addingHint: 'Large repositories can take a minute. You can leave this page; it appears in the list when done.',
  sk_suggested: 'Suggested',
  sk_suggestionTitle: 'Add {source}',
  sk_reposHeading: 'Added repositories',
  sk_reposEmpty: 'No repositories yet. Paste a link, or pick a suggestion.',
  sk_reposLoading: 'Loading repositories…',
  sk_checkAll: 'Check all for updates',
  sk_checkingAll: 'Checking {i}/{n}…',
  sk_checkAllDone: 'Check complete: {n} skill updates available',
  sk_checkAllDoneOne: 'Check complete: 1 skill update available',
  sk_checkAllNone: 'Check complete: everything is up to date',
  sk_checkAllFailed: '{n} repositories could not be checked',
  sk_checkAllFailedOne: '1 repository could not be checked',
  sk_repoSkills: '{n} skills',
  sk_repoSkillsOne: '1 skill',
  sk_repoInstalled: '{n} installed',
  sk_repoChecked: 'checked {ago}',
  sk_repoNeverChecked: 'not checked yet',
  sk_repoUpdates: '{n} updates',
  sk_repoUpdatesOne: '1 update',
  sk_repoCheckFailed: 'Check failed',
  sk_repoAdded: 'Added the skill repository {label}',
  sk_repoExisting: 'The skill repository {label} was already added',
  sk_repoRemoved: 'Removed the skill repository {label}',
  sk_repoOpen: 'Open',
  sk_openGithub: 'Open on GitHub',
  sk_check: 'Check for updates',
  sk_checking: 'Checking…',
  sk_checkingMeta: 'Checking for updates…',
  sk_commit: 'Commit {sha}',
  sk_metaSep: ' · ',
  sk_lastError: 'The last check failed: {reason}',
  sk_updatesBanner: '{n} skills have updates',
  sk_updatesBannerOne: '1 skill has an update',
  sk_updateAll: 'Update all',
  sk_filterSkills: 'Filter skills',
  sk_repoSkillsHeading: 'Skills',
  sk_repoNoSkills: 'No skills have been read from this repository yet. Select Check for updates to download it again.',
  sk_repoFetching: 'Downloading the repository…',
  sk_statusInstalled: 'Installed',
  sk_statusExists: 'Name taken',
  sk_statusExistsTip: 'A skill with this name already exists in {places}',
  sk_statusInvalid: 'Not installable',
  sk_errLicense: 'Licensed only for use inside Anthropic products, so it cannot be installed.',
  sk_alsoAt: 'The repository also has copies of this skill for other agents (not listed):\n{paths}',
  sk_installedAt: 'Installed in {places}',
  sk_installTo: 'Install to',
  sk_installN: 'Install {n}',
  sk_updateN: 'Update {n}',
  sk_installing: 'Installing…',
  sk_skip: 'Skip',
  sk_overwrite: 'Overwrite',
  sk_conflictLabel: 'If {name} exists',
  sk_willSkip: '{n} existing skills will be skipped',
  sk_willSkipOne: '1 existing skill will be skipped',
  sk_willOverride: '{n} will override skills with the same name elsewhere',
  sk_willOverrideOne: '1 will override a skill with the same name elsewhere',
  sk_willBeOverridden: '{n} will be overridden by skills with the same name elsewhere and will not take effect',
  sk_willBeOverriddenOne: '1 will be overridden by a skill with the same name elsewhere and will not take effect',
  sk_noteSep: '; ',
  sk_modifiedTitle: '{n} skills were changed locally',
  sk_modifiedTitleOne: '1 skill was changed locally',
  sk_modifiedBody: 'Updating replaces those changes with the repository version: {names}',
  sk_modifiedSkipHint: 'Skip changed ones updates only the other {n}.',
  sk_skipModified: 'Skip changed ones',
  sk_removeRepo: 'Remove repository',
  sk_removeTitle: 'Remove {label}?',
  sk_removeBody: 'Installed skills stay, but you can no longer check them for updates here.',
  sk_remove: 'Remove',
  sk_repoGone: 'This repository no longer exists. It may have been removed.',
  sk_backToRepos: 'Back to repositories',
  sk_errLine: '{title}: {detail}',
  sk_err_transport: 'Could not reach DSH',
  'sk_err_host-outdated': 'Restart DSH to finish updating',
  sk_err_internal: 'Something went wrong',
  'sk_err_bad-request': 'The request was not valid',
  'sk_err_not-found': 'Skill not found',
  sk_err_exists: 'This location already has a skill with this name',
  sk_err_forbidden: 'Not allowed: the location is outside the skill folders, or the skill is read-only',
  sk_err_invalid: 'The skill content is not valid',
  'sk_err_git-failed': 'Could not download the repository',
  sk_err_unavailable: 'A required DSH service is unavailable',
  'sk_err_add_not-found': 'Folder, repository, or subfolder not found',
  'sk_err_add_bad-request': 'This source cannot be used',
  sk_err_add_invalid: 'No installable skills found here',
  'sk_err_repo_not-found': 'Repository not found. It may have been removed.',
  'sk_err_install_not-found': 'The repository has not been downloaded yet. Check for updates first.',
  'sk_err_update_not-found': 'The repository has not been downloaded yet. Check for updates first.',
  sk_err_update_forbidden: 'Cannot update: no record of installing it from this repository, or it is outside the skill folders',
  sk_failForbidden: 'no record of installing it from this repository, or outside the skill folders',
  sk_err_check_unavailable: 'Updates cannot be checked right now',
  sk_err_update_failed: 'Update failed',
  sk_err_delete_failed: 'Could not delete',
  sk_err_save_forbidden: 'This location is not writable',
  sk_err_delete_forbidden: 'This skill is read-only and cannot be deleted',
});

// ---------------------------------------------------------------------------
// Pure helpers (unit tested in test/skills-ui.test.mjs)
// ---------------------------------------------------------------------------

function skIdentity(value) { return value; }

function skList(value) { return Array.isArray(value) ? value : []; }

/** Live name normalization: lowercase, separators → '-', invalid characters dropped. */
function skNormalizeName(raw) {
  return String(raw ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\s_.]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '');
}

/** null when valid, else 'required' | 'tooLong' | 'invalid'. */
function skValidateName(name) {
  const value = String(name ?? '');
  if (!value) return 'required';
  if (value.length > SK_NAME_MAX) return 'tooLong';
  if (!SK_NAME_RE.test(value)) return 'invalid';
  return null;
}

/** Every whitespace-separated token must occur in the name or description (case-insensitive). */
function skMatches(item, query) {
  const tokens = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const haystack = `${item.name ?? ''}\n${item.description ?? ''}`.toLowerCase();
  return tokens.every(token => haystack.includes(token));
}

/** Groups in display order (project, user, builtin), each with its filtered items, unfiltered total, and root paths. */
function skGroupSkills(skills, roots, query) {
  const list = skList(skills);
  const rootList = skList(roots);
  return SK_SCOPES.map((scope) => {
    const all = list.filter(item => item.scope === scope);
    const items = all.filter(item => skMatches(item, query));
    const scoped = rootList.filter(root => root.scope === scope);
    const existing = scoped.filter(root => root.exists);
    const paths = (existing.length ? existing : scoped).map(root => root.displayPath || root.path).filter(Boolean);
    return { scope, total: all.length, items, paths };
  });
}

/** Badge descriptors for a skill, in display order. */
function skBadges(item) {
  const badges = [];
  const root = typeof item.root === 'string' ? item.root : '';
  if (root.endsWith('-dsh')) badges.push({ id: 'dsh', tone: 'outline' });
  else if (root.endsWith('-agents')) badges.push({ id: 'agents', tone: 'outline' });
  const origin = item.origin;
  if (origin && typeof origin === 'object') {
    if (origin.repoLabel) badges.push({ id: 'repo', tone: 'neutral', repo: String(origin.repoLabel) });
    if (origin.updateAvailable) badges.push({ id: 'update', tone: 'info' });
    if (origin.modified) badges.push({ id: 'modified', tone: 'outline' });
  }
  if (item.modelInvocable === false) badges.push({ id: 'manual', tone: 'neutral' });
  if (item.userInvocable === false) badges.push({ id: 'noMenu', tone: 'neutral' });
  if (item.active === false) badges.push({ id: 'shadowed', tone: 'warn', path: item.shadowedBy?.displayPath ? skStripSkillFile(item.shadowedBy.displayPath) : null });
  if (item.invalid) badges.push({ id: 'invalid', tone: 'error', reason: String(item.invalid) });
  return badges;
}

function skStripSkillFile(path) {
  return String(path ?? '').replace(/[\\/]SKILL\.md$/i, '');
}

/** What a delete removes: the skill folder for bundles, the file itself for flat skills. */
function skDisplayDir(item) {
  const shown = item.displayPath || item.path || item.dir || '';
  return item.layout === 'flat' ? shown : skStripSkillFile(shown);
}

function skBaseName(path) {
  const parts = String(path ?? '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(path ?? '');
}

/** Derive the home directory from a root whose displayPath starts with '~'. */
function skHomeFrom(roots) {
  for (const root of skList(roots)) {
    const { path, displayPath } = root || {};
    if (typeof path !== 'string' || typeof displayPath !== 'string' || !displayPath.startsWith('~')) continue;
    const tail = displayPath.slice(1);
    if (path.endsWith(tail) && path.length > tail.length) return path.slice(0, path.length - tail.length);
  }
  return null;
}

function skAbbreviate(path, home) {
  if (!home || !path) return path;
  if (path === home) return '~';
  if (path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)) return `~${path.slice(home.length)}`;
  return path;
}

/** Usable workspaces from the settings workspace store: unique absolute paths with a title. */
function skWorkspaceItems(state) {
  const items = state && Array.isArray(state.items) ? state.items : [];
  const out = [];
  const seen = new Set();
  for (const workspace of items) {
    if (!workspace || typeof workspace.path !== 'string' || !workspace.path || seen.has(workspace.path)) continue;
    seen.add(workspace.path);
    out.push({
      id: String(workspace.workspaceId ?? workspace.path),
      path: workspace.path,
      title: String(workspace.title || workspace.displayTitle || skBaseName(workspace.path)),
    });
  }
  return out;
}

/**
 * Effective project selection. pref: string path | null (hide project skills) | undefined (first workspace).
 * A remembered path is trusted while the workspace list is still loading.
 */
function skResolveWorkspace(pref, items, phase) {
  if (pref === null) return { ready: true, path: null, workspace: null };
  if (typeof pref === 'string' && pref) {
    const hit = items.find(workspace => workspace.path === pref);
    if (hit) return { ready: true, path: pref, workspace: hit };
    if (phase !== 'ready') return { ready: true, path: pref, workspace: null };
  }
  if (phase !== 'ready') return { ready: false, path: undefined, workspace: null };
  const first = items[0] ?? null;
  return { ready: true, path: first ? first.path : null, workspace: first };
}

function skHasProject(listing) {
  return Boolean(listing && Array.isArray(listing.roots) && listing.roots.some(root => root.scope === 'project'));
}

/** The chosen location if it is available, else the personal DSH folder. */
function skEffectiveLocation(location, hasProject) {
  if (!SK_ROOT_IDS.includes(location)) return SK_DEFAULT_LOCATION;
  if (location.startsWith('project-') && !hasProject) return SK_DEFAULT_LOCATION;
  return location;
}

function skRootDisplay(roots, id) {
  const root = skList(roots).find(candidate => candidate.id === id);
  return root ? (root.displayPath || root.path) : SK_ROOT_FALLBACK[id];
}

/** Select options for the four locations, grouped 个人 / 项目; project ones only when a project is listed. */
function skLocationOptions(roots, hasProject, t) {
  const user = t('sk_locGroupUser');
  const options = [
    { value: 'user-dsh', label: t('sk_locUserDsh'), detail: skRootDisplay(roots, 'user-dsh'), group: user },
    { value: 'user-agents', label: t('sk_locUserAgents'), detail: fill(t('sk_locShared'), { path: skRootDisplay(roots, 'user-agents') }), group: user },
  ];
  if (hasProject) {
    const project = t('sk_locGroupProject');
    options.push(
      { value: 'project-dsh', label: t('sk_locProjectDsh'), detail: skRootDisplay(roots, 'project-dsh'), group: project },
      { value: 'project-agents', label: t('sk_locProjectAgents'), detail: fill(t('sk_locShared'), { path: skRootDisplay(roots, 'project-agents') }), group: project },
    );
  }
  return options;
}

/** Same-name skills: `here` in the target root (blocks create), `elsewhere` in any other root (warning only). */
function skNameConflicts(name, skills, location) {
  let here = null;
  let elsewhere = null;
  if (!name) return { here, elsewhere };
  for (const item of skList(skills)) {
    if (item.name !== name) continue;
    if (item.root === location) here = here ?? item;
    else elsewhere = elsewhere ?? item;
  }
  return { here, elsewhere };
}

/** Fallback priorities (design.md 业务事实) when a listing root carries no rank; built-ins and other sources rank last. */
const SK_ROOT_RANKS = { 'project-dsh': 100, 'project-agents': 200, 'user-dsh': 400, 'user-agents': 500 };
const SK_BUILTIN_RANK = 600;
const SK_ROOT_LABELS = {
  'user-dsh': 'sk_locUserDsh',
  'user-agents': 'sk_locUserAgents',
  'project-dsh': 'sk_locProjectDsh',
  'project-agents': 'sk_locProjectAgents',
};

/** Priority of a root id (lower wins), read from the listing's roots. */
function skRootRank(roots, id) {
  if (typeof id !== 'string') return SK_BUILTIN_RANK;
  const root = skList(roots).find(candidate => candidate.id === id);
  if (root && typeof root.rank === 'number') return root.rank;
  return SK_ROOT_RANKS[id] ?? SK_BUILTIN_RANK;
}

function skRootLabel(id, t) {
  return typeof id === 'string' && SK_ROOT_LABELS[id] ? t(SK_ROOT_LABELS[id]) : t('sk_groupBuiltin');
}

/**
 * How a skill named `name` written to `root` would relate to same-name skills in other roots:
 * `overridden` when any of them has higher priority (the new one would not take effect; that one is reported),
 * else `overrides` naming the highest-priority one it would displace; null when there is no other.
 */
function skShadowRelation(name, skills, root, roots) {
  if (!name) return null;
  const mine = skRootRank(roots, root);
  let above = null;
  let below = null;
  for (const item of skList(skills)) {
    if (item.name !== name || item.root === root) continue;
    const rank = skRootRank(roots, item.root);
    if (rank < mine) { if (!above || rank < above.rank) above = { item, rank }; }
    else if (!below || rank < below.rank) below = { item, rank };
  }
  if (above) return { direction: 'overridden', item: above.item, root: above.item.root ?? null };
  if (below) return { direction: 'overrides', item: below.item, root: below.item.root ?? null };
  return null;
}

/** Split names about to land in `root` by their relation to same-name skills elsewhere. */
function skInstallRelations(names, skills, root, roots) {
  const overrides = [];
  const overridden = [];
  for (const name of skList(names)) {
    const relation = skShadowRelation(name, skills, root, roots);
    if (relation && relation.direction === 'overrides') overrides.push(name);
    else if (relation) overridden.push(name);
  }
  return { overrides, overridden };
}

/** Sentence for a relation: 「将覆盖「个人 · 通用」中的同名技能」 / 「会被「项目 · DSH 专用」中的同名技能覆盖，不会生效」. */
function skShadowText(relation, t) {
  const key = relation.direction === 'overrides' ? 'sk_shadowOverrides' : 'sk_shadowOverridden';
  return fill(t(key), { label: skRootLabel(relation.root, t) });
}

/** Tooltip: the sentence plus the other skill's folder when it has one. */
function skShadowTitle(relation, t) {
  const item = relation.item;
  const text = skShadowText(relation, t);
  return item && (item.displayPath || item.path) ? `${text}\n${skDisplayDir(item)}` : text;
}

function skCreateProblems(draft, skills, location) {
  const name = skValidateName(draft.name) ?? (skNameConflicts(draft.name, skills, location).here ? 'exists' : null);
  return { name, description: !String(draft.description ?? '').trim() };
}

function skBlankDraft(body) {
  return { name: '', description: '', whenToUse: '', modelInvocable: true, userInvocable: true, body: body ?? '' };
}

function skDraftFromRead(value) {
  const item = (value && value.item) || {};
  return {
    name: item.name ?? '',
    description: item.description ?? '',
    whenToUse: item.whenToUse ?? '',
    modelInvocable: item.modelInvocable !== false,
    userInvocable: item.userInvocable !== false,
    body: (value && typeof value.body === 'string') ? value.body : '',
  };
}

function skDraftDirty(a, b) {
  if (!a || !b) return false;
  return SK_DRAFT_KEYS.some(key => a[key] !== b[key]);
}

function skSavePayload(draft, name) {
  return {
    name,
    description: draft.description.trim(),
    whenToUse: draft.whenToUse.trim(),
    modelInvocable: draft.modelInvocable,
    userInvocable: draft.userInvocable,
    body: draft.body,
  };
}

function skLooksLocal(source) {
  const value = String(source ?? '').trim();
  return /^(~|\/|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\\\\|file:)/.test(value);
}

function skIsHighlighted(item, highlight) {
  if (!highlight || !Array.isArray(highlight.names)) return false;
  return highlight.names.some(entry => (entry === item.name && item.root === highlight.root)
    || (entry && (entry === item.dir || entry === item.path)));
}

function skFindItem(listing, id) {
  if (!listing || !Array.isArray(listing.skills)) return null;
  return listing.skills.find(item => item.id === id) ?? null;
}

/** `{n}` message with an optional `<key>One` singular variant (defined in both languages). */
function skCount(t, key, n) {
  const singular = `${key}One`;
  return fill(t(n === 1 && DICT.en[singular] !== undefined ? singular : key), { n });
}

/** Plain error record for the store: CallError keeps its Host code; anything else is a transport failure. */
function skErr(error) {
  return {
    code: error instanceof CallError ? error.code : 'transport',
    message: error instanceof Error ? error.message : String(error ?? ''),
  };
}

/** Localized headline for an error code (context-specific first, then repository-wide), with the Host message as detail. */
function skErrorInfo(error, t, context) {
  const code = (error && error.code) || 'internal';
  const keys = [
    context ? `sk_err_${context}_${code}` : null,
    context && SK_REPO_CONTEXTS.includes(context) ? `sk_err_repo_${code}` : null,
    `sk_err_${code}`,
  ];
  const key = keys.find(candidate => candidate && DICT.en[candidate] !== undefined) ?? 'sk_err_internal';
  const title = t(key);
  const message = error && error.message ? String(error.message) : '';
  return { title, detail: message && message !== title ? message : '' };
}

function skErrorLine(error, t, context) {
  const info = skErrorInfo(error, t, context);
  return info.detail ? fill(t('sk_errLine'), info) : info.title;
}

/** Like `fill`, but placeholders take React nodes. */
function skFillNodes(template, values) {
  const text = String(template);
  const out = [];
  let last = 0;
  let index = 0;
  text.replace(/\{(\w+)\}/g, (match, key, offset) => {
    out.push(text.slice(last, offset));
    out.push(h(Fragment, { key: `v${index++}` }, values[key] ?? ''));
    last = offset + match.length;
    return match;
  });
  out.push(text.slice(last));
  return out;
}

function skIsSaveShortcut(event) {
  return event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
    && !(event.nativeEvent && event.nativeEvent.isComposing);
}

function skIsEnter(event) {
  return event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    && !(event.nativeEvent && event.nativeEvent.isComposing);
}

function skIsMac() {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
}

function skNormalizeListing(value) {
  return {
    projectRoot: value && typeof value.projectRoot === 'string' ? value.projectRoot : undefined,
    roots: value && Array.isArray(value.roots) ? value.roots : [],
    skills: value && Array.isArray(value.skills) ? value.skills : [],
    complete: !(value && value.complete === false),
  };
}

// ---- Selection (已安装 multi-select) ---------------------------------------

/** 'all' | 'some' | 'none' for a set of ids against a selection map, with the chosen count. */
function skTriState(ids, selected) {
  const list = skList(ids);
  const chosen = list.filter(id => selected && selected[id]).length;
  const state = !list.length || chosen === 0 ? 'none' : chosen === list.length ? 'all' : 'some';
  return { state, chosen, total: list.length };
}

/** Ids that can be selected among `items`: only skills the Host may delete. */
function skSelectableIds(items) {
  return skList(items).filter(item => item.editable).map(item => item.id);
}

/** The skills a batch delete acts on: selected, deletable, and visible under the current search. */
function skSelectedForDelete(listing, query, selected) {
  if (!listing || !selected) return [];
  return skList(listing.skills).filter(item => item.editable && selected[item.id] && skMatches(item, query));
}

/** Confirmation text parts: names (at most 8, then 「等 N 个」), and how many live in shared folders. */
function skBatchSummary(items, t) {
  const list = skList(items);
  const counts = new Map();
  for (const item of list) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
  // A name in two locations would read as a duplicate; those carry their location.
  const label = item => (counts.get(item.name) > 1
    ? fill(t('sk_batchNameAt'), { name: item.name, place: skRootLabel(item.root, t) })
    : item.name);
  const shownItems = list.slice(0, SK_BATCH_NAMES_MAX).map(label);
  const joined = shownItems.join(t('sk_nameSep'));
  const names = list.length > SK_BATCH_NAMES_MAX
    ? fill(t('sk_batchMore'), { names: joined, n: list.length, more: list.length - SK_BATCH_NAMES_MAX })
    : joined;
  const shared = list.filter(item => typeof item.root === 'string' && item.root.endsWith('-agents')).length;
  return { names, shared, count: list.length };
}

// ---- Repositories ---------------------------------------------------------

function skTrimSlashes(value) {
  return String(value ?? '').trim().replace(/^[\\/]+|[\\/]+$/g, '');
}

/** Lowercased `owner/repo` when the text names a GitHub repository (URL, ssh, or `owner/repo` shorthand), else null. */
function skGithubRepo(text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  const full = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?(?:www\.)?github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#]|$)/i.exec(value);
  const short = full ? null : /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(value);
  const match = full || short;
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/** Identity of a GitHub repository entry for suggestion matching: `owner/repo|subpath`; null for other sources. */
function skRepoKey(repo) {
  if (!repo || repo.kind === 'local') return null;
  const github = skGithubRepo(repo.url) || skGithubRepo(repo.source) || skGithubRepo(repo.webUrl);
  return github ? `${github}|${skTrimSlashes(repo.subpath)}` : null;
}

function skSuggestionKey(suggestion) {
  const github = skGithubRepo(suggestion.source);
  return github ? `${github}|${skTrimSlashes(suggestion.subpath)}` : null;
}

/** Suggestions whose repository (same owner/repo and subpath) has not been added yet. */
function skVisibleSuggestions(suggestions, repositories) {
  const taken = new Set(skList(repositories).map(skRepoKey).filter(Boolean));
  return skList(suggestions).filter(suggestion => !taken.has(skSuggestionKey(suggestion)));
}

/** Total skills with an update across repositories (the 技能仓库 tab badge). */
function skUpdateCount(repositories) {
  return skList(repositories).reduce((sum, repo) => {
    const n = repo && typeof repo.updateCount === 'number' && Number.isFinite(repo.updateCount) ? repo.updateCount : 0;
    return sum + Math.max(0, Math.floor(n));
  }, 0);
}

/** A repository page needs a background check when it was never checked, the check is stale, or the cache is gone. */
function skNeedsCheck(detail, now) {
  const repo = detail && detail.repository;
  if (!repo) return false;
  if (typeof repo.checkedAt !== 'number') return true;
  if (now - repo.checkedAt > SK_CHECK_MAX_AGE_MS) return true;
  return Boolean(repo.lastError) && skList(detail.skills).length === 0;
}

function skNormalizeRepoDetail(value) {
  const repository = value && value.repository && typeof value.repository === 'object' ? value.repository : null;
  return { repository, skills: skList(value && value.skills) };
}

/**
 * Status of one repository skill from its local copies:
 *   invalid   — cannot be installed
 *   update    — a copy installed from this repository has a newer version upstream
 *   installed — copies from this repository exist and are current
 *   exists    — only same-name copies with no record from this repository
 *   none      — not installed anywhere
 * `modified` is true when a tracked copy was changed locally; `updateModified` when an updatable one was.
 */
function skRepoRowStatus(skill) {
  const installs = skList(skill && skill.installs);
  const tracked = installs.filter(copy => copy.tracked);
  const others = installs.filter(copy => !copy.tracked);
  const updatable = tracked.filter(copy => copy.updateAvailable);
  let kind;
  if (!skill || !skill.valid) kind = 'invalid';
  else if (updatable.length) kind = 'update';
  else if (tracked.length) kind = 'installed';
  else if (others.length) kind = 'exists';
  else kind = 'none';
  return {
    kind, tracked, others, updatable,
    modified: tracked.some(copy => copy.modified),
    updateModified: updatable.some(copy => copy.modified),
  };
}

/** Rows that can be checked: installable (none / exists) or updatable. */
function skRepoSelectable(status) {
  return status.kind === 'none' || status.kind === 'exists' || status.kind === 'update';
}

function skRepoInstallable(status) {
  return status.kind === 'none' || status.kind === 'exists';
}

/**
 * repos-install payload for the selected installable rows. A row whose name is already taken in `root` is sent
 * with its skip / overwrite choice (skip = overwrite false, reported back as skipped); `install` counts the rows
 * that will actually be written, and `names` lists them for the shadowing notes.
 */
function skRepoInstallPlan(skills, selected, overwrite, root) {
  const items = [];
  const names = [];
  let install = 0;
  let skip = 0;
  for (const skill of skList(skills)) {
    if (!selected || !selected[skill.key]) continue;
    const status = skRepoRowStatus(skill);
    if (!skRepoInstallable(status)) continue;
    const conflict = status.others.some(copy => copy.root === root);
    const replace = conflict && Boolean(overwrite && overwrite[skill.key]);
    items.push({ key: skill.key, overwrite: replace });
    if (conflict && !replace) skip += 1;
    else { install += 1; names.push(skill.name); }
  }
  return { items, install, skip, names };
}

/**
 * repos-update payload covering every updatable tracked copy of the picked rows.
 * mode: undefined → send every copy with force false (the caller asks first when `modifiedRows` > 0);
 *       'force' → modified copies are sent with force true; 'skip' → modified copies are left out.
 * `rows` counts picked rows with an update, `modifiedRows` those with a locally changed updatable copy,
 * `skippedNames` the rows left out entirely by 'skip'.
 */
function skRepoUpdatePlan(skills, pick, mode) {
  const items = [];
  const names = [];
  const modifiedNames = [];
  const skippedNames = [];
  let rows = 0;
  for (const skill of skList(skills)) {
    if (!pick(skill)) continue;
    const status = skRepoRowStatus(skill);
    if (status.kind !== 'update') continue;
    rows += 1;
    if (status.updateModified) modifiedNames.push(skill.name);
    let sent = 0;
    for (const copy of status.updatable) {
      if (copy.modified && mode === 'skip') continue;
      items.push({ path: copy.path, force: Boolean(copy.modified && mode === 'force') });
      sent += 1;
    }
    if (sent) names.push(skill.name);
    else skippedNames.push(skill.name);
  }
  return { items, rows, names, modifiedRows: modifiedNames.length, modifiedNames, skippedNames };
}

/** Locations of copies, e.g. 「个人 · DSH 专用、项目 · 通用」. */
function skPlaces(copies, t) {
  const labels = [];
  for (const copy of skList(copies)) {
    const label = skRootLabel(copy.root, t);
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.join(t('sk_nameSep'));
}

function skEntryName(entry) {
  return typeof entry === 'string' ? entry : String((entry && entry.name) ?? '');
}

function skSkipEntry(entry) {
  if (typeof entry === 'string') return { name: entry, reason: 'exists' };
  const reason = entry && SK_SKIP_REASONS.includes(entry.reason) ? entry.reason : 'exists';
  return { name: skEntryName(entry), reason };
}

function skFailEntry(entry) {
  return { name: skEntryName(entry), error: String((entry && entry.error) ?? '') };
}

/** A per-item failure reason for display; the Host's bare 'forbidden' (path not recorded / outside the roots) is localized. */
function skFailureText(error, t) {
  return error === 'forbidden' ? t('sk_failForbidden') : String(error ?? '');
}

/** Tooltip for a repository skill: its folder, plus same-name copies the Host folded away. */
function skRepoSkillWhere(skill, t) {
  const also = skList(skill.alsoAt);
  return also.length ? `${skill.key}\n${fill(t('sk_alsoAt'), { paths: also.join('\n') })}` : skill.key;
}

/** Localize the Host's known reasons a repository skill cannot be installed; other reasons stay verbatim. */
function skCandidateError(error, t) {
  const text = String(error ?? '');
  if (/^Licensed for use within Anthropic products only/.test(text)) return t('sk_errLicense');
  return text || t('sk_statusInvalid');
}

/** Distinct names, in first-seen order. */
function skUnique(names) {
  return [...new Set(skList(names).filter(Boolean))];
}

/**
 * Text for a result line: `text` (one sentence), `warn` tone, `metas` (secondary lines), `failures`.
 * Kinds: install | update | delete | check | added | existing | removed.
 */
function skResultSummary(result, t) {
  const kind = result.kind || 'install';
  const failed = skList(result.failed).map(skFailEntry);
  const skipped = skList(result.skipped).map(skSkipEntry);
  const overrides = skList(result.overrides);
  const overridden = skList(result.overridden);
  const parts = [];
  const metas = [];
  let warn = failed.length > 0;
  if (kind === 'added' || kind === 'existing' || kind === 'removed') {
    const key = kind === 'added' ? 'sk_repoAdded' : kind === 'existing' ? 'sk_repoExisting' : 'sk_repoRemoved';
    return { text: fill(t(key), { label: result.label ?? '' }), warn: false, metas, failures: [] };
  }
  if (kind === 'check') {
    parts.push(result.updates ? skCount(t, 'sk_checkAllDone', result.updates) : t('sk_checkAllNone'));
    if (failed.length) parts.push(skCount(t, 'sk_checkAllFailed', failed.length));
    return { text: parts.join(t('sk_resultSep')), warn, metas, failures: failed };
  }
  if (kind === 'delete') parts.push(fill(t('sk_resultRemoved'), { n: skList(result.removed).length }));
  else if (kind === 'update') parts.push(fill(t('sk_resultUpdated'), { n: skUnique(result.updated).length }));
  else {
    // 「已安装 2 个，其中 1 个会覆盖同名技能、1 个被同名技能覆盖而不会生效，跳过 1 个」:
    // the relations qualify the installed count, so they follow it as one clause.
    parts.push(fill(t('sk_resultInstalled'), { n: skList(result.installed).length }));
    const relations = [
      overrides.length ? skCount(t, 'sk_resultOverrides', overrides.length) : null,
      overridden.length ? skCount(t, 'sk_resultOverridden', overridden.length) : null,
    ].filter(Boolean);
    if (relations.length) parts.push(fill(t('sk_resultRelations'), { list: relations.join(t('sk_resultRelationsJoin')) }));
  }
  // One skill can have several copies (update); count skills, not copies.
  const skippedCount = skUnique(skipped.map(entry => entry.name)).length;
  if (skippedCount) parts.push(fill(t('sk_resultSkipped'), { n: skippedCount }));
  if (failed.length) parts.push(fill(t('sk_resultFailed'), { n: failed.length }));
  if (overridden.length) {
    warn = true;
    metas.push(fill(t('sk_resultOverriddenNames'), { names: overridden.join(t('sk_nameSep')) }));
  }
  for (const reason of SK_SKIP_REASONS) {
    const names = skUnique(skipped.filter(entry => entry.reason === reason).map(entry => entry.name));
    if (names.length) metas.push(fill(t(`sk_skip_${reason}`), { names: names.join(t('sk_nameSep')) }));
  }
  let text = parts.join(t('sk_resultSep'));
  if (result.label) text = fill(t('sk_resultFrom'), { label: result.label, text });
  return { text, warn, metas, failures: failed };
}

// ---- Store shape ----------------------------------------------------------

function skInitialState() {
  const location = readPref('skillsLocation', SK_DEFAULT_LOCATION);
  const workspacePref = readPref('skillsWorkspace', undefined);
  return {
    cwd: null,
    workspacePref: workspacePref === null || (typeof workspacePref === 'string' && workspacePref) ? workspacePref : undefined,
    location: SK_ROOT_IDS.includes(location) ? location : SK_DEFAULT_LOCATION,
    tab: 'installed',
    list: { status: 'idle', value: null, error: null, cwd: null },
    query: '',
    builtinOpen: false,
    view: { kind: 'list' },
    focus: null,
    detail: null,
    create: null,
    discard: false,
    discardNext: null,
    result: null,
    highlight: null,
    select: null,
    batch: null,
    repos: { status: 'idle', value: null, error: null },
    add: { source: '', status: 'idle', error: null, pending: null },
    checks: {},
    checkAll: null,
    repoResult: null,
    repoHighlight: null,
    repo: null,
  };
}

function skNewDetail(id, item) {
  return {
    id, status: 'loading', error: null, item: item ?? null, files: [], filesTotal: 0,
    original: null, draft: null, attempted: 0, saving: false, saveError: null, savedAt: 0,
    deleting: false, deleteError: null, confirmDelete: false,
    updating: false, updateError: null, updateNote: null, updatedAt: 0, confirmUpdate: false,
  };
}

function skNewCreate(template, location) {
  return { draft: skBlankDraft(template), template, location, attempted: 0, saving: false, error: null };
}

function skNewRepo(id, preview) {
  return {
    id, status: 'loading', error: null, preview: preview ?? null, value: null, autoChecked: false, checkError: null,
    filter: '', selected: {}, overwrite: {}, busy: null, actionError: null, modified: null,
    confirmRemove: false, removing: false, removeError: null, result: null, highlight: null,
  };
}

/** A selection map with `keys` set (on) or removed (off). */
function skToggle(selected, keys, on) {
  const next = { ...(selected || {}) };
  for (const key of skList(keys)) {
    if (on) next[key] = true;
    else delete next[key];
  }
  return next;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * Owns the Host calls and all page state (shape: skInitialState()).
 *   tab           'installed' | 'repos' — which list `view: { kind: 'list' }` shows
 *   view          list | detail{id} | create | repo{id}
 *   select        null, or { ids } while choosing skills to delete; `batch` is the open delete confirmation
 *   repos         repos-list state; `add` the add box (one add at a time, survives navigation)
 *   checks        repository ids with a repos-refresh in flight; `checkAll` the sequential check progress
 *   repoResult    result line on the repository list; `repoHighlight` a just-added row
 *   repo          the open repository page (skNewRepo)
 * Components read it through `props.useSkills(selector)`.
 */
function createSkillsController(ctx, t) {
  const rpc = createRpc(ctx, API_SKILLS);
  const store = createStore(skInitialState());
  const timers = new Set();
  const gen = { list: 0, detail: 0, repos: 0, repo: 0, add: 0 };
  /** repoId → the running repos-refresh, so a manual check joins an automatic one. */
  const inflight = new Map();
  let requested = false;
  let disposed = false;

  const get = () => store.getSnapshot();
  const update = (patch) => { if (!disposed) store.update(patch); };
  const later = (ms, fn) => {
    const timer = setTimeout(() => { timers.delete(timer); if (!disposed) fn(); }, ms);
    timers.add(timer);
  };
  const withCwd = (payload) => {
    const cwd = get().cwd;
    return cwd ? { ...payload, cwd } : payload;
  };
  const patchDetail = (id, patch) => update((s) => {
    if (!s.detail || s.detail.id !== id) return {};
    return { detail: { ...s.detail, ...(typeof patch === 'function' ? patch(s.detail) : patch) } };
  });
  const patchCreate = patch => update(s => (s.create ? { create: { ...s.create, ...(typeof patch === 'function' ? patch(s.create) : patch) } } : {}));
  const patchRepo = (id, patch) => update((s) => {
    if (!s.repo || s.repo.id !== id) return {};
    return { repo: { ...s.repo, ...(typeof patch === 'function' ? patch(s.repo) : patch) } };
  });

  /** New rows stay highlighted for a moment after the list that shows them arrives. */
  const armHighlight = () => {
    const highlight = get().highlight;
    if (!highlight || highlight.armed) return;
    update({ highlight: { ...highlight, armed: true } });
    later(SK_HIGHLIGHT_MS, () => {
      const current = get().highlight;
      if (current && current.id === highlight.id) update({ highlight: null });
    });
  };
  const armRepoHighlight = (id) => {
    const r = get().repo;
    if (!r || r.id !== id || !r.highlight || r.highlight.armed) return;
    const stamp = r.highlight.id;
    patchRepo(id, rr => ({ highlight: { ...rr.highlight, armed: true } }));
    later(SK_HIGHLIGHT_MS, () => patchRepo(id, rr => (rr.highlight && rr.highlight.id === stamp ? { highlight: null } : {})));
  };
  /** A just-added repository row flashes once the repository list is on screen with that row. */
  const armRepoListHighlight = () => {
    const s = get();
    const highlight = s.repoHighlight;
    if (!highlight || highlight.armed || s.tab !== 'repos' || s.view.kind !== 'list' || !s.repos.value) return;
    update({ repoHighlight: { ...highlight, armed: true } });
    later(SK_HIGHLIGHT_MS, () => {
      const current = get().repoHighlight;
      if (current && current.id === highlight.id) update({ repoHighlight: null });
    });
  };

  async function loadList() {
    const token = ++gen.list;
    const cwd = get().cwd;
    update(s => ({ list: { ...s.list, status: 'loading' } }));
    try {
      const value = await rpc('list', cwd ? { cwd } : {});
      if (disposed || token !== gen.list) return;
      update({ list: { status: 'ready', value: skNormalizeListing(value), error: null, cwd } });
    } catch (error) {
      if (disposed || token !== gen.list) return;
      update(s => ({ list: { ...s.list, status: 'error', error: skErr(error) } }));
    }
    armHighlight();
  }

  /** Read one skill; `quiet` keeps what is on screen if the read fails and never replaces a dirty draft. */
  async function loadDetail(id, quiet) {
    const token = ++gen.detail;
    if (!quiet) patchDetail(id, { status: 'loading', error: null });
    try {
      const value = await rpc('read', withCwd({ id }));
      if (disposed || token !== gen.detail) return;
      const fresh = skDraftFromRead(value);
      patchDetail(id, (d) => {
        const keep = d.draft && d.original && skDraftDirty(d.draft, d.original);
        const files = Array.isArray(value.files) ? value.files : [];
        return {
          status: 'ready', error: null, item: value.item || d.item, files,
          filesTotal: typeof value.filesTotal === 'number' ? value.filesTotal : files.length,
          original: keep ? d.original : fresh, draft: keep ? d.draft : fresh,
        };
      });
    } catch (error) {
      if (disposed || token !== gen.detail) return;
      patchDetail(id, d => (quiet && d.draft ? {} : { status: 'error', error: skErr(error) }));
    }
  }

  /** The repository list keeps its rows while reloading, so counts update in place. */
  async function loadRepos() {
    const token = ++gen.repos;
    const cwd = get().cwd;
    update(s => ({ repos: { ...s.repos, status: 'loading' } }));
    try {
      const value = await rpc('repos-list', cwd ? { cwd } : {});
      if (disposed || token !== gen.repos) return;
      update({ repos: { status: 'ready', value: skList(value && value.repositories), error: null } });
      armRepoListHighlight();
    } catch (error) {
      if (disposed || token !== gen.repos) return;
      update(s => ({ repos: { ...s.repos, status: 'error', error: skErr(error) } }));
    }
  }

  /** Read the open repository from the cache; a stale or missing cache starts one background check. */
  async function loadRepo(id, quiet) {
    const token = ++gen.repo;
    if (!quiet) patchRepo(id, { status: 'loading', error: null });
    try {
      const value = await rpc('repos-get', withCwd({ id }));
      if (disposed || token !== gen.repo) return;
      patchRepo(id, { status: 'ready', error: null, value: skNormalizeRepoDetail(value) });
      armRepoHighlight(id);
      maybeAutoCheck(id);
    } catch (error) {
      if (disposed || token !== gen.repo) return;
      patchRepo(id, r => (quiet && r.value ? {} : { status: 'error', error: skErr(error) }));
    }
  }

  function maybeAutoCheck(id) {
    const r = get().repo;
    if (!r || r.id !== id || r.autoChecked || !r.value) return;
    if (!skNeedsCheck(r.value, Date.now())) return;
    patchRepo(id, { autoChecked: true });
    void refreshRepo(id, false);
  }

  /**
   * repos-refresh one repository. The open page takes the fresh detail; a failure is kept as `checkError`
   * and as the repository's lastError. Unless part of a batch, the lists reload afterwards.
   */
  function refreshRepo(id, batch) {
    if (inflight.has(id)) return inflight.get(id);
    const run = (async () => {
      update(s => ({ checks: { ...s.checks, [id]: true } }));
      patchRepo(id, { checkError: null });
      try {
        const value = await rpc('repos-refresh', withCwd({ id }));
        if (disposed) return { ok: false, error: null };
        // A repos-get for this page that started before the refresh finished would show the old cache.
        if (get().repo && get().repo.id === id) gen.repo += 1;
        patchRepo(id, { status: 'ready', error: null, value: skNormalizeRepoDetail(value), checkError: null });
        return { ok: true, error: null };
      } catch (error) {
        if (disposed) return { ok: false, error: null };
        const err = skErr(error);
        patchRepo(id, r => ({
          checkError: err,
          value: r.value && r.value.repository
            ? { ...r.value, repository: { ...r.value.repository, lastError: err.message || r.value.repository.lastError } }
            : r.value,
        }));
        return { ok: false, error: err };
      } finally {
        inflight.delete(id);
        update((s) => {
          if (!s.checks[id]) return {};
          const checks = { ...s.checks };
          delete checks[id];
          return { checks };
        });
      }
    })();
    inflight.set(id, run);
    if (!batch) {
      void run.then(() => {
        if (disposed) return;
        void loadRepos();
        void loadList();
      });
    }
    return run;
  }

  /** Open a repository page; `detail` (from repos-add) shows at once while the cwd-specific copy loads. */
  function showRepo(id, detail) {
    const s = get();
    const keep = s.repo && s.repo.id === id ? s.repo : null;
    const preview = skList(s.repos.value).find(repo => repo.id === id) || (detail && detail.repository) || null;
    let repo = keep ?? skNewRepo(id, preview);
    if (detail && detail.repository) repo = { ...repo, status: 'ready', error: null, value: detail };
    update({ tab: 'repos', select: null, batch: null, view: { kind: 'repo', id }, focus: null, repo });
    void loadRepo(id, Boolean(repo.value));
  }

  async function addRepo(request) {
    if (get().add.status === 'adding') return;
    const token = ++gen.add;
    update(s => ({ add: { ...s.add, status: 'adding', error: null, pending: request }, repoResult: null }));
    try {
      const value = await rpc('repos-add', withCwd(request.subpath ? { source: request.source, subpath: request.subpath } : { source: request.source }));
      if (disposed || token !== gen.add) return;
      const detail = skNormalizeRepoDetail(value);
      const repository = detail.repository;
      if (!repository || !repository.id) throw new CallError('internal', 'No repository in the response');
      update(s => ({
        add: { source: request.typed && s.add.source.trim() === request.source ? '' : s.add.source, status: 'idle', error: null, pending: null },
      }));
      void loadRepos();
      const s = get();
      // Still looking at the repository list: go straight to the new page. Elsewhere, leave a note instead
      // of pulling the user away from what they moved on to.
      if (s.tab === 'repos' && s.view.kind === 'list') {
        showRepo(repository.id, detail);
      } else {
        const at = Date.now();
        update({
          repoResult: { kind: value && value.existing ? 'existing' : 'added', label: repository.label ?? '', id: repository.id, at },
          repoHighlight: { id: at, repoId: repository.id, armed: false },
        });
      }
    } catch (error) {
      if (disposed || token !== gen.add) return;
      update(s => ({ add: { ...s.add, status: 'error', error: skErr(error), pending: null } }));
    }
  }

  /** Back to the list of the view's tab, dropping the view's state; focus returns to whatever opened it. */
  function leave() {
    const s = get();
    const view = s.view;
    const focus = view.kind === 'detail' ? { kind: 'row', id: view.id }
      : view.kind === 'create' ? { kind: 'new' }
        : view.kind === 'repo' ? { kind: 'repo', id: view.id } : null;
    if (view.kind === 'detail') gen.detail += 1;
    if (view.kind === 'repo') gen.repo += 1;
    update({
      view: { kind: 'list' }, focus, discard: false, discardNext: null,
      tab: view.kind === 'repo' ? 'repos' : view.kind === 'list' ? s.tab : 'installed',
      detail: view.kind === 'detail' ? null : s.detail,
      create: view.kind === 'create' ? null : s.create,
      repo: view.kind === 'repo' ? null : s.repo,
    });
    armRepoListHighlight();
  }

  /** Leave the skill page for a repository page (from the origin banner). */
  function goRepo(id) {
    gen.detail += 1;
    update({ detail: null, discard: false, discardNext: null });
    showRepo(id, null);
  }

  async function runSkillUpdate(force) {
    const d = get().detail;
    const item = d && d.item;
    const origin = item && item.origin;
    if (!origin || d.updating) return;
    const id = d.id;
    const path = item.dir || skStripSkillFile(item.path);
    patchDetail(id, { updating: true, updateError: null, updateNote: null, updatedAt: 0 });
    try {
      const value = await rpc('repos-update', withCwd({ id: origin.repoId, items: [{ path, force: Boolean(force) }] }));
      if (disposed) return;
      const failed = skList(value && value.failed).map(skFailEntry);
      const skippedModified = skList(value && value.skipped).some(entry => entry && entry.reason === 'modified');
      if (failed.length) {
        const reason = failed[0].error;
        patchDetail(id, { updating: false, updateError: reason === 'forbidden' ? { code: 'forbidden', message: '' } : { code: 'failed', message: reason } });
      } else {
        const stamp = skippedModified ? 0 : Date.now();
        patchDetail(id, { updating: false, confirmUpdate: false, updateNote: skippedModified ? 'modified' : null, updatedAt: stamp });
        if (stamp) later(SK_UPDATED_MS, () => patchDetail(id, dd => (dd.updatedAt === stamp ? { updatedAt: 0 } : {})));
      }
      void loadList();
      void loadRepos();
      // The editor is clean (updating is blocked while dirty), so the quiet read shows the new content.
      void loadDetail(id, true);
    } catch (error) {
      patchDetail(id, { updating: false, updateError: skErr(error) });
    }
  }

  /** After install / update: the result line and highlight go to the open page, or to the list when the user left. */
  function finishRepoAction(id, label, result, keys) {
    const s = get();
    if (s.repo && s.repo.id === id) {
      patchRepo(id, {
        busy: null, modified: null, selected: {}, overwrite: {}, result,
        highlight: keys.length ? { id: result.at, keys, armed: false } : null,
      });
      void loadRepo(id, true);
    } else {
      update({ repoResult: { ...result, label } });
    }
    void loadRepos();
    void loadList();
  }

  const updatePick = (r, scope) => (scope === 'all' ? () => true : skill => Boolean(r.selected[skill.key]));
  /** Install and update copy from the cache, which a running repos-refresh is rewriting. */
  const repoActionable = r => Boolean(r && r.value && !r.busy && !r.removing && !get().checks[r.id]);

  function startRepoUpdate(scope) {
    const r = get().repo;
    if (!repoActionable(r)) return;
    const plan = skRepoUpdatePlan(r.value.skills, updatePick(r, scope));
    if (!plan.rows) return;
    if (plan.modifiedRows) {
      patchRepo(r.id, { modified: { scope, names: plan.modifiedNames, rows: plan.rows }, actionError: null });
      return;
    }
    void runRepoUpdate(scope, undefined);
  }

  async function runRepoUpdate(scope, mode) {
    const r = get().repo;
    if (!repoActionable(r)) {
      if (r && r.modified) patchRepo(r.id, { modified: null });
      return;
    }
    const id = r.id;
    const skills = r.value.skills;
    const label = r.value.repository ? r.value.repository.label : '';
    const plan = skRepoUpdatePlan(skills, updatePick(r, scope), mode);
    if (!plan.items.length) {
      patchRepo(id, { modified: null });
      return;
    }
    patchRepo(id, { busy: 'update', modified: null, actionError: null, result: null });
    try {
      const value = await rpc('repos-update', withCwd({ id, items: plan.items }));
      if (disposed) return;
      const entries = skList(value && value.updated);
      const updated = skUnique(entries.map(skEntryName));
      const skipped = [
        ...skList(value && value.skipped).map(skSkipEntry),
        ...plan.skippedNames.map(name => ({ name, reason: 'modified' })),
      ];
      const result = { kind: 'update', updated, skipped, failed: skList(value && value.failed).map(skFailEntry), at: Date.now() };
      const paths = new Set(entries.map(entry => entry && entry.path).filter(Boolean));
      const keys = skills
        .filter(skill => skList(skill.installs).some(copy => paths.has(copy.path)) || updated.includes(skill.name))
        .map(skill => skill.key);
      finishRepoAction(id, label, result, keys);
    } catch (error) {
      if (disposed) return;
      patchRepo(id, { busy: null, actionError: { ...skErr(error), action: 'update' } });
    }
  }

  function setLocation(root) {
    if (!SK_ROOT_IDS.includes(root)) return;
    writePref('skillsLocation', root);
    update(s => ({ location: root, create: s.create ? { ...s.create, location: root } : s.create }));
  }

  /** Revalidate everything already on screen (page reopened or connection reset). */
  function revalidate() {
    void loadList();
    void loadRepos();
    const s = get();
    if (s.view.kind === 'detail' && s.detail) void loadDetail(s.detail.id, true);
    if (s.view.kind === 'repo' && s.repo) void loadRepo(s.repo.id, true);
  }

  const face = {
    hooks: { skills: store },

    /** The page mounted: close leftover dialogs and selection, and revalidate what was already loaded. */
    activate() {
      update(s => ({
        discard: false,
        discardNext: null,
        select: s.batch && s.batch.deleting ? s.select : null,
        batch: s.batch && s.batch.deleting ? s.batch : null,
        detail: s.detail && !s.detail.deleting && !s.detail.updating ? { ...s.detail, confirmDelete: false, confirmUpdate: false } : s.detail,
        repo: s.repo && !s.repo.removing ? { ...s.repo, confirmRemove: false, modified: null } : s.repo,
      }));
      if (requested) revalidate();
    },
    /** The component resolved which workspace to list (null = none); the first call starts loading. */
    setCwd(path) {
      const next = typeof path === 'string' && path ? path : null;
      if (requested && next === get().cwd) return;
      const first = !requested;
      requested = true;
      update({ cwd: next });
      void loadList();
      void loadRepos();
      // Local copies of repository skills depend on the project, so an open repository page rereads them.
      const s = get();
      if (!first && s.view.kind === 'repo' && s.repo) void loadRepo(s.repo.id, true);
    },
    pickWorkspace(value) {
      const pref = value === SK_NO_PROJECT ? null : String(value);
      writePref('skillsWorkspace', pref);
      update({ workspacePref: pref });
    },
    retry() { void loadList(); },
    setQuery(query) { update({ query: String(query ?? '') }); },
    toggleBuiltin(open) { update(s => ({ builtinOpen: typeof open === 'boolean' ? open : !s.builtinOpen })); },
    consumeFocus() { if (get().focus) update({ focus: null }); },
    dismissResult() { update({ result: null, highlight: null }); },

    setTab(tab) {
      if (!SK_TABS.includes(tab)) return;
      const s = get();
      if (s.view.kind !== 'list' || (s.tab === tab && !s.select)) return;
      update({ tab, select: null, batch: null });
      armRepoListHighlight();
    },
    /** From the empty state: show the repository tab with the add box focused. */
    browseRepos() {
      if (get().view.kind !== 'list') return;
      update({ tab: 'repos', select: null, batch: null, focus: { kind: 'repo-source' } });
      armRepoListHighlight();
    },

    // ---- 已安装: multi-select delete ----
    startSelect() {
      const s = get();
      if (s.view.kind !== 'list' || s.tab !== 'installed' || s.select) return;
      update({ select: { ids: {} }, batch: null, focus: { kind: 'select-all' } });
    },
    cancelSelect() {
      const s = get();
      if (!s.select || (s.batch && s.batch.deleting)) return;
      update({ select: null, batch: null, focus: { kind: 'select' } });
    },
    toggleSelect(id, on) {
      const s = get();
      const item = skFindItem(s.list.value, id);
      if (!s.select || !item || !item.editable) return;
      update(st => (st.select ? { select: { ids: skToggle(st.select.ids, [id], on) } } : {}));
    },
    selectIds(ids, on) {
      const s = get();
      if (!s.select) return;
      const allowed = skList(ids).filter((id) => {
        const item = skFindItem(s.list.value, id);
        return item && item.editable;
      });
      update(st => (st.select ? { select: { ids: skToggle(st.select.ids, allowed, on) } } : {}));
    },
    requestBatchDelete() {
      const s = get();
      if (!s.select || s.batch) return;
      if (!skSelectedForDelete(s.list.value, s.query, s.select.ids).length) return;
      update({ batch: { deleting: false, error: null } });
    },
    cancelBatchDelete() {
      const s = get();
      if (s.batch && !s.batch.deleting) update({ batch: null });
    },
    async confirmBatchDelete() {
      const s = get();
      if (!s.select || !s.batch || s.batch.deleting) return;
      const items = skSelectedForDelete(s.list.value, s.query, s.select.ids);
      if (!items.length) {
        update({ batch: null });
        return;
      }
      update(st => ({ batch: { ...st.batch, deleting: true, error: null } }));
      try {
        const value = await rpc('delete', withCwd({ ids: items.map(item => item.id) }));
        if (disposed) return;
        const removed = skList(value && value.removed).map(skEntryName);
        const failed = skList(value && value.failed).map(skFailEntry);
        update({
          batch: null, select: null, focus: { kind: 'select' }, highlight: null,
          result: { kind: 'delete', removed, failed, at: Date.now() },
        });
        void loadList();
        void loadRepos();
      } catch (error) {
        update(st => (st.batch ? { batch: { ...st.batch, deleting: false, error: skErr(error) } } : {}));
      }
    },

    // ---- Skill detail / create ----
    openDetail(id) {
      const s = get();
      const keep = s.detail && s.detail.id === id && s.detail.draft;
      update({
        view: { kind: 'detail', id }, tab: 'installed', focus: null, select: null, batch: null,
        detail: keep ? s.detail : skNewDetail(id, skFindItem(s.list.value, id)),
      });
      void loadDetail(id, Boolean(keep));
    },
    retryDetail() {
      const d = get().detail;
      if (d) void loadDetail(d.id, false);
    },
    openCreate() {
      const s = get();
      const template = t('sk_bodyTemplate');
      update({ view: { kind: 'create' }, tab: 'installed', focus: null, select: null, batch: null, create: s.create ?? skNewCreate(template, s.location) });
    },
    /** Back to the list; a dirty editor asks first. */
    back() {
      const s = get();
      if (s.view.kind === 'detail' && s.detail && skDraftDirty(s.detail.draft, s.detail.original)) {
        update({ discard: true, discardNext: null });
        return;
      }
      if (s.view.kind === 'create' && s.create && skDraftDirty(s.create.draft, skBlankDraft(s.create.template))) {
        update({ discard: true, discardNext: null });
        return;
      }
      leave();
    },
    confirmDiscard() {
      const next = get().discardNext;
      if (next && next.kind === 'repo') goRepo(next.id);
      else leave();
    },
    cancelDiscard() { update({ discard: false, discardNext: null }); },

    setDetailField(field, value) {
      const d = get().detail;
      if (!d || !d.draft || !d.item || !d.item.editable) return;
      patchDetail(d.id, dd => ({ draft: { ...dd.draft, [field]: value }, savedAt: 0 }));
    },
    revertDetail() {
      const d = get().detail;
      if (d && d.original) patchDetail(d.id, dd => ({ draft: dd.original, attempted: 0, saveError: null }));
    },
    async saveDetail() {
      const d = get().detail;
      if (!d || !d.draft || !d.item || !d.item.editable || d.saving || d.updating) return;
      if (!skDraftDirty(d.draft, d.original)) return;
      if (!d.draft.description.trim()) {
        patchDetail(d.id, dd => ({ attempted: dd.attempted + 1 }));
        return;
      }
      const id = d.id;
      const submitted = d.draft;
      patchDetail(id, { saving: true, saveError: null, savedAt: 0 });
      try {
        const result = await rpc('save', withCwd({ target: { create: false, id }, ...skSavePayload(submitted, d.original.name) }));
        if (disposed) return;
        const stamp = Date.now();
        const nextId = result && result.item && result.item.id ? result.item.id : id;
        patchDetail(id, dd => ({ id: nextId, saving: false, item: (result && result.item) || dd.item, original: submitted, attempted: 0, savedAt: stamp }));
        if (nextId !== id) update(s => (s.view.kind === 'detail' && s.view.id === id ? { view: { kind: 'detail', id: nextId } } : {}));
        later(SK_SAVED_MS, () => patchDetail(nextId, dd => (dd.savedAt === stamp ? { savedAt: 0 } : {})));
        void loadList();
        void loadRepos();
        void loadDetail(nextId, true);
      } catch (error) {
        patchDetail(id, { saving: false, saveError: skErr(error) });
      }
    },
    requestDelete() {
      const d = get().detail;
      if (d && d.item && d.item.editable) patchDetail(d.id, { confirmDelete: true, deleteError: null });
    },
    cancelDelete() {
      const d = get().detail;
      if (d && !d.deleting) patchDetail(d.id, { confirmDelete: false, deleteError: null });
    },
    async confirmDelete() {
      const d = get().detail;
      if (!d || !d.item || d.deleting) return;
      const id = d.id;
      patchDetail(id, { deleting: true, deleteError: null });
      try {
        const value = await rpc('delete', withCwd({ ids: [id] }));
        if (disposed) return;
        const failure = skList(value && value.failed)[0];
        if (failure) {
          patchDetail(id, { deleting: false, deleteError: { code: 'failed', message: skFailEntry(failure).error } });
          return;
        }
        gen.detail += 1;
        update(s => ({
          detail: null, focus: { kind: 'search' },
          view: s.view.kind === 'detail' && s.view.id === id ? { kind: 'list' } : s.view,
        }));
        void loadList();
        void loadRepos();
      } catch (error) {
        patchDetail(id, { deleting: false, deleteError: skErr(error) });
      }
    },

    /** Origin banner: 「查看仓库」 opens the repository page (a dirty editor asks first). */
    viewRepo() {
      const s = get();
      const d = s.detail;
      const origin = d && d.item && d.item.origin;
      if (!origin || !origin.repoId) return;
      if (s.view.kind === 'detail' && skDraftDirty(d.draft, d.original)) {
        update({ discard: true, discardNext: { kind: 'repo', id: origin.repoId } });
        return;
      }
      goRepo(origin.repoId);
    },
    /** Origin banner: 「更新」; a locally modified skill asks first, a dirty editor cannot update. */
    requestSkillUpdate() {
      const d = get().detail;
      const origin = d && d.item && d.item.origin;
      if (!origin || !origin.updateAvailable || d.updating || d.saving) return;
      if (skDraftDirty(d.draft, d.original)) return;
      if (origin.modified) {
        patchDetail(d.id, { confirmUpdate: true, updateError: null, updateNote: null });
        return;
      }
      void runSkillUpdate(false);
    },
    cancelSkillUpdate() {
      const d = get().detail;
      if (d && !d.updating) patchDetail(d.id, { confirmUpdate: false, updateError: null });
    },
    confirmSkillUpdate() { void runSkillUpdate(true); },

    setCreateField(field, value) {
      patchCreate(c => ({ draft: { ...c.draft, [field]: value } }));
    },
    setCreateLocation: setLocation,
    setLocation,
    async submitCreate() {
      const s = get();
      const c = s.create;
      if (!c || c.saving) return;
      const listing = s.list.value;
      const location = skEffectiveLocation(c.location, skHasProject(listing));
      const problems = skCreateProblems(c.draft, listing ? listing.skills : [], location);
      if (problems.name || problems.description) {
        patchCreate(cc => ({ attempted: cc.attempted + 1 }));
        return;
      }
      const draft = c.draft;
      patchCreate({ saving: true, error: null });
      try {
        const result = await rpc('save', withCwd({ target: { create: true, root: location }, ...skSavePayload(draft, draft.name) }));
        if (disposed) return;
        const item = result.item;
        writePref('skillsLocation', location);
        update({
          create: null, location, focus: null,
          view: { kind: 'detail', id: item.id },
          detail: { ...skNewDetail(item.id, item), status: 'ready', original: draft, draft },
        });
        void loadList();
        void loadDetail(item.id, true);
      } catch (error) {
        patchCreate(cc => ({ saving: false, error: { ...skErr(error), name: draft.name }, attempted: cc.attempted + 1 }));
      }
    },

    // ---- 技能仓库: list ----
    retryRepos() { void loadRepos(); },
    setAddSource(source) {
      update(s => (s.add.status === 'adding' ? {} : { add: { ...s.add, source: String(source ?? ''), status: 'idle', error: null } }));
    },
    addRepo() {
      const source = get().add.source.trim();
      if (source) void addRepo({ source, typed: true });
    },
    addSuggestion(suggestion) {
      if (!suggestion || !suggestion.source) return;
      void addRepo({ source: suggestion.source, subpath: suggestion.subpath, label: suggestion.label });
    },
    dismissRepoResult() { update({ repoResult: null, repoHighlight: null }); },
    /** Refresh every repository in turn, then report how many skills have updates. */
    async checkAll() {
      const s = get();
      if (s.checkAll) return;
      const repos = skList(s.repos.value).map(repo => ({ id: repo.id, label: repo.label ?? repo.id }));
      if (!repos.length) return;
      update({ checkAll: { done: 0, total: repos.length }, repoResult: null });
      const failed = [];
      for (let index = 0; index < repos.length; index += 1) {
        update({ checkAll: { done: index, total: repos.length } });
        const outcome = await refreshRepo(repos[index].id, true);
        if (disposed) return;
        if (!outcome.ok) failed.push({ name: repos[index].label, error: outcome.error ? outcome.error.message : '' });
      }
      await loadRepos();
      if (disposed) return;
      void loadList();
      update(st => ({ checkAll: null, repoResult: { kind: 'check', updates: skUpdateCount(st.repos.value), failed, at: Date.now() } }));
    },

    // ---- 技能仓库: one repository ----
    openRepo(id) {
      if (typeof id === 'string' && id) showRepo(id, null);
    },
    retryRepo() {
      const r = get().repo;
      if (r) void loadRepo(r.id, false);
    },
    checkRepo() {
      const r = get().repo;
      if (r) void refreshRepo(r.id, false);
    },
    setRepoFilter(filter) {
      const r = get().repo;
      if (r) patchRepo(r.id, { filter: String(filter ?? '') });
    },
    toggleRepoSkill(key, on) {
      const r = get().repo;
      if (r && !r.busy) patchRepo(r.id, rr => ({ selected: skToggle(rr.selected, [key], on) }));
    },
    selectRepoSkills(keys, on) {
      const r = get().repo;
      if (r && !r.busy) patchRepo(r.id, rr => ({ selected: skToggle(rr.selected, keys, on) }));
    },
    setRepoOverwrite(key, on) {
      const r = get().repo;
      if (r && !r.busy) patchRepo(r.id, rr => ({ overwrite: { ...rr.overwrite, [key]: Boolean(on) } }));
    },
    dismissRepoDetailResult() {
      const r = get().repo;
      if (r) patchRepo(r.id, { result: null, highlight: null });
    },
    async installSelected() {
      const s = get();
      const r = s.repo;
      if (!repoActionable(r)) return;
      const listing = s.list.value;
      const root = skEffectiveLocation(s.location, skHasProject(listing));
      const plan = skRepoInstallPlan(r.value.skills, r.selected, r.overwrite, root);
      if (!plan.install) return;
      const id = r.id;
      const skills = r.value.skills;
      const label = r.value.repository ? r.value.repository.label : '';
      patchRepo(id, { busy: 'install', actionError: null, result: null });
      try {
        const value = await rpc('repos-install', withCwd({ id, root, items: plan.items }));
        if (disposed) return;
        const installed = skUnique(skList(value && value.installed).map(skEntryName));
        const skipped = skList(value && value.skipped).map(skSkipEntry);
        const result = {
          kind: 'install', installed, skipped, failed: skList(value && value.failed).map(skFailEntry), root, at: Date.now(),
          // Judged against the listing the user saw while choosing; same-root copies never count.
          ...skInstallRelations(installed, listing ? listing.skills : [], root, listing ? listing.roots : []),
        };
        writePref('skillsLocation', root);
        update({ location: root });
        const changed = new Set([...installed, ...skipped.filter(entry => entry.reason === 'identical').map(entry => entry.name)]);
        finishRepoAction(id, label, result, skills.filter(skill => changed.has(skill.name)).map(skill => skill.key));
      } catch (error) {
        if (disposed) return;
        patchRepo(id, { busy: null, actionError: { ...skErr(error), action: 'install' } });
      }
    },
    updateSelected() { startRepoUpdate('selected'); },
    updateAll() { startRepoUpdate('all'); },
    /** The 3-button confirmation for locally changed skills: 'force' | 'skip' | 'cancel'. */
    resolveModified(choice) {
      const r = get().repo;
      if (!r || !r.modified || r.busy) return;
      if (choice === 'force' || choice === 'skip') void runRepoUpdate(r.modified.scope, choice);
      else patchRepo(r.id, { modified: null });
    },
    requestRemoveRepo() {
      const r = get().repo;
      if (r && !r.busy) patchRepo(r.id, { confirmRemove: true, removeError: null });
    },
    cancelRemoveRepo() {
      const r = get().repo;
      if (r && !r.removing) patchRepo(r.id, { confirmRemove: false, removeError: null });
    },
    async confirmRemoveRepo() {
      const r = get().repo;
      if (!r || r.removing) return;
      const id = r.id;
      const repository = (r.value && r.value.repository) || r.preview;
      const label = repository ? repository.label : '';
      patchRepo(id, { removing: true, removeError: null });
      try {
        await rpc('repos-remove', { id });
        if (disposed) return;
        gen.repo += 1;
        update(s => ({
          repo: null,
          view: s.view.kind === 'repo' && s.view.id === id ? { kind: 'list' } : s.view,
          tab: s.view.kind === 'repo' && s.view.id === id ? 'repos' : s.tab,
          focus: { kind: 'repo-source' },
          repoResult: { kind: 'removed', label, at: Date.now() },
          repoHighlight: null,
        }));
        void loadRepos();
        void loadList();
      } catch (error) {
        patchRepo(id, { removing: false, removeError: skErr(error) });
      }
    },
  };

  return {
    face,
    refresh() {
      if (requested) revalidate();
    },
    dispose() {
      disposed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function SkillsSectionIcon({ size }) {
  return Icon.book(size || 16);
}

function skIconBranch(size) {
  return svg(size, [
    h('circle', { key: 'a', cx: 5, cy: 3.75, r: 1.5 }),
    h('circle', { key: 'b', cx: 5, cy: 12.25, r: 1.5 }),
    h('circle', { key: 'c', cx: 11, cy: 5.25, r: 1.5 }),
    h('path', { key: 'd', d: 'M5 5.25v5.5M11 6.75c0 2.6-2.2 3.4-6 4' }),
  ]);
}

function skIconExternal(size) {
  return svg(size, [
    h('path', { key: 'a', d: 'M9.5 2.75h3.75V6.5M13.25 2.75L7.75 8.25' }),
    h('path', { key: 'b', d: 'M11.75 9.5v2.75a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1H6.5' }),
  ]);
}

function skIconSelect(size) {
  return svg(size, [
    h('rect', { key: 'r', x: 2.75, y: 2.75, width: 10.5, height: 10.5, rx: 2.25 }),
    h('path', { key: 'p', d: 'M5.5 8.25l1.75 1.75 3.25-4' }),
  ]);
}

/** First letter upper-cased (English meta lines that may start with a lowercase fragment). */
function skSentence(text) {
  const value = String(text ?? '');
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/** A native dialog or an open popover menu owns Escape. */
function skOverlayOpen(event) {
  const doc = (event.target && event.target.ownerDocument) || document;
  if (doc.querySelector('dialog[open]')) return true;
  try {
    if (doc.querySelector(':popover-open')) return true;
  } catch { /* :popover-open unsupported: popovers are not in use either */ }
  return false;
}

function SkillsSection(props) {
  const { t } = props;
  const state = props.useSkills(skIdentity);
  const workspaceState = typeof props.useWorkspaces === 'function' ? props.useWorkspaces(skIdentity) : null;
  const workspaces = useMemo(() => skWorkspaceItems(workspaceState), [workspaceState]);
  const [waited, setWaited] = useState(false);
  const phase = workspaceState && workspaceState.phase !== 'ready' && !waited ? 'pending' : 'ready';
  const resolved = skResolveWorkspace(state.workspacePref, workspaces, phase);

  useEffect(() => { props.activate(); }, []);
  useEffect(() => {
    // A workspace list that never settles must not keep the page empty.
    if (resolved.ready) return undefined;
    const timer = setTimeout(() => setWaited(true), SK_WORKSPACE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [resolved.ready]);
  useEffect(() => { if (resolved.ready) props.setCwd(resolved.path); }, [resolved.ready, resolved.path]);

  const view = state.view;
  let body;
  let viewKey = view.kind;
  if (view.kind === 'detail') {
    body = h(SkillDetailView, { face: props, state, t });
    viewKey = `detail:${view.id}`;
  } else if (view.kind === 'create') {
    body = h(SkillCreateView, { face: props, state, t });
  } else if (view.kind === 'repo') {
    body = h(SkillRepoView, { face: props, state, t });
    viewKey = `repo:${view.id}`;
  } else {
    body = h(SkillListView, { face: props, state, t, workspaces, resolved });
  }

  return h('div', { className: `${PREFIX}-root` },
    h(Styles),
    h(ViewFrame, { viewKey }, body),
    h(ConfirmDialog, {
      open: state.discard,
      title: t('sk_discardTitle'),
      body: t('sk_discardBody'),
      confirmLabel: t('sk_discard'),
      cancelLabel: t('sk_keepEditing'),
      danger: true,
      onConfirm: props.confirmDiscard,
      onCancel: props.cancelDiscard,
    }),
    h(SkillDeleteDialog, { face: props, state, t }),
    h(SkillBatchDeleteDialog, { face: props, state, t }),
    h(SkillUpdateDialog, { face: props, state, t }),
    h(SkillModifiedDialog, { face: props, state, t }),
    h(SkillRemoveRepoDialog, { face: props, state, t }));
}

// ---- List: header, tabs, focus restore -------------------------------------

function skFocusTarget(container, focus) {
  if (focus.kind === 'row') {
    return [...container.querySelectorAll('[data-sk-row]')].find(node => node.dataset.skRow === focus.id) ?? null;
  }
  if (focus.kind === 'repo') {
    return [...container.querySelectorAll('[data-sk-repo]')].find(node => node.dataset.skRepo === focus.id) ?? null;
  }
  if (focus.kind === 'search') return container.querySelector('input[type="search"]');
  return container.querySelector(`[data-sk-focus="${focus.kind}"]`);
}

function SkillListView({ face, state, t, workspaces, resolved }) {
  const rootRef = useRef(null);
  const uid = useId().replace(/:/g, '');
  const ready = state.tab === 'repos' ? Boolean(state.repos.value) : Boolean(state.list.value);

  useEffect(() => {
    const focus = state.focus;
    const node = rootRef.current;
    if (!focus || !node) return;
    if ((focus.kind === 'row' || focus.kind === 'repo') && !ready) return;
    const target = skFocusTarget(node, focus);
    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView?.({ block: 'nearest' });
    }
    face.consumeFocus();
  }, [state.focus, ready, state.tab, Boolean(state.select)]);

  return h('div', { ref: rootRef, className: `${PREFIX}-sk-stack` },
    h(PageHeader, { title: t('sk_title'), intro: t('sk_intro') }),
    h(SkillTabs, { value: state.tab, onChange: face.setTab, badge: skUpdateCount(state.repos.value), t, uid }),
    h('div', {
      key: state.tab, role: 'tabpanel', id: `${uid}-panel`, 'aria-labelledby': `${uid}-tab-${state.tab}`,
      className: `${PREFIX}-sk-panel`,
    },
    state.tab === 'repos'
      ? h(SkillRepoList, { face, state, t })
      : h(SkillInstalledPanel, { face, state, t, workspaces, resolved })));
}

/** 已安装 | 技能仓库: core Segmented visuals with tab semantics (automatic activation, arrows / Home / End). */
function SkillTabs({ value, onChange, badge, t, uid }) {
  const refs = useRef([]);
  const tabs = [
    { value: 'installed', label: t('sk_tabInstalled'), badge: 0 },
    { value: 'repos', label: t('sk_tabRepos'), badge },
  ];
  const index = Math.max(0, tabs.findIndex(tab => tab.value === value));
  const move = (event, next) => {
    event.preventDefault();
    event.stopPropagation();
    refs.current[next]?.focus();
    onChange(tabs[next].value);
  };
  return h('div', {
    role: 'tablist', 'aria-label': t('sk_title'), className: cx(`${PREFIX}-seg`, `${PREFIX}-sk-tabs`),
    style: { '--seg-count': tabs.length, '--seg-index': index },
  },
  h('span', { className: `${PREFIX}-seg-indicator`, 'aria-hidden': true }),
  tabs.map((tab, i) => {
    const selected = tab.value === value;
    return h('button', {
      key: tab.value, ref: (node) => { refs.current[i] = node; }, type: 'button', role: 'tab',
      id: `${uid}-tab-${tab.value}`, 'aria-selected': String(selected), 'aria-controls': `${uid}-panel`,
      tabIndex: selected ? 0 : -1, className: `${PREFIX}-seg-item`, 'data-sk-focus': `tab-${tab.value}`,
      onClick: () => { if (!selected) onChange(tab.value); },
      onKeyDown: (event) => {
        if (event.key === 'ArrowRight') move(event, (i + 1) % tabs.length);
        else if (event.key === 'ArrowLeft') move(event, (i - 1 + tabs.length) % tabs.length);
        else if (event.key === 'Home') move(event, 0);
        else if (event.key === 'End') move(event, tabs.length - 1);
      },
    },
    h('span', null, tab.label),
    tab.badge > 0
      ? h(Fragment, null,
        h('span', { className: `${PREFIX}-sk-tab-badge`, 'aria-hidden': true }, String(tab.badge)),
        h('span', { className: `${PREFIX}-visually-hidden` }, `, ${skCount(t, 'sk_tabBadge', tab.badge)}`))
      : null);
  }));
}

// ---- 已安装 -----------------------------------------------------------------

function SkillInstalledPanel({ face, state, t, workspaces, resolved }) {
  const listing = state.list.value;
  const hasValue = Boolean(listing);
  const select = state.select;
  const selecting = Boolean(select);
  const groups = useMemo(
    () => skGroupSkills(listing ? listing.skills : [], listing ? listing.roots : [], state.query),
    [listing, state.query],
  );

  useEffect(() => {
    // Escape leaves selection mode before the Settings layer sees it (it ignores prevented keys);
    // an open dialog or menu keeps Escape for itself.
    if (!selecting) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing
        || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
      if (skOverlayOpen(event)) return;
      event.preventDefault();
      face.cancelSelect();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [selecting]);

  const searching = state.query.trim() !== '';
  const own = groups.filter(group => group.scope !== 'builtin').reduce((sum, group) => sum + group.total, 0);
  const shown = groups.filter(group => group.items.length > 0);
  const home = skHomeFrom(listing ? listing.roots : []);
  const projectName = resolved.workspace ? resolved.workspace.title : skBaseName(state.cwd || '');
  const switching = state.list.status === 'loading' && hasValue && state.list.cwd !== state.cwd;
  const anyEditable = Boolean(listing && listing.skills.some(item => item.editable));
  const visibleIds = selecting ? skSelectableIds(groups.flatMap(group => group.items)) : [];
  const tri = skTriState(visibleIds, select ? select.ids : null);

  let content;
  if (!listing) {
    content = state.list.status === 'error'
      ? h(LoadError, { message: skErrorLine(state.list.error, t, 'list'), onRetry: face.retry, t })
      : h(SkillListSkeleton, { t });
  } else {
    content = h(Fragment, null,
      state.list.status === 'error' ? h(LoadError, { message: skErrorLine(state.list.error, t, 'list'), onRetry: face.retry, t }) : null,
      listing.complete ? null : h('p', { className: `${PREFIX}-sk-note` }, Icon.info(12), h('span', null, t('sk_incomplete'))),
      searching && shown.length === 0
        ? h('p', { className: `${PREFIX}-sk-nomatch`, role: 'status' }, fill(t('sk_noMatch'), { query: state.query.trim() }))
        : null,
      !searching && own === 0 ? h(SkillEmpty, { face, t }) : null,
      shown.length
        ? h('div', { className: `${PREFIX}-sk-groups`, 'aria-busy': switching ? 'true' : undefined },
          shown.map((group) => {
            const builtin = group.scope === 'builtin';
            const forced = builtin && searching;
            return h(SkillGroup, {
              key: group.scope,
              group,
              t,
              face,
              select,
              highlight: state.highlight,
              title: group.scope === 'project' ? fill(t('sk_groupProject'), { name: projectName })
                : group.scope === 'user' ? t('sk_groupUser') : t('sk_groupBuiltin'),
              collapsible: builtin && !forced,
              open: builtin ? (forced || state.builtinOpen) : true,
            });
          }))
        : null);
  }

  const toolbar = selecting
    ? h('div', { className: cx(`${PREFIX}-sk-toolbar`, `${PREFIX}-sk-toolbar-select`) },
      h('span', { className: `${PREFIX}-sk-select-count`, 'aria-live': 'polite' }, fill(t('sk_selectedN'), { n: tri.chosen })),
      h(Button, {
        onClick: () => face.selectIds(visibleIds, tri.state !== 'all'), disabled: visibleIds.length === 0, 'data-sk-focus': 'select-all',
      }, tri.state === 'all' ? t('sk_selectNone') : t('sk_selectAll')),
      h(Button, { onClick: face.cancelSelect }, t('c_cancel')))
    : h('div', { className: `${PREFIX}-sk-toolbar` },
      h(SearchInput, { value: state.query, onValue: face.setQuery, placeholder: t('sk_searchPlaceholder'), t }),
      h(Button, { icon: skIconSelect(14), onClick: face.startSelect, disabled: !anyEditable, 'data-sk-focus': 'select' }, t('sk_select')),
      h(Button, { variant: 'primary', icon: Icon.plus(14), onClick: face.openCreate, 'data-sk-focus': 'new' }, t('sk_new')));

  return h(Fragment, null,
    state.result ? h(SkillResultLine, { result: state.result, t, onDismiss: face.dismissResult }) : null,
    toolbar,
    workspaces.length
      ? h(SkillWorkspacePicker, { t, workspaces, resolved, home, onPick: face.pickWorkspace, disabled: selecting })
      : null,
    content,
    selecting
      ? h(SkillActionBar, { label: t('sk_select') },
        h('span', { className: `${PREFIX}-sk-bar-count` }, fill(t('sk_selectedN'), { n: tri.chosen })),
        h('div', { className: `${PREFIX}-actions-end` },
          h(Button, {
            variant: 'danger-solid', icon: Icon.trash(14), onClick: face.requestBatchDelete, disabled: tri.chosen === 0,
          }, fill(t('sk_deleteN'), { n: tri.chosen }))))
      : null);
}

function SkillWorkspacePicker({ t, workspaces, resolved, home, onPick, disabled }) {
  const options = workspaces.map(workspace => ({ value: workspace.path, label: workspace.title, detail: skAbbreviate(workspace.path, home) }));
  if (resolved.path && !workspaces.some(workspace => workspace.path === resolved.path)) {
    options.unshift({ value: resolved.path, label: skBaseName(resolved.path), detail: skAbbreviate(resolved.path, home) });
  }
  options.push({ value: SK_NO_PROJECT, label: t('sk_noProject') });
  return h('div', { className: `${PREFIX}-sk-picker` },
    h('span', { className: `${PREFIX}-sk-picker-label`, 'aria-hidden': true }, t('sk_projectLabel')),
    h(Select, {
      label: t('sk_projectPicker'),
      value: resolved.path ?? SK_NO_PROJECT,
      options,
      onChange: onPick,
      disabled,
      icon: Icon.folder(14),
    }));
}

function SkillListSkeleton({ t, label }) {
  return h('div', { className: `${PREFIX}-sk-skeletons`, role: 'status' },
    h('span', { className: `${PREFIX}-visually-hidden` }, label || t('sk_listLoading')),
    h('div', { className: cx(`${PREFIX}-skeleton`, `${PREFIX}-sk-skel-head`) }),
    h('div', { className: cx(`${PREFIX}-skeleton`, `${PREFIX}-sk-skel-card`) }),
    h('div', { className: cx(`${PREFIX}-skeleton`, `${PREFIX}-sk-skel-head`) }),
    h('div', { className: cx(`${PREFIX}-skeleton`, `${PREFIX}-sk-skel-card`), style: { height: 72 } }));
}

function SkillEmpty({ face, t }) {
  return h('div', { className: `${PREFIX}-sk-empty` },
    h('span', { className: `${PREFIX}-sk-empty-icon` }, Icon.book(20)),
    h('p', { className: `${PREFIX}-sk-empty-title` }, t('sk_emptyTitle')),
    h('p', { className: `${PREFIX}-sk-empty-hint` }, t('sk_emptyHint')),
    h('div', { className: `${PREFIX}-sk-empty-actions` },
      h(Button, { variant: 'primary', icon: Icon.plus(14), onClick: face.openCreate }, t('sk_new')),
      h(Button, { icon: skIconBranch(14), onClick: face.browseRepos }, t('sk_browseRepos'))));
}

/** Checkbox with a mixed state and an optional accessible name richer than its visible label. */
function SkillTriCheck({ state, label, ariaLabel, onChange, disabled, className }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = state === 'some'; }, [state]);
  return h('label', { className: cx(`${PREFIX}-checkbox`, className), 'data-disabled': disabled ? 'true' : undefined },
    h('input', {
      ref, type: 'checkbox', checked: state === 'all', disabled, 'aria-label': ariaLabel,
      onChange: (event) => { onChange(event.target.checked); },
    }),
    label ? h('span', { 'aria-hidden': ariaLabel ? true : undefined }, label) : null);
}

function SkillGroup({ group, title, collapsible, open, t, face, highlight, select }) {
  const listId = `${PREFIX}-sk-group-${group.scope}`;
  const count = h('span', { className: `${PREFIX}-count` }, String(group.items.length));
  const selectable = select ? skSelectableIds(group.items) : [];
  let meta;
  if (select && selectable.length) {
    meta = h(SkillTriCheck, {
      state: skTriState(selectable, select.ids).state, label: t('sk_selectAll'),
      ariaLabel: fill(t('sk_selectGroup'), { group: title }), className: `${PREFIX}-sk-group-check`,
      onChange: on => face.selectIds(selectable, on),
    });
  } else if (group.scope === 'builtin') {
    meta = h('span', { className: `${PREFIX}-sk-group-meta` }, t('sk_readOnly'));
  } else if (group.paths.length) {
    meta = h('span', { className: cx(`${PREFIX}-sk-group-meta`, `${PREFIX}-mono`), title: group.paths.join('\n') }, group.paths.join(' · '));
  } else {
    meta = null;
  }
  return h('section', { className: `${PREFIX}-sk-group`, 'aria-label': title },
    h('div', { className: `${PREFIX}-sk-group-head` },
      h('h3', { className: `${PREFIX}-sk-group-title` },
        collapsible
          ? h('button', {
            type: 'button', className: `${PREFIX}-sk-group-toggle`, 'aria-expanded': String(open), 'aria-controls': listId,
            onClick: () => face.toggleBuiltin(!open),
          }, Icon.chevronRight(12), h('span', null, title), count)
          : h(Fragment, null, h('span', null, title), count)),
      meta),
    h('div', { id: listId, className: cx(`${PREFIX}-card`, `${PREFIX}-sk-rows`), hidden: !open },
      open
        ? group.items.map(item => (select
          ? h(SkillSelectRow, { key: item.id, item, t, checked: Boolean(select.ids[item.id]), onToggle: face.toggleSelect })
          : h(SkillRow, { key: item.id, item, t, onOpen: face.openDetail, fresh: skIsHighlighted(item, highlight) })))
        : null));
}

function SkillBadges({ item, t, omit }) {
  const badges = skBadges(item).filter(badge => !omit || !omit.includes(badge.id));
  if (!badges.length) return null;
  return h(Fragment, null, badges.map((badge) => {
    if (badge.id === 'repo') {
      return h(Tag, { key: badge.id, tone: badge.tone, title: fill(t('sk_badgeRepoTip'), { repo: badge.repo }) }, badge.repo);
    }
    let title;
    if (badge.id === 'shadowed') title = fill(t('sk_badgeShadowedTip'), { path: badge.path || t('sk_builtinSource') });
    else if (badge.id === 'invalid') title = badge.reason;
    else title = t(`${SK_BADGE_LABELS[badge.id]}Tip`);
    return h(Tag, { key: badge.id, tone: badge.tone, title }, t(SK_BADGE_LABELS[badge.id]));
  }));
}

function SkillRowMain({ item, t }) {
  const description = item.description || (item.invalid ? '' : t('sk_noDescription'));
  return h('span', { className: `${PREFIX}-sk-row-main` },
    h('span', { className: `${PREFIX}-sk-row-head` },
      h('span', { className: `${PREFIX}-sk-row-name` }, item.name),
      h(SkillBadges, { item, t })),
    description
      ? h('span', { className: `${PREFIX}-sk-row-desc` }, description)
      : h('span', { className: `${PREFIX}-sk-row-desc`, 'data-tone': 'error' }, item.invalid));
}

function SkillRow({ item, t, onOpen, fresh }) {
  return h('button', {
    type: 'button',
    className: `${PREFIX}-sk-row`,
    'data-sk-row': item.id,
    'data-new': fresh ? '' : undefined,
    'data-inactive': item.active === false ? '' : undefined,
    onClick: () => onOpen(item.id),
  }, h(SkillRowMain, { item, t }));
}

/** Selection-mode row: the whole row toggles a deletable skill; read-only rows are dimmed and inert. */
function SkillSelectRow({ item, t, checked, onToggle }) {
  if (!item.editable) {
    return h('div', {
      className: cx(`${PREFIX}-sk-row`, `${PREFIX}-sk-row-select`), 'data-disabled': '', 'data-sk-row': item.id,
      'data-inactive': item.active === false ? '' : undefined, title: t('sk_cannotSelect'),
    },
    h('span', { className: `${PREFIX}-sk-row-check`, 'aria-hidden': true }),
    h(SkillRowMain, { item, t }));
  }
  return h('label', {
    className: cx(`${PREFIX}-sk-row`, `${PREFIX}-sk-row-select`), 'data-sk-row': item.id,
    'data-checked': checked ? '' : undefined, 'data-inactive': item.active === false ? '' : undefined,
  },
  h('input', {
    type: 'checkbox', className: `${PREFIX}-sk-row-check`, checked,
    'aria-label': `${item.name} · ${skRootLabel(item.root, t)}`,
    onChange: (event) => { onToggle(item.id, event.target.checked); },
  }),
  h(SkillRowMain, { item, t }));
}

/** Sticky bottom bar of the settings column (selection actions). */
function SkillActionBar({ label, children }) {
  return h('div', { className: `${PREFIX}-sk-bar`, role: 'group', 'aria-label': label }, children);
}

function SkillResultLine({ result, t, onDismiss, onOpen }) {
  const summary = skResultSummary(result, t);
  const canOpen = typeof onOpen === 'function' && (result.kind === 'added' || result.kind === 'existing') && result.id;
  const ref = useRef(null);
  // A batch action finishes while the user is scrolled down the list; bring its outcome into view.
  useEffect(() => { ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }, [result]);
  return h('div', { ref, className: `${PREFIX}-sk-result`, 'data-tone': summary.warn ? 'warn' : 'success', role: 'status' },
    h('span', { className: `${PREFIX}-sk-result-icon` }, summary.warn ? Icon.warning(14) : Icon.check(14)),
    h('div', { className: `${PREFIX}-sk-result-body` },
      h('div', { className: `${PREFIX}-sk-result-text` }, summary.text),
      summary.metas.map((meta, index) => h('div', { key: `m${index}`, className: `${PREFIX}-sk-result-meta` }, meta)),
      summary.failures.length
        ? h('ul', { className: `${PREFIX}-sk-result-failures` },
          summary.failures.map((failure, index) => h('li', { key: `${failure.name}-${index}` },
            failure.error ? fill(t('sk_resultFailure'), { name: failure.name, error: skFailureText(failure.error, t) }) : failure.name)))
        : null),
    canOpen ? h(Button, { size: 'sm', variant: 'ghost', onClick: () => onOpen(result.id), className: `${PREFIX}-sk-result-open` }, t('sk_repoOpen')) : null,
    h(IconButton, { label: t('sk_dismiss'), icon: Icon.close(12), onClick: onDismiss, className: `${PREFIX}-sk-result-close` }));
}

/** One-line banner: icon, text, trailing actions. */
function SkillBanner({ tone, children, actions }) {
  return h('div', { className: `${PREFIX}-sk-banner`, 'data-tone': tone, role: tone === 'warn' ? 'alert' : 'status' },
    h('span', { className: `${PREFIX}-sk-banner-icon` }, tone === 'warn' ? Icon.warning(14) : Icon.info(14)),
    h('div', { className: `${PREFIX}-sk-banner-text` }, children),
    actions ? h('div', { className: `${PREFIX}-sk-banner-actions` }, actions) : null);
}

// ---- Detail / create ------------------------------------------------------

function SkillDetailSkeleton({ t }) {
  return h('div', { className: `${PREFIX}-sk-skeletons`, role: 'status' },
    h('span', { className: `${PREFIX}-visually-hidden` }, t('c_loading')),
    h('div', { className: cx(`${PREFIX}-skeleton`, `${PREFIX}-sk-skel-field`), style: { height: 62 } }),
    h('div', { className: cx(`${PREFIX}-skeleton`, `${PREFIX}-sk-skel-field`), style: { height: 32 } }),
    h('div', { className: cx(`${PREFIX}-skeleton`, `${PREFIX}-sk-skel-field`), style: { height: 30, width: '50%' } }),
    h('div', { className: cx(`${PREFIX}-skeleton`, `${PREFIX}-sk-skel-field`), style: { height: 280 } }));
}

function SkillBanners({ item, t }) {
  const banners = [];
  if (item.invalid) {
    banners.push(h(Alert, { key: 'invalid', tone: 'error', title: t('sk_bannerInvalid') },
      item.editable ? `${item.invalid} ${t('sk_bannerInvalidHint')}` : item.invalid));
  }
  if (item.active === false) {
    const winner = item.shadowedBy && item.shadowedBy.displayPath ? skStripSkillFile(item.shadowedBy.displayPath) : t('sk_builtinSource');
    banners.push(h(Alert, { key: 'shadowed', tone: 'warn' }, fill(t('sk_bannerShadowed'), { path: winner })));
  }
  if (!item.editable) {
    banners.push(h(Alert, { key: 'readonly', tone: 'info', title: t('sk_readOnly') },
      item.scope === 'builtin' ? t('sk_readOnlyBuiltin') : t('sk_readOnlyOther')));
  }
  return banners.length ? h(Fragment, null, banners) : null;
}

/** Where a repository skill came from, with 「查看仓库」 and, when the repository has a newer version, 「更新」. */
function SkillOriginBanner({ item, d, dirty, t, face }) {
  const origin = item.origin;
  if (!origin || typeof origin !== 'object') return null;
  const update = Boolean(origin.updateAvailable);
  const key = origin.key && origin.key !== '.' ? origin.key : '';
  const from = skFillNodes(t(key ? 'sk_originFromKey' : 'sk_originFrom'), {
    repo: h('strong', { className: `${PREFIX}-sk-strong` }, origin.repoLabel || origin.repoId),
    key: h('span', { className: `${PREFIX}-mono` }, key),
  });
  const updateError = d.updateError && !d.confirmUpdate ? skErrorLine(d.updateError, t, 'update') : null;
  const actions = h(Fragment, null,
    update
      ? h(Button, {
        size: 'sm', variant: 'primary', icon: Icon.download(12), onClick: face.requestSkillUpdate,
        disabled: dirty || d.saving || d.updating, busy: d.updating, title: dirty ? t('sk_updateDirty') : undefined,
      }, d.updating ? t('sk_updating') : t('sk_update'))
      : null,
    h(Button, { size: 'sm', icon: skIconBranch(12), onClick: face.viewRepo }, t('sk_viewRepo')));
  return h(Alert, { tone: 'info', title: update ? t('sk_originUpdate') : undefined, actions },
    h('span', { className: `${PREFIX}-sk-line` }, from),
    update && origin.modified ? h('span', { className: `${PREFIX}-sk-line` }, t('sk_originModified')) : null,
    update && dirty ? h('span', { className: cx(`${PREFIX}-sk-line`, `${PREFIX}-sk-warn-text`) }, t('sk_updateDirty')) : null,
    d.updateNote === 'modified' ? h('span', { className: cx(`${PREFIX}-sk-line`, `${PREFIX}-sk-warn-text`) }, t('sk_updateSkippedModified')) : null,
    updateError ? h('span', { className: cx(`${PREFIX}-sk-line`, `${PREFIX}-sk-error-text`), role: 'alert' }, updateError) : null,
    d.updatedAt ? h('span', { className: cx(`${PREFIX}-sk-line`, `${PREFIX}-sk-saved`), role: 'status' }, Icon.check(12), t('sk_updated')) : null);
}

/** Shared fields of the detail and create views; `head` carries the create-only name/location row. */
function SkillEditor({ t, draft, readOnly, onField, errors, head }) {
  const uid = useId().replace(/:/g, '');
  const callName = draft.name || t('sk_nameToken');
  return h('div', { className: `${PREFIX}-sk-form` },
    h('div', { className: `${PREFIX}-sk-block` },
      head ?? null,
      h(Field, { label: t('sk_description'), help: t('sk_descriptionHelp'), required: !readOnly, htmlFor: `${uid}-desc`, error: errors.description || undefined, t },
        h(TextArea, {
          id: `${uid}-desc`, value: draft.description, minRows: 2, maxRows: 8, readOnly,
          invalid: Boolean(errors.description), placeholder: readOnly ? undefined : t('sk_descriptionPlaceholder'),
          onValue: value => onField('description', value),
        })),
      h(Field, { label: t('sk_whenToUse'), htmlFor: `${uid}-when`, t },
        h(TextInput, {
          id: `${uid}-when`, value: draft.whenToUse, readOnly,
          placeholder: readOnly ? undefined : t('sk_whenToUsePlaceholder'),
          onValue: value => onField('whenToUse', value),
        }))),
    h('div', { className: `${PREFIX}-sk-block` },
      h('div', { className: `${PREFIX}-field` },
        h('div', { className: `${PREFIX}-field-head` }, h('span', { className: `${PREFIX}-field-label` }, t('sk_invocation'))),
        h(Segmented, {
          label: t('sk_invocation'),
          value: draft.modelInvocable ? 'auto' : 'manual',
          disabled: readOnly,
          options: [{ value: 'auto', label: t('sk_invAuto') }, { value: 'manual', label: t('sk_invManual') }],
          onChange: value => onField('modelInvocable', value === 'auto'),
        }),
        h('p', { className: `${PREFIX}-field-hint` },
          draft.modelInvocable ? t('sk_invAutoHint') : fill(t('sk_invManualHint'), { name: callName }))),
      h(Checkbox, {
        checked: draft.userInvocable, disabled: readOnly,
        label: fill(t('sk_userInvocable'), { name: callName }),
        onChange: value => onField('userInvocable', value),
      }),
      !draft.modelInvocable && !draft.userInvocable
        ? h('p', { className: cx(`${PREFIX}-field-hint`, `${PREFIX}-sk-warn-text`) }, t('sk_unusable'))
        : null),
    h(Field, {
      label: t('sk_body'), htmlFor: `${uid}-body`, t,
      action: readOnly ? undefined : h('span', { className: `${PREFIX}-sk-shortcut` }, t(skIsMac() ? 'sk_bodyShortcutMac' : 'sk_bodyShortcut')),
    },
    h(TextArea, {
      id: `${uid}-body`, value: draft.body, mono: true, minRows: 14, maxRows: 40, readOnly,
      className: `${PREFIX}-sk-body`, onValue: value => onField('body', value),
    })));
}

function SkillFiles({ files, total, t }) {
  const capped = total >= 1000;
  const more = Math.max(0, total - files.length);
  return h('div', { className: `${PREFIX}-field` },
    h('div', { className: `${PREFIX}-field-head` },
      h('span', { className: `${PREFIX}-field-label` }, t('sk_files')),
      h('span', { className: `${PREFIX}-count` }, capped ? `${total}+` : String(total))),
    h('ul', { className: cx(`${PREFIX}-sk-files`, `${PREFIX}-mono`) },
      files.map(file => h('li', { key: file, title: file }, file)),
      more > 0 ? h('li', { className: `${PREFIX}-sk-files-more` }, fill(t('sk_filesMore'), { n: capped ? `${more}+` : more })) : null));
}

function SkillDetailView({ face, state, t }) {
  const id = state.view.id;
  const d = state.detail && state.detail.id === id ? state.detail : null;
  const formRef = useRef(null);
  useEffect(() => { if (!d) face.openDetail(id); }, [d === null, id]);
  useEffect(() => {
    if (d && d.attempted) formRef.current?.querySelector('[aria-invalid="true"]')?.focus();
  }, [d ? d.attempted : 0]);

  const item = (d && d.item) || skFindItem(state.list.value, id);
  const ready = Boolean(d && d.draft);
  const editable = Boolean(ready && item && item.editable);
  const dirty = ready && skDraftDirty(d.draft, d.original);
  const path = item ? (item.displayPath || item.path || '') : '';
  const subtitle = path ? h('span', { className: `${PREFIX}-mono` }, path)
    : item && item.scope === 'builtin' ? t('sk_builtinSource') : null;

  let content;
  if (!ready) {
    if (d && d.status === 'error') {
      content = d.error && d.error.code === 'not-found'
        ? h(Alert, { tone: 'warn', actions: h(Button, { size: 'sm', onClick: face.back }, t('sk_backToList')) }, t('sk_gone'))
        : h(LoadError, { message: skErrorLine(d.error, t, 'read'), onRetry: face.retryDetail, t });
    } else {
      content = h(SkillDetailSkeleton, { t });
    }
  } else {
    const saveError = d.saveError ? skErrorInfo(d.saveError, t, 'save') : null;
    content = h(Fragment, null,
      h(SkillOriginBanner, { item, d, dirty, t, face }),
      h(SkillBanners, { item, t }),
      h(SkillEditor, {
        t, draft: d.draft, readOnly: !editable || d.updating, onField: face.setDetailField,
        errors: { description: d.attempted && !d.draft.description.trim() ? t('sk_descriptionRequired') : null },
      }),
      d.filesTotal > 0 || d.files.length > 0 ? h(SkillFiles, { files: d.files, total: Math.max(d.filesTotal, d.files.length), t }) : null,
      saveError ? h(Alert, { tone: 'error', title: saveError.title }, saveError.detail || null) : null,
      editable
        ? h('div', { className: `${PREFIX}-sk-actions` },
          h(Button, { variant: 'danger', icon: Icon.trash(14), onClick: face.requestDelete, disabled: d.saving || d.updating }, t('sk_deleteSkill')),
          h('div', { className: `${PREFIX}-actions-end` },
            d.savedAt && !dirty ? h('span', { className: `${PREFIX}-sk-saved`, role: 'status' }, Icon.check(12), t('sk_saved')) : null,
            h(Button, { onClick: face.revertDetail, disabled: !dirty || d.saving }, t('c_cancel')),
            h(Button, { variant: 'primary', onClick: face.saveDetail, disabled: !dirty || d.saving || d.updating, busy: d.saving },
              d.saving ? t('c_saving') : t('c_save'))))
        : null);
  }

  return h('div', {
    ref: formRef,
    className: `${PREFIX}-sk-stack`,
    onKeyDown: (event) => {
      if (editable && skIsSaveShortcut(event)) { event.preventDefault(); face.saveDetail(); }
    },
  },
  h(BackBar, { label: t('sk_title'), onBack: face.back, t }),
  h(DetailTitle, {
    title: item ? item.name : '…',
    subtitle,
    status: item ? h('span', { className: `${PREFIX}-sk-title-tags` }, h(SkillBadges, { item, t, omit: ['manual', 'noMenu', 'repo', 'update'] })) : null,
  }),
  content);
}

function SkillCreateView({ face, state, t }) {
  const c = state.create;
  const formRef = useRef(null);
  const uid = useId().replace(/:/g, '');
  useEffect(() => { if (!c) face.openCreate(); }, [c === null]);
  useEffect(() => {
    if (c && c.attempted) formRef.current?.querySelector('[aria-invalid="true"]')?.focus();
  }, [c ? c.attempted : 0]);
  if (!c) return null;

  const listing = state.list.value;
  const roots = listing ? listing.roots : [];
  const hasProject = skHasProject(listing);
  const location = skEffectiveLocation(c.location, hasProject);
  const name = c.draft.name;
  const conflicts = skNameConflicts(name, listing ? listing.skills : [], location);
  const problem = skValidateName(name);
  const serverExists = Boolean(c.error && c.error.code === 'exists' && c.error.name === name);
  let nameError;
  if (serverExists || conflicts.here) nameError = t('sk_nameExistsHere');
  // While typing, only a too-long name is reported; the rest waits for a create attempt.
  else if (problem && (c.attempted || problem === 'tooLong')) nameError = t(SK_NAME_ERRORS[problem]);
  const relation = skShadowRelation(name, listing ? listing.skills : [], location, roots);
  const nameHint = relation
    ? h('span', { className: `${PREFIX}-sk-warn-text`, title: skShadowTitle(relation, t) }, skShadowText(relation, t))
    : t('sk_nameHint');
  const saveError = c.error && !serverExists ? skErrorInfo(c.error, t, 'save') : null;

  const head = h('div', { className: `${PREFIX}-row-fields` },
    h(Field, { label: t('sk_name'), required: true, htmlFor: `${uid}-name`, error: nameError, hint: nameHint, t },
      h(TextInput, {
        id: `${uid}-name`, value: name, mono: true, invalid: Boolean(nameError), readOnly: c.saving,
        placeholder: t('sk_namePlaceholder'), onValue: value => face.setCreateField('name', skNormalizeName(value)),
      })),
    h(Field, { label: t('sk_location'), htmlFor: `${uid}-loc`, t },
      h(Select, {
        id: `${uid}-loc`, label: t('sk_location'), value: location, disabled: c.saving,
        options: skLocationOptions(roots, hasProject, t), onChange: face.setCreateLocation,
        icon: location.startsWith('project-') ? Icon.folder(14) : Icon.user(14),
      })));

  return h('div', {
    ref: formRef,
    className: `${PREFIX}-sk-stack`,
    onKeyDown: (event) => {
      if (skIsSaveShortcut(event)) { event.preventDefault(); face.submitCreate(); }
    },
  },
  h(BackBar, { label: t('sk_title'), onBack: face.back, t }),
  h(DetailTitle, {
    title: t('sk_createTitle'),
    subtitle: h('span', { className: `${PREFIX}-mono` }, `${skRootDisplay(roots, location)}/${name || t('sk_namePlaceholder')}/SKILL.md`),
  }),
  h(SkillEditor, {
    t, draft: c.draft, readOnly: c.saving, onField: face.setCreateField, head,
    errors: { description: c.attempted && !c.draft.description.trim() ? t('sk_descriptionRequired') : null },
  }),
  saveError ? h(Alert, { tone: 'error', title: saveError.title }, saveError.detail || null) : null,
  h('div', { className: `${PREFIX}-sk-actions` },
    h('div', { className: `${PREFIX}-actions-end` },
      h(Button, { onClick: face.back, disabled: c.saving }, t('c_cancel')),
      h(Button, { variant: 'primary', onClick: face.submitCreate, disabled: c.saving, busy: c.saving },
        c.saving ? t('sk_creating') : t('sk_create')))));
}

// ---- 技能仓库: list ---------------------------------------------------------

function SkillRepoList({ face, state, t }) {
  const uid = useId().replace(/:/g, '');
  const repos = state.repos;
  const list = skList(repos.value);
  const add = state.add;
  const adding = add.status === 'adding';
  const pending = add.pending;
  const suggestions = skVisibleSuggestions(SK_REPO_SUGGESTIONS, list);
  const addError = add.status === 'error' && add.error ? skErrorLine(add.error, t, 'add') : null;
  const checkAll = state.checkAll;
  const now = Date.now();

  let content;
  if (!repos.value) {
    content = repos.status === 'error'
      ? h(LoadError, { message: skErrorLine(repos.error, t, 'repos'), onRetry: face.retryRepos, t })
      : h('div', { className: `${PREFIX}-sk-skeletons`, role: 'status' },
        h('span', { className: `${PREFIX}-visually-hidden` }, t('sk_reposLoading')),
        h('div', { className: cx(`${PREFIX}-skeleton`, `${PREFIX}-sk-skel-card`), style: { height: 120 } }));
  } else if (!list.length) {
    content = h(Fragment, null,
      repos.status === 'error' ? h(LoadError, { message: skErrorLine(repos.error, t, 'repos'), onRetry: face.retryRepos, t }) : null,
      h('p', { className: `${PREFIX}-sk-nomatch` }, t('sk_reposEmpty')));
  } else {
    content = h(Fragment, null,
      repos.status === 'error' ? h(LoadError, { message: skErrorLine(repos.error, t, 'repos'), onRetry: face.retryRepos, t }) : null,
      h('div', { className: cx(`${PREFIX}-card`, `${PREFIX}-sk-rows`) },
        list.map(repo => h(SkillRepoRow, {
          key: repo.id, repo, t, now, onOpen: face.openRepo,
          checking: Boolean(state.checks[repo.id]),
          fresh: Boolean(state.repoHighlight && state.repoHighlight.armed && state.repoHighlight.repoId === repo.id),
        }))));
  }

  const pendingText = pending ? (pending.subpath ? `${pending.source}/${skTrimSlashes(pending.subpath)}` : pending.source) : '';

  return h(Fragment, null,
    state.repoResult ? h(SkillResultLine, { result: state.repoResult, t, onDismiss: face.dismissRepoResult, onOpen: face.openRepo }) : null,
    h('section', { className: cx(`${PREFIX}-module`, `${PREFIX}-sk-add`), 'aria-labelledby': `${uid}-add` },
      h('h3', { id: `${uid}-add`, className: `${PREFIX}-section-title` }, t('sk_addTitle')),
      h('div', { className: `${PREFIX}-sk-add-body` },
        h('div', { className: `${PREFIX}-sk-source` },
          h(TextInput, {
            value: add.source, mono: true, readOnly: adding, invalid: Boolean(addError),
            'aria-label': t('sk_addLabel'), 'aria-describedby': addError ? `${uid}-err` : undefined,
            placeholder: t('sk_addPlaceholder'), onValue: face.setAddSource, 'data-sk-focus': 'repo-source',
            onKeyDown: (event) => { if (skIsEnter(event)) { event.preventDefault(); face.addRepo(); } },
          }),
          h(Button, {
            variant: 'primary', onClick: face.addRepo, disabled: adding || !add.source.trim(), busy: adding,
          }, adding ? t('sk_adding') : t('sk_add'))),
        adding && pending
          ? h('div', { className: `${PREFIX}-sk-adding`, role: 'status' },
            h(Spinner, { size: 14 }),
            h('div', { className: `${PREFIX}-sk-adding-text` },
              h('span', null,
                t(skLooksLocal(pending.source) ? 'sk_addingLocal' : 'sk_addingGit'), ' ',
                h('span', { className: `${PREFIX}-mono` }, pendingText), '…'),
              h('span', { className: `${PREFIX}-sk-adding-hint` }, t('sk_addingHint'))))
          : null,
        addError ? h('p', { id: `${uid}-err`, className: `${PREFIX}-field-error`, role: 'alert' }, addError) : null),
      suggestions.length
        ? h('div', { className: `${PREFIX}-sk-suggest` },
          h('span', { className: `${PREFIX}-sk-suggest-label`, id: `${uid}-sug` }, t('sk_suggested')),
          h('div', { className: `${PREFIX}-sk-chips`, role: 'group', 'aria-labelledby': `${uid}-sug` },
            suggestions.map((suggestion) => {
              const full = suggestion.subpath ? `${suggestion.source}/${suggestion.subpath}` : suggestion.source;
              return h('button', {
                key: full, type: 'button', className: `${PREFIX}-sk-chip`, disabled: adding,
                title: fill(t('sk_suggestionTitle'), { source: full }),
                onClick: () => face.addSuggestion(suggestion),
              },
              h('span', { className: `${PREFIX}-sk-chip-label` }, suggestion.label),
              h('span', { className: cx(`${PREFIX}-sk-chip-source`, `${PREFIX}-mono`) }, suggestion.source),
              h('span', { className: `${PREFIX}-sk-chip-plus`, 'aria-hidden': true }, Icon.plus(12)));
            })))
        : null),
    h('section', { className: `${PREFIX}-sk-repos`, 'aria-labelledby': `${uid}-repos` },
      h(SectionHeading, {
        id: `${uid}-repos`,
        title: t('sk_reposHeading'),
        count: list.length ? list.length : undefined,
        action: list.length
          ? h(Button, {
            size: 'sm', icon: Icon.refresh(12), onClick: face.checkAll, busy: Boolean(checkAll), disabled: Boolean(checkAll),
          }, checkAll ? fill(t('sk_checkingAll'), { i: Math.min(checkAll.done + 1, checkAll.total), n: checkAll.total }) : t('sk_checkAll'))
          : undefined,
      }),
      content));
}

function SkillRepoRow({ repo, t, now, checking, fresh, onOpen }) {
  const meta = [
    typeof repo.skillCount === 'number' ? skCount(t, 'sk_repoSkills', repo.skillCount) : null,
    repo.installedCount > 0 ? fill(t('sk_repoInstalled'), { n: repo.installedCount }) : null,
    typeof repo.checkedAt === 'number' ? fill(t('sk_repoChecked'), { ago: formatAgo(repo.checkedAt, now, t) }) : t('sk_repoNeverChecked'),
  ].filter(Boolean).join(t('sk_metaSep'));
  let badge = null;
  if (repo.lastError) badge = h(Tag, { tone: 'error', title: repo.lastError }, t('sk_repoCheckFailed'));
  else if (repo.updateCount > 0) badge = h(Tag, { tone: 'info' }, skCount(t, 'sk_repoUpdates', repo.updateCount));
  return h('button', {
    type: 'button', className: cx(`${PREFIX}-sk-row`, `${PREFIX}-sk-repo-row`), 'data-sk-repo': repo.id,
    'data-new': fresh ? '' : undefined, onClick: () => onOpen(repo.id),
  },
  h('span', { className: `${PREFIX}-sk-repo-icon`, 'aria-hidden': true }, repo.kind === 'local' ? Icon.folder(16) : skIconBranch(16)),
  h('span', { className: `${PREFIX}-sk-row-main` },
    h('span', { className: `${PREFIX}-sk-row-name`, title: repo.source || undefined }, repo.label || repo.source),
    h('span', { className: `${PREFIX}-sk-repo-meta` },
      checking ? h(Fragment, null, h(Spinner, { size: 12 }), h('span', null, t('sk_checkingMeta'))) : h('span', null, meta))),
  badge,
  h('span', { className: `${PREFIX}-sk-repo-chevron`, 'aria-hidden': true }, Icon.chevronRight(12)));
}

// ---- 技能仓库: one repository ----------------------------------------------

function SkillRepoView({ face, state, t }) {
  const id = state.view.id;
  const r = state.repo && state.repo.id === id ? state.repo : null;
  useEffect(() => { if (!r) face.openRepo(id); }, [r === null, id]);

  const repository = (r && r.value && r.value.repository) || (r && r.preview)
    || skList(state.repos.value).find(repo => repo.id === id) || null;
  const checking = Boolean(state.checks[id]);
  const busy = Boolean(r && (r.busy || r.removing));
  const now = Date.now();

  let subtitle = null;
  if (repository) {
    const source = repository.kind === 'local'
      ? (repository.displayPath || repository.path || repository.source)
      : (repository.source || repository.url);
    const meta = [
      repository.commit ? fill(t('sk_commit'), { sha: String(repository.commit).slice(0, 7) }) : null,
      typeof repository.checkedAt === 'number' ? fill(t('sk_repoChecked'), { ago: formatAgo(repository.checkedAt, now, t) }) : t('sk_repoNeverChecked'),
    ].filter(Boolean).join(t('sk_metaSep'));
    subtitle = h('span', { className: `${PREFIX}-sk-repo-sub` },
      h('span', { className: `${PREFIX}-sk-repo-source` },
        h('span', { className: `${PREFIX}-mono` }, source),
        repository.webUrl
          ? h('a', { className: `${PREFIX}-sk-link`, href: repository.webUrl, target: '_blank', rel: 'noreferrer' },
            t('sk_openGithub'), skIconExternal(11))
          : null),
      h('span', { className: `${PREFIX}-sk-repo-metaline`, 'aria-live': 'polite' },
        checking ? h(Fragment, null, h(Spinner, { size: 12 }), h('span', null, t('sk_checkingMeta'))) : h('span', null, skSentence(meta))));
  }

  let content;
  if (!r || !r.value) {
    if (r && r.status === 'error') {
      content = r.error && r.error.code === 'not-found'
        ? h(Alert, { tone: 'warn', actions: h(Button, { size: 'sm', onClick: face.back }, t('sk_backToRepos')) }, t('sk_repoGone'))
        : h(LoadError, { message: skErrorLine(r.error, t, 'repo'), onRetry: face.retryRepo, t });
    } else {
      content = h(SkillDetailSkeleton, { t });
    }
  } else {
    content = h(SkillRepoBody, { face, state, r, t, checking });
  }

  return h('div', { className: `${PREFIX}-sk-stack` },
    h(BackBar, { label: t('sk_tabRepos'), onBack: face.back, t }),
    h(DetailTitle, {
      title: repository ? (repository.label || repository.source) : '…',
      subtitle,
      trailing: h(Button, {
        size: 'sm', icon: Icon.refresh(12), onClick: face.checkRepo, busy: checking,
        disabled: checking || busy || !r || (r.status === 'error' && !r.value),
      }, checking ? t('sk_checking') : t('sk_check')),
    }),
    content);
}

function SkillRepoBody({ face, state, r, t, checking }) {
  const repository = r.value.repository || r.preview || {};
  const skills = r.value.skills;
  const listing = state.list.value;
  const roots = listing ? listing.roots : [];
  const listed = listing ? listing.skills : [];
  const hasProject = skHasProject(listing);
  const location = skEffectiveLocation(state.location, hasProject);
  const busy = Boolean(r.busy || r.removing);
  const rows = useMemo(() => skills.map(skill => ({ skill, status: skRepoRowStatus(skill) })), [skills]);
  const visible = rows.filter(row => skMatches(row.skill, r.filter));
  const visibleKeys = visible.filter(row => skRepoSelectable(row.status)).map(row => row.skill.key);
  const tri = skTriState(visibleKeys, r.selected);
  const selectedRows = rows.filter(row => r.selected[row.skill.key] && skRepoSelectable(row.status));
  const installRows = selectedRows.filter(row => skRepoInstallable(row.status)).length;
  const installPlan = skRepoInstallPlan(skills, r.selected, r.overwrite, location);
  const updatePlan = skRepoUpdatePlan(skills, skill => Boolean(r.selected[skill.key]));
  const updates = rows.filter(row => row.status.kind === 'update').length;
  const relations = skInstallRelations(installPlan.names, listed, location, roots);
  const note = [
    installPlan.skip ? skCount(t, 'sk_willSkip', installPlan.skip) : null,
    relations.overrides.length ? skCount(t, 'sk_willOverride', relations.overrides.length) : null,
    relations.overridden.length ? skCount(t, 'sk_willBeOverridden', relations.overridden.length) : null,
  ].filter(Boolean).join(t('sk_noteSep'));
  const actionError = r.actionError ? skErrorInfo(r.actionError, t, r.actionError.action || 'repo') : null;
  const lastError = !checking && repository.lastError ? String(repository.lastError) : '';

  let list;
  if (!skills.length) {
    list = h('p', { className: `${PREFIX}-sk-nomatch`, role: 'status' },
      checking ? h('span', { className: `${PREFIX}-sk-inline` }, h(Spinner, { size: 12 }), t('sk_repoFetching')) : t('sk_repoNoSkills'));
  } else {
    list = h('div', { className: cx(`${PREFIX}-card`, `${PREFIX}-sk-cands`) },
      h('div', { className: `${PREFIX}-sk-cands-bar` },
        h(SkillTriCheck, {
          state: tri.state, label: t('sk_selectAll'), disabled: busy || !visibleKeys.length,
          onChange: on => face.selectRepoSkills(visibleKeys, on),
        }),
        h('span', { className: `${PREFIX}-sk-cands-count`, 'aria-live': 'polite' }, fill(t('sk_selectedN'), { n: selectedRows.length }))),
      visible.length === 0
        ? h('p', { className: cx(`${PREFIX}-sk-nomatch`, `${PREFIX}-sk-cands-empty`), role: 'status' }, fill(t('sk_noMatch'), { query: r.filter.trim() }))
        : h('div', { className: `${PREFIX}-sk-cands-list` },
          visible.map(row => h(SkillRepoSkillRow, {
            key: row.skill.key, skill: row.skill, status: row.status, t, face, busy, location, listed, roots,
            selected: Boolean(r.selected[row.skill.key]),
            overwrite: Boolean(r.overwrite[row.skill.key]),
            fresh: Boolean(r.highlight && r.highlight.armed && r.highlight.keys.includes(row.skill.key)),
          }))));
  }

  return h(Fragment, null,
    lastError
      ? h(SkillBanner, {
        tone: 'warn',
        actions: h(Button, { size: 'sm', icon: Icon.refresh(12), onClick: face.checkRepo, disabled: busy }, t('c_retry')),
      }, fill(t('sk_lastError'), { reason: lastError }))
      : null,
    r.result ? h(SkillResultLine, { result: r.result, t, onDismiss: face.dismissRepoDetailResult }) : null,
    updates
      ? h(SkillBanner, {
        tone: 'info',
        actions: h(Button, {
          size: 'sm', variant: 'primary', icon: Icon.download(12), onClick: face.updateAll, disabled: busy || checking, busy: r.busy === 'update',
        }, r.busy === 'update' ? t('sk_updating') : t('sk_updateAll')),
      }, skCount(t, 'sk_updatesBanner', updates))
      : null,
    actionError
      ? h(Alert, {
        tone: 'error', title: actionError.title,
        // A missing cache fails install / update as a whole; checking downloads it again.
        actions: r.actionError.code === 'not-found'
          ? h(Button, { size: 'sm', icon: Icon.refresh(12), onClick: face.checkRepo, disabled: busy || checking }, t('sk_check'))
          : null,
      }, actionError.detail || null)
      : null,
    h('section', { className: `${PREFIX}-sk-repo-skills`, 'aria-label': t('sk_repoSkillsHeading') },
      skills.length > SK_REPO_FILTER_MIN
        ? h(SearchInput, { value: r.filter, onValue: face.setRepoFilter, placeholder: t('sk_filterSkills'), t })
        : null,
      list),
    selectedRows.length
      ? h(SkillActionBar, { label: fill(t('sk_selectedN'), { n: selectedRows.length }) },
        installRows
          ? h('div', { className: `${PREFIX}-sk-bar-loc` },
            h('span', { className: `${PREFIX}-sk-bar-label`, 'aria-hidden': true }, t('sk_installTo')),
            h(Select, {
              label: t('sk_installTo'), value: location, disabled: busy,
              options: skLocationOptions(roots, hasProject, t), onChange: face.setLocation,
              icon: location.startsWith('project-') ? Icon.folder(14) : Icon.user(14),
            }))
          : h('span', { className: `${PREFIX}-sk-bar-count` }, fill(t('sk_selectedN'), { n: selectedRows.length })),
        h('div', { className: `${PREFIX}-actions-end` },
          updatePlan.rows
            ? h(Button, {
              variant: installRows ? 'secondary' : 'primary', icon: Icon.refresh(14), onClick: face.updateSelected,
              disabled: busy || checking, busy: r.busy === 'update',
            }, r.busy === 'update' ? t('sk_updating') : fill(t('sk_updateN'), { n: updatePlan.rows }))
            : null,
          installRows
            ? h(Button, {
              variant: 'primary', icon: Icon.download(14), onClick: face.installSelected,
              disabled: busy || checking || installPlan.install === 0, busy: r.busy === 'install',
            }, r.busy === 'install' ? t('sk_installing') : fill(t('sk_installN'), { n: installPlan.install }))
            : null),
        installRows && note
          ? h('p', { className: `${PREFIX}-sk-bar-note`, 'aria-live': 'polite', 'data-tone': relations.overridden.length ? 'warn' : undefined }, note)
          : null)
      : null,
    // The danger zone follows the action bar so the bar docks right under the list it acts on.
    h('div', { className: `${PREFIX}-sk-danger` },
      h(Button, { variant: 'danger', icon: Icon.trash(14), onClick: face.requestRemoveRepo, disabled: busy }, t('sk_removeRepo'))));
}

function SkillRepoSkillRow({ skill, status, selected, overwrite, location, listed, roots, busy, fresh, t, face }) {
  const kind = status.kind;
  const selectable = skRepoSelectable(status);
  const installable = skRepoInstallable(status);
  const conflict = installable && status.others.some(copy => copy.root === location);
  const relation = installable ? skShadowRelation(skill.name, listed, location, roots) : null;
  const tags = [];
  if (kind === 'installed') tags.push(h(Tag, { key: 'installed', tone: 'success' }, t('sk_statusInstalled')));
  if (kind === 'update') tags.push(h(Tag, { key: 'update', tone: 'info', title: t('sk_badgeUpdateTip') }, t('sk_badgeUpdate')));
  if ((kind === 'update' || kind === 'installed') && status.modified) {
    tags.push(h(Tag, { key: 'modified', tone: 'outline', title: t('sk_badgeModifiedTip') }, t('sk_badgeModified')));
  }
  if (kind === 'exists') {
    const where = status.others.map(copy => `${skRootLabel(copy.root, t)}  ${copy.displayPath || copy.path || ''}`).join('\n');
    tags.push(h(Tag, { key: 'exists', tone: 'warn', title: `${fill(t('sk_statusExistsTip'), { places: skPlaces(status.others, t) })}\n${where}` }, t('sk_statusExists')));
  }
  if (kind === 'invalid') tags.push(h(Tag, { key: 'invalid', tone: 'error' }, t('sk_statusInvalid')));
  if (relation) {
    tags.push(h(Tag, { key: 'relation', tone: 'warn', title: skShadowTitle(relation, t) },
      h('span', { 'aria-hidden': true }, t(relation.direction === 'overrides' ? 'sk_tagOverrides' : 'sk_tagOverridden')),
      h('span', { className: `${PREFIX}-visually-hidden` }, skShadowText(relation, t))));
  }
  const text = h('span', { className: `${PREFIX}-sk-cand-text` },
    h('span', { className: `${PREFIX}-sk-cand-head` },
      h('span', { className: `${PREFIX}-sk-cand-name`, title: skRepoSkillWhere(skill, t) }, skill.name),
      tags),
    kind === 'invalid'
      ? h('span', { className: `${PREFIX}-sk-cand-desc`, 'data-tone': 'error', title: skill.error || undefined }, skCandidateError(skill.error, t))
      : h('span', { className: `${PREFIX}-sk-cand-desc`, title: skill.description || undefined }, skill.description || t('sk_noDescription')),
    status.tracked.length
      ? h('span', { className: `${PREFIX}-sk-cand-places` }, fill(t('sk_installedAt'), { places: skPlaces(status.tracked, t) }))
      : null);
  let main;
  if (selectable) {
    main = h('label', { className: `${PREFIX}-sk-cand-main` },
      h('input', {
        type: 'checkbox', checked: selected, disabled: busy,
        onChange: (event) => { face.toggleRepoSkill(skill.key, event.target.checked); },
      }),
      text);
  } else {
    main = h('div', { className: `${PREFIX}-sk-cand-main` },
      kind === 'installed'
        ? h('span', { className: `${PREFIX}-sk-cand-done`, 'aria-hidden': true }, Icon.check(14))
        : h('input', { type: 'checkbox', checked: false, disabled: true, 'aria-label': skill.name }),
      text);
  }
  return h('div', {
    className: `${PREFIX}-sk-cand`,
    'data-disabled': kind === 'invalid' ? '' : undefined,
    'data-checked': selectable && selected ? '' : undefined,
    'data-new': fresh ? '' : undefined,
  },
  main,
  selected && conflict
    ? h('div', { className: `${PREFIX}-sk-cand-side` },
      h(Segmented, {
        label: fill(t('sk_conflictLabel'), { name: skill.name }),
        size: 'sm',
        value: overwrite ? 'overwrite' : 'skip',
        disabled: busy,
        options: [{ value: 'skip', label: t('sk_skip') }, { value: 'overwrite', label: t('sk_overwrite') }],
        onChange: value => face.setRepoOverwrite(skill.key, value === 'overwrite'),
      }))
    : null);
}

// ---- Dialogs --------------------------------------------------------------

function SkillDeleteDialog({ face, state, t }) {
  const d = state.detail;
  const item = d && d.item;
  const open = Boolean(d && d.confirmDelete && item);
  const body = item
    ? h(Fragment, null,
      h('p', null, skFillNodes(t(item.layout === 'flat' ? 'sk_deleteBodyFile' : 'sk_deleteBody'), { path: h('code', null, skDisplayDir(item)) })),
      typeof item.root === 'string' && item.root.endsWith('-agents') ? h('p', null, t('sk_deleteShared')) : null)
    : null;
  return h(ConfirmDialog, {
    open,
    title: item ? fill(t('sk_deleteTitle'), { name: item.name }) : '',
    body,
    confirmLabel: t('c_delete'),
    cancelLabel: t('c_cancel'),
    danger: true,
    busy: Boolean(d && d.deleting),
    error: d && d.deleteError ? skErrorLine(d.deleteError, t, 'delete') : null,
    onConfirm: face.confirmDelete,
    onCancel: face.cancelDelete,
  });
}

function SkillBatchDeleteDialog({ face, state, t }) {
  const batch = state.batch;
  const items = batch ? skSelectedForDelete(state.list.value, state.query, state.select && state.select.ids) : [];
  const summary = skBatchSummary(items, t);
  return h(ConfirmDialog, {
    open: Boolean(batch && items.length),
    title: skCount(t, 'sk_batchTitle', summary.count),
    body: h(Fragment, null,
      h('p', { className: `${PREFIX}-sk-dialog-names` }, summary.names),
      h('p', null, t('sk_batchBody')),
      summary.shared ? h('p', null, skCount(t, 'sk_batchShared', summary.shared)) : null),
    confirmLabel: t('c_delete'),
    cancelLabel: t('c_cancel'),
    danger: true,
    busy: Boolean(batch && batch.deleting),
    error: batch && batch.error ? skErrorLine(batch.error, t, 'delete') : null,
    onConfirm: face.confirmBatchDelete,
    onCancel: face.cancelBatchDelete,
  });
}

function SkillUpdateDialog({ face, state, t }) {
  const d = state.detail;
  const item = d && d.item;
  return h(ConfirmDialog, {
    open: Boolean(d && d.confirmUpdate && item),
    title: t('sk_updateModifiedTitle'),
    body: item ? fill(t('sk_updateModifiedBody'), { name: item.name }) : '',
    confirmLabel: t('sk_updateAnyway'),
    cancelLabel: t('c_cancel'),
    danger: true,
    busy: Boolean(d && d.updating),
    error: d && d.confirmUpdate && d.updateError ? skErrorLine(d.updateError, t, 'update') : null,
    onConfirm: face.confirmSkillUpdate,
    onCancel: face.cancelSkillUpdate,
  });
}

/** Native modal like core ConfirmDialog, but with any set of action buttons. */
function SkillChoiceDialog({ open, title, body, actions, onCancel }) {
  const ref = useRef(null);
  const opener = useRef(null);
  const titleId = `${PREFIX}-sk-choice-${useId().replace(/:/g, '')}`;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
      opener.current?.focus?.();
    }
  }, [open]);
  return h('dialog', {
    ref, className: `${PREFIX}-dialog`, 'aria-labelledby': titleId,
    onCancel: (event) => { event.preventDefault(); onCancel(); },
    onClick: (event) => { if (event.target === ref.current) onCancel(); },
  },
  open ? h(Fragment, null,
    h('h3', { id: titleId }, title),
    body,
    h('div', { className: `${PREFIX}-dialog-actions` }, actions)) : null);
}

function SkillModifiedDialog({ face, state, t }) {
  const r = state.repo;
  const modified = r && r.modified;
  const names = modified ? modified.names : [];
  const others = modified ? Math.max(0, modified.rows - names.length) : 0;
  const body = modified
    ? h(Fragment, null,
      h('p', null, fill(t('sk_modifiedBody'), { names: skBatchSummary(names.map(name => ({ name })), t).names })),
      others > 0 ? h('p', null, fill(t('sk_modifiedSkipHint'), { n: others })) : null)
    : null;
  const cancel = () => face.resolveModified('cancel');
  return h(SkillChoiceDialog, {
    open: Boolean(modified),
    title: modified ? skCount(t, 'sk_modifiedTitle', names.length) : '',
    body,
    onCancel: cancel,
    actions: [
      h(Button, { key: 'cancel', onClick: cancel, autoFocus: true }, t('c_cancel')),
      h(Button, { key: 'skip', onClick: () => face.resolveModified('skip'), disabled: others === 0 }, t('sk_skipModified')),
      h(Button, { key: 'force', variant: 'danger-solid', onClick: () => face.resolveModified('force') }, t('sk_updateAnyway')),
    ],
  });
}

function SkillRemoveRepoDialog({ face, state, t }) {
  const r = state.repo;
  const repository = r && ((r.value && r.value.repository) || r.preview);
  return h(ConfirmDialog, {
    open: Boolean(r && r.confirmRemove),
    title: fill(t('sk_removeTitle'), { label: repository ? (repository.label || repository.source) : '' }),
    body: t('sk_removeBody'),
    confirmLabel: t('sk_remove'),
    cancelLabel: t('c_cancel'),
    danger: true,
    busy: Boolean(r && r.removing),
    error: r && r.removeError ? skErrorLine(r.removeError, t, 'remove') : null,
    onConfirm: face.confirmRemoveRepo,
    onCancel: face.cancelRemoveRepo,
  });
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

addCss(`
.${PREFIX}-sk-stack { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
/* Core's .input { font: inherit } follows .mono in the cascade; restore the mono family for this page's mono fields. */
.${PREFIX}-sk-stack .${PREFIX}-input.${PREFIX}-mono { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.${PREFIX}-sk-panel { display: flex; flex-direction: column; gap: 16px; min-width: 0; animation: ${PREFIX}-fade 120ms ease-out; }
.${PREFIX}-sk-tabs { margin-top: -2px; }
.${PREFIX}-sk-tabs .${PREFIX}-seg-item[aria-selected="true"] { color: var(--dsw-alias-label-primary); }
.${PREFIX}-sk-tabs .${PREFIX}-seg-item { padding: 0 16px; }
.${PREFIX}-sk-tab-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 14%, transparent); color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); font-size: 11px; line-height: 18px; font-weight: 500; font-variant-numeric: tabular-nums; }

.${PREFIX}-sk-toolbar { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 32px; }
.${PREFIX}-sk-toolbar .${PREFIX}-search { min-width: 140px; }
.${PREFIX}-sk-select-count { flex: 1 1 auto; min-width: 0; padding-left: 2px; font-size: 13px; line-height: 20px; font-weight: 500; font-variant-numeric: tabular-nums; }
.${PREFIX}-sk-picker { display: flex; align-items: center; gap: 6px; min-width: 0; margin-top: -4px; }
.${PREFIX}-sk-picker-label { flex: none; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-sk-picker .${PREFIX}-select { height: 28px; max-width: min(100%, 360px); }
.${PREFIX}-sk-note { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-sk-nomatch { margin: 0; padding: 12px 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-sk-inline { display: inline-flex; align-items: center; gap: 6px; }

.${PREFIX}-sk-groups { display: flex; flex-direction: column; gap: 20px; transition: opacity 120ms ease; }
.${PREFIX}-sk-groups[aria-busy="true"] { opacity: 0.55; }
.${PREFIX}-sk-group { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.${PREFIX}-sk-group-head { display: flex; align-items: center; gap: 12px; min-width: 0; min-height: 22px; }
.${PREFIX}-sk-group-title { flex: none; display: inline-flex; align-items: baseline; gap: 6px; margin: 0; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-sk-group-toggle { display: inline-flex; align-items: center; gap: 6px; margin: 0 0 0 -4px; padding: 2px 6px 2px 4px; border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: inherit; font: inherit; cursor: pointer; transition: background-color 120ms ease, color 120ms ease; }
.${PREFIX}-sk-group-toggle > svg { flex: none; color: var(--dsw-alias-label-tertiary); transition: transform 120ms ease; }
.${PREFIX}-sk-group-toggle[aria-expanded="true"] > svg { transform: rotate(90deg); }
@media (hover: hover) { .${PREFIX}-sk-group-toggle:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); } }
.${PREFIX}-sk-group-toggle:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))); }
.${PREFIX}-sk-group-meta { flex: 1 1 auto; min-width: 0; text-align: end; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-sk-group-check { margin-left: auto; padding-right: 14px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }

.${PREFIX}-sk-rows { overflow: hidden; }
.${PREFIX}-sk-rows[hidden] { display: none; }
.${PREFIX}-sk-row { display: flex; align-items: flex-start; gap: 12px; width: 100%; min-width: 0; margin: 0; padding: 10px 14px; border: 0; border-top: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; text-align: start; cursor: pointer; transition: background-color 120ms ease; }
.${PREFIX}-sk-row:first-child { border-top: 0; }
@media (hover: hover) { .${PREFIX}-sk-row:hover:not([data-disabled]) { background: var(--dsw-alias-interactive-bg-hover); } }
.${PREFIX}-sk-row:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))); }
.${PREFIX}-sk-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.${PREFIX}-sk-row-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; min-width: 0; }
.${PREFIX}-sk-row-name { min-width: 0; max-width: 100%; margin-right: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; line-height: 22px; font-weight: 500; }
.${PREFIX}-sk-row[data-inactive] .${PREFIX}-sk-row-name { color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-sk-row-desc { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.${PREFIX}-sk-row-desc[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-sk-row[data-new], .${PREFIX}-sk-cand[data-new] { animation: ${PREFIX}-sk-flash 2s ease-out; }
@keyframes ${PREFIX}-sk-flash { from { background-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent); } to { background-color: transparent; } }
.${PREFIX}-sk-row-check { flex: none; width: 16px; height: 16px; margin: 3px 0 0; accent-color: var(--dsw-alias-brand-primary); cursor: inherit; }
.${PREFIX}-sk-row-check:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))); outline-offset: 2px; }
.${PREFIX}-sk-row-select[data-checked] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 7%, transparent); }
.${PREFIX}-sk-row-select[data-disabled] { cursor: default; }
.${PREFIX}-sk-row-select[data-disabled] .${PREFIX}-sk-row-main { opacity: 0.45; }

/* A stuck bar sits above the scroller's bottom padding (sticky insets by padding); the same-colour shadow
   hides rows scrolling through that strip without adding to the scroll height. */
.${PREFIX}-sk-bar { position: sticky; bottom: 0; z-index: 3; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-height: 57px; margin-top: -4px; padding: 12px 0; border-top: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2)); box-shadow: 0 40px 0 0 var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2)); animation: ${PREFIX}-sk-bar-in 140ms ease-out; }
@keyframes ${PREFIX}-sk-bar-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.${PREFIX}-sk-bar-count { font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.${PREFIX}-sk-bar-loc { display: flex; align-items: center; gap: 8px; min-width: 0; }
.${PREFIX}-sk-bar-label { flex: none; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-sk-bar-loc .${PREFIX}-select { min-width: 180px; max-width: 260px; }
.${PREFIX}-sk-bar-note { flex: 1 0 100%; order: 3; margin: -2px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-sk-bar-note[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }

.${PREFIX}-sk-skeletons { display: flex; flex-direction: column; gap: 8px; }
.${PREFIX}-sk-skel-head { width: 88px; height: 14px; margin-top: 6px; border-radius: var(--dsw-radius-sm, 6px); }
.${PREFIX}-sk-skel-card { height: 128px; }
.${PREFIX}-sk-skel-field { border-radius: var(--dsw-radius-md, 8px); }
.${PREFIX}-sk-skeletons .${PREFIX}-sk-skel-field + .${PREFIX}-sk-skel-field { margin-top: 6px; }

.${PREFIX}-sk-empty { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 28px 16px 24px; border: 1px dashed var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); border-radius: var(--dsw-radius-xl, 12px); text-align: center; }
.${PREFIX}-sk-empty-icon { display: inline-flex; margin-bottom: 6px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-sk-empty-title { margin: 0; font-size: 14px; line-height: 22px; font-weight: 500; }
.${PREFIX}-sk-empty-hint { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-sk-empty-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 12px; }

.${PREFIX}-sk-result { display: flex; align-items: flex-start; gap: 8px; padding: 4px 4px 4px 12px; border-radius: var(--dsw-radius-lg, 10px); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); font-size: 13px; line-height: 20px; animation: ${PREFIX}-enter 140ms ease-out; }
.${PREFIX}-sk-result[data-tone="warn"] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 11%, transparent); }
.${PREFIX}-sk-result-icon { flex: none; display: inline-flex; padding-top: 7px; color: var(--dsw-alias-state-success-primary); }
.${PREFIX}-sk-result[data-tone="warn"] .${PREFIX}-sk-result-icon { color: var(--dsw-alias-state-warn-primary); }
.${PREFIX}-sk-result-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; padding: 4px 0; }
.${PREFIX}-sk-result-text { font-weight: 500; overflow-wrap: anywhere; }
.${PREFIX}-sk-result-meta { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.${PREFIX}-sk-result-failures { margin: 0; padding: 0; list-style: none; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.${PREFIX}-sk-result-open, .${PREFIX}-sk-result-close { flex: none; }

.${PREFIX}-sk-banner { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 8px 6px 12px; border-radius: var(--dsw-radius-lg, 10px); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 8%, transparent); font-size: 13px; line-height: 20px; }
.${PREFIX}-sk-banner[data-tone="warn"] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 11%, transparent); }
.${PREFIX}-sk-banner-icon { flex: none; display: inline-flex; color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }
.${PREFIX}-sk-banner[data-tone="warn"] .${PREFIX}-sk-banner-icon { color: var(--dsw-alias-state-warn-primary); }
.${PREFIX}-sk-banner-text { flex: 1 1 auto; min-width: 0; font-weight: 500; overflow-wrap: anywhere; }
.${PREFIX}-sk-banner[data-tone="warn"] .${PREFIX}-sk-banner-text { font-weight: 400; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-sk-banner-actions { flex: none; display: flex; gap: 6px; }

.${PREFIX}-sk-title-tags { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; }
.${PREFIX}-sk-line { display: block; }
.${PREFIX}-sk-line.${PREFIX}-sk-saved { display: flex; margin-top: 2px; }
.${PREFIX}-sk-strong { font-weight: 500; color: var(--dsw-alias-label-primary); }
.${PREFIX}-sk-form { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
.${PREFIX}-sk-block { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.${PREFIX}-sk-warn-text { color: var(--dsw-alias-state-warn-primary); }
.${PREFIX}-sk-error-text { color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-sk-shortcut { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-sk-body { min-height: 120px; }
.${PREFIX}-sk-files { display: flex; flex-direction: column; margin: 0; padding: 6px 0; list-style: none; max-height: 240px; overflow-y: auto; border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-1)); }
.${PREFIX}-sk-files li { padding: 1px 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); user-select: text; }
.${PREFIX}-sk-files li.${PREFIX}-sk-files-more { font-family: inherit; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-sk-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-top: 16px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.${PREFIX}-sk-saved { display: inline-flex; align-items: center; gap: 4px; margin-right: 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-success-primary); animation: ${PREFIX}-fade 120ms ease-out; }

.${PREFIX}-sk-add { gap: 10px; }
.${PREFIX}-sk-add .${PREFIX}-section-title { flex: none; }
.${PREFIX}-sk-add-body { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.${PREFIX}-sk-source { display: flex; align-items: center; gap: 8px; min-width: 0; }
.${PREFIX}-sk-source .${PREFIX}-input { flex: 1 1 auto; }
.${PREFIX}-sk-adding { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-sk-adding > .${PREFIX}-spinner { margin-top: 3px; }
.${PREFIX}-sk-adding-text { display: flex; flex-direction: column; min-width: 0; overflow-wrap: anywhere; }
.${PREFIX}-sk-adding-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-sk-suggest { display: flex; flex-direction: column; gap: 6px; padding-top: 2px; }
.${PREFIX}-sk-suggest-label { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-sk-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.${PREFIX}-sk-chip { position: relative; display: inline-flex; flex-direction: column; align-items: flex-start; min-width: 0; max-width: 100%; padding: 6px 30px 7px 12px; border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-label-primary); font: inherit; text-align: start; cursor: pointer; transition: background-color 120ms ease, opacity 120ms ease; }
@media (hover: hover) { .${PREFIX}-sk-chip:hover:not(:disabled) { background-image: linear-gradient(var(--dsw-alias-interactive-bg-hover), var(--dsw-alias-interactive-bg-hover)); } }
.${PREFIX}-sk-chip:disabled { opacity: 0.5; cursor: default; }
.${PREFIX}-sk-chip:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))); }
.${PREFIX}-sk-chip-label { font-size: 13px; line-height: 20px; font-weight: 500; }
.${PREFIX}-sk-chip-source { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-sk-chip-plus { position: absolute; top: 9px; right: 10px; display: inline-flex; color: var(--dsw-alias-label-tertiary); }

.${PREFIX}-sk-repos { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.${PREFIX}-sk-repo-row { align-items: center; }
.${PREFIX}-sk-repo-icon { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-label-secondary); }
.${PREFIX}-sk-repo-meta { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.${PREFIX}-sk-repo-meta > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${PREFIX}-sk-repo-chevron { flex: none; display: inline-flex; margin-right: -2px; color: var(--dsw-alias-label-tertiary); }

.${PREFIX}-sk-repo-sub { display: flex; flex-direction: column; gap: 2px; }
.${PREFIX}-sk-repo-source { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; }
.${PREFIX}-sk-repo-metaline { display: inline-flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; user-select: none; }
.${PREFIX}-sk-link { display: inline-flex; align-items: center; gap: 3px; border-radius: 4px; color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); font-family: inherit; text-decoration: none; user-select: none; }
@media (hover: hover) { .${PREFIX}-sk-link:hover { text-decoration: underline; text-underline-offset: 2px; } }
.${PREFIX}-sk-link:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))); }
.${PREFIX}-sk-repo-skills { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.${PREFIX}-sk-danger { display: flex; padding-top: 16px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.${PREFIX}-sk-danger .${PREFIX}-btn { margin-left: -10px; }

.${PREFIX}-sk-cands { overflow: hidden; }
.${PREFIX}-sk-cands-bar { display: flex; align-items: center; gap: 12px; min-height: 40px; padding: 0 14px; border-bottom: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); }
.${PREFIX}-sk-cands-count { margin-left: auto; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.${PREFIX}-sk-cands-empty { padding: 12px 14px; }
.${PREFIX}-sk-cand { display: flex; align-items: flex-start; gap: 12px; padding: 10px 14px; border-top: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); transition: background-color 120ms ease; }
.${PREFIX}-sk-cand:first-child { border-top: 0; }
.${PREFIX}-sk-cand[data-checked] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 7%, transparent); }
.${PREFIX}-sk-cand-main { flex: 1 1 auto; min-width: 0; display: flex; align-items: flex-start; gap: 10px; }
label.${PREFIX}-sk-cand-main { cursor: pointer; }
.${PREFIX}-sk-cand-main input { flex: none; width: 16px; height: 16px; margin: 3px 0 0; accent-color: var(--dsw-alias-brand-primary); cursor: inherit; }
.${PREFIX}-sk-cand-main input:disabled { cursor: default; }
.${PREFIX}-sk-cand-main input:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))); outline-offset: 2px; }
.${PREFIX}-sk-cand-done { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; margin-top: 3px; color: var(--dsw-alias-state-success-primary); }
.${PREFIX}-sk-cand[data-disabled] .${PREFIX}-sk-cand-name { color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-sk-cand-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.${PREFIX}-sk-cand-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; min-width: 0; }
.${PREFIX}-sk-cand-name { min-width: 0; max-width: 100%; margin-right: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; line-height: 22px; font-weight: 500; }
.${PREFIX}-sk-cand-desc { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-sk-cand-desc[data-tone="error"] { white-space: normal; overflow-wrap: anywhere; color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-sk-cand-places { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-sk-cand-side { flex: none; display: flex; align-items: center; padding-top: 1px; }
.${PREFIX}-sk-dialog-names { color: var(--dsw-alias-label-primary); font-weight: 500; }

@media (prefers-reduced-motion: reduce) {
  .${PREFIX}-sk-row[data-new], .${PREFIX}-sk-cand[data-new] { animation: none; box-shadow: inset 3px 0 0 var(--dsw-alias-state-success-primary); }
  .${PREFIX}-sk-result, .${PREFIX}-sk-saved, .${PREFIX}-sk-panel, .${PREFIX}-sk-bar { animation: none; }
  .${PREFIX}-sk-row, .${PREFIX}-sk-cand, .${PREFIX}-sk-chip, .${PREFIX}-sk-groups, .${PREFIX}-sk-group-toggle, .${PREFIX}-sk-group-toggle > svg { transition: none; }
}
`);
