// Skills settings page: list → detail / create / import drill-in over the Host
// routes `skills-*` (docs/host-api.md). View state, drafts, the selected
// workspace, and the last import result live in the controller store, so
// closing and reopening Settings lands where the user left off.

/** Scans with at most this many valid skills start fully selected. */
const SK_AUTO_SELECT_MAX = 3;

const SK_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SK_NAME_MAX = 64;
const SK_ROOT_IDS = ['user-dsh', 'user-agents', 'project-dsh', 'project-agents'];
const SK_DEFAULT_LOCATION = 'user-dsh';
const SK_SCOPES = ['project', 'user', 'builtin'];
/** Select value for "hide project skills"; workspace paths are absolute, so they never start with ':'. */
const SK_NO_PROJECT = ':none';
const SK_HIGHLIGHT_MS = 2400;
const SK_SAVED_MS = 1800;
/** The Host drops scan checkouts after 15 minutes; results older than this are discarded on reopen. */
const SK_SCAN_TTL_MS = 14 * 60 * 1000;
const SK_WORKSPACE_WAIT_MS = 1500;
const SK_EXAMPLES = [
  'https://github.com/anthropics/skills',
  'https://github.com/anthropics/skills/tree/main/skills/pdf',
  '~/Downloads/my-skill',
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
  manual: 'sk_badgeManual',
  noMenu: 'sk_badgeNoMenu',
  shadowed: 'sk_badgeShadowed',
  invalid: 'sk_badgeInvalid',
};
const SK_NAME_ERRORS = { required: 'sk_nameRequired', invalid: 'sk_nameInvalid', tooLong: 'sk_nameTooLong' };

addDict({
  sk_nav: '技能',
  sk_title: '技能',
  sk_intro: '技能是按需加载的任务说明。Agent 会根据描述自动使用，你也可以在输入框输入 / 调用。',
  sk_searchPlaceholder: '搜索技能',
  sk_import: '导入',
  sk_new: '新建技能',
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
  sk_emptyHint: '新建一个，或从 GitHub 链接、本地文件夹导入。',
  sk_noMatch: '没有匹配「{query}」的技能',
  sk_incomplete: '暂时读不到内置技能，列表可能不完整。',
  sk_listLoading: '正在读取技能…',
  sk_resultInstalled: '已安装 {n} 个',
  sk_resultSkipped: '跳过 {n} 个',
  sk_resultFailed: '{n} 个失败',
  sk_resultRelations: '其中 {list}',
  sk_resultRelationsJoin: '、',
  sk_resultOverrides: '{n} 个会覆盖同名技能',
  sk_resultOverridesOne: '1 个会覆盖同名技能',
  sk_resultOverridden: '{n} 个被同名技能覆盖而不会生效',
  sk_resultOverriddenOne: '1 个被同名技能覆盖而不会生效',
  sk_resultOverriddenNames: '被覆盖、不会生效：{names}',
  sk_resultSep: '，',
  sk_resultSkippedNames: '已存在，未覆盖：{names}',
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
  sk_importTitle: '导入技能',
  sk_importIntro: '从 GitHub 仓库或本地文件夹安装技能。',
  sk_source: 'GitHub 链接或本地文件夹路径',
  sk_sourcePlaceholder: 'https://github.com/owner/repo 或 ~/path/to/skills',
  sk_scan: '扫描',
  sk_scanning: '扫描中…',
  sk_scanningGit: '正在克隆仓库…',
  sk_scanningLocal: '正在读取文件夹…',
  sk_examples: '例如',
  sk_found: '找到 {n} 个技能',
  sk_foundOne: '找到 1 个技能',
  sk_foundNone: '没有找到技能。技能是包含 SKILL.md 的文件夹。',
  sk_selectAll: '全选',
  sk_selectedCount: '已选 {n} / {total}',
  sk_exists: '已存在',
  sk_existsTip: '安装位置里已经有同名技能',
  sk_skip: '跳过',
  sk_overwrite: '覆盖',
  sk_conflictLabel: '{name} 已存在时',
  sk_installTo: '安装到',
  sk_install: '安装 {n} 个技能',
  sk_installOne: '安装 1 个技能',
  sk_installing: '正在安装…',
  sk_willSkip: '{n} 个已存在的技能会跳过',
  sk_willSkipOne: '1 个已存在的技能会跳过',
  sk_willOverride: '{n} 个会覆盖其他位置的同名技能',
  sk_willOverrideOne: '1 个会覆盖其他位置的同名技能',
  sk_willBeOverridden: '{n} 个会被其他位置的同名技能覆盖而不生效',
  sk_willBeOverriddenOne: '1 个会被其他位置的同名技能覆盖而不生效',
  sk_noteSep: '；',
  sk_errLine: '{title}：{detail}',
  sk_err_transport: '无法连接 DSH',
  sk_err_internal: '出错了',
  'sk_err_bad-request': '请求不正确',
  'sk_err_not-found': '找不到这个技能',
  sk_err_exists: '这个位置已经有同名技能',
  sk_err_forbidden: '没有权限：位置不在允许的技能目录里，或技能是只读的',
  sk_err_invalid: '技能内容不合法',
  'sk_err_git-failed': '无法读取 Git 仓库',
  sk_err_unavailable: 'DSH 缺少所需的服务',
  'sk_err_scan_not-found': '找不到这个文件夹或仓库',
  'sk_err_scan_bad-request': '无法识别这个来源，请输入 GitHub 链接或本地文件夹路径',
  'sk_err_install_not-found': '扫描结果已过期，请重新扫描',
  sk_err_save_forbidden: '没有权限写入这个位置',
  sk_err_delete_forbidden: '这个技能是只读的，不能删除',
}, {
  sk_nav: 'Skills',
  sk_title: 'Skills',
  sk_intro: 'Skills are task instructions loaded on demand. The agent decides when to use one from its description, and you can call one with /name in the composer.',
  sk_searchPlaceholder: 'Search skills',
  sk_import: 'Import',
  sk_new: 'New skill',
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
  sk_emptyHint: 'Create one, or import from a GitHub link or a local folder.',
  sk_noMatch: 'No skills match “{query}”',
  sk_incomplete: 'Built-in skills could not be read, so this list may be incomplete.',
  sk_listLoading: 'Loading skills…',
  sk_resultInstalled: 'Installed {n}',
  sk_resultSkipped: 'skipped {n}',
  sk_resultFailed: '{n} failed',
  sk_resultRelations: 'of which {list}',
  sk_resultRelationsJoin: ' and ',
  sk_resultOverrides: '{n} override skills with the same name',
  sk_resultOverridesOne: '1 overrides a skill with the same name',
  sk_resultOverridden: '{n} are overridden by skills with the same name and not in effect',
  sk_resultOverriddenOne: '1 is overridden by a skill with the same name and not in effect',
  sk_resultOverriddenNames: 'Overridden, not in effect: {names}',
  sk_resultSep: ', ',
  sk_resultSkippedNames: 'Already there, not overwritten: {names}',
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
  sk_importTitle: 'Import skills',
  sk_importIntro: 'Install skills from a GitHub repository or a local folder.',
  sk_source: 'GitHub link or local folder path',
  sk_sourcePlaceholder: 'https://github.com/owner/repo or ~/path/to/skills',
  sk_scan: 'Scan',
  sk_scanning: 'Scanning…',
  sk_scanningGit: 'Cloning the repository…',
  sk_scanningLocal: 'Reading the folder…',
  sk_examples: 'Examples',
  sk_found: 'Found {n} skills',
  sk_foundOne: 'Found 1 skill',
  sk_foundNone: 'No skills found. A skill is a folder that contains SKILL.md.',
  sk_selectAll: 'Select all',
  sk_selectedCount: '{n} of {total} selected',
  sk_exists: 'Exists',
  sk_existsTip: 'The install location already has a skill with this name',
  sk_skip: 'Skip',
  sk_overwrite: 'Overwrite',
  sk_conflictLabel: 'If {name} exists',
  sk_installTo: 'Install to',
  sk_install: 'Install {n} skills',
  sk_installOne: 'Install 1 skill',
  sk_installing: 'Installing…',
  sk_willSkip: '{n} existing skills will be skipped',
  sk_willSkipOne: '1 existing skill will be skipped',
  sk_willOverride: '{n} will override skills with the same name elsewhere',
  sk_willOverrideOne: '1 will override a skill with the same name elsewhere',
  sk_willBeOverridden: '{n} will be overridden by skills with the same name elsewhere and will not take effect',
  sk_willBeOverriddenOne: '1 will be overridden by a skill with the same name elsewhere and will not take effect',
  sk_noteSep: '; ',
  sk_errLine: '{title}: {detail}',
  sk_err_transport: 'Could not reach DSH',
  sk_err_internal: 'Something went wrong',
  'sk_err_bad-request': 'The request was not valid',
  'sk_err_not-found': 'Skill not found',
  sk_err_exists: 'This location already has a skill with this name',
  sk_err_forbidden: 'Not allowed: the location is outside the skill folders, or the skill is read-only',
  sk_err_invalid: 'The skill content is not valid',
  'sk_err_git-failed': 'Could not read the Git repository',
  sk_err_unavailable: 'A required DSH service is unavailable',
  'sk_err_scan_not-found': 'Folder or repository not found',
  'sk_err_scan_bad-request': 'Unrecognized source. Enter a GitHub link or a local folder path.',
  'sk_err_install_not-found': 'The scan results expired. Scan again.',
  sk_err_save_forbidden: 'This location is not writable',
  sk_err_delete_forbidden: 'This skill is read-only and cannot be deleted',
});

// ---------------------------------------------------------------------------
// Pure helpers (unit tested in test/skills-ui.test.mjs)
// ---------------------------------------------------------------------------

function skIdentity(value) { return value; }

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
  const list = Array.isArray(skills) ? skills : [];
  const rootList = Array.isArray(roots) ? roots : [];
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
  for (const root of Array.isArray(roots) ? roots : []) {
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
  const root = (Array.isArray(roots) ? roots : []).find(candidate => candidate.id === id);
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

/** Names already present in one root (import conflicts compare against these). */
function skExistingNames(skills, root) {
  const names = new Set();
  for (const item of Array.isArray(skills) ? skills : []) {
    if (item.root === root) names.add(item.name);
  }
  return names;
}

/**
 * Install payload for the selected valid candidates. Conflicting rows left on
 * "skip" are still sent (overwrite: false) so the Host reports them as skipped.
 */
function skImportPlan(candidates, selected, overwrite, existing) {
  const items = [];
  let install = 0;
  let skip = 0;
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate.valid || !selected[candidate.key]) continue;
    const conflict = existing.has(candidate.name);
    const replace = conflict && Boolean(overwrite[candidate.key]);
    items.push({ key: candidate.key, overwrite: replace });
    if (conflict && !replace) skip += 1;
    else install += 1;
  }
  return { items, install, skip };
}

/** Same-name skills: `here` in the target root (blocks create), `elsewhere` in any other root (warning only). */
function skNameConflicts(name, skills, location) {
  let here = null;
  let elsewhere = null;
  if (!name) return { here, elsewhere };
  for (const item of Array.isArray(skills) ? skills : []) {
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
  const root = (Array.isArray(roots) ? roots : []).find(candidate => candidate.id === id);
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
  for (const item of Array.isArray(skills) ? skills : []) {
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
  for (const name of Array.isArray(names) ? names : []) {
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
  return /^(~|\/|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\\\\)/.test(value);
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

/** Text for "in <path>" style messages: the skill's folder, or "DSH built-ins". */
function skItemPlace(item, t) {
  return item && (item.displayPath || item.path) ? skDisplayDir(item) : t('sk_builtinSource');
}

/** `{n}` message with an optional `<key>One` singular variant. */
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

/** Localized headline for an error code (context-specific first), with the Host message as detail. */
function skErrorInfo(error, t, context) {
  const code = (error && error.code) || 'internal';
  const keys = [context ? `sk_err_${context}_${code}` : null, `sk_err_${code}`];
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

function skInitialState() {
  const location = readPref('skillsLocation', SK_DEFAULT_LOCATION);
  const workspacePref = readPref('skillsWorkspace', undefined);
  return {
    cwd: null,
    workspacePref: workspacePref === null || (typeof workspacePref === 'string' && workspacePref) ? workspacePref : undefined,
    location: SK_ROOT_IDS.includes(location) ? location : SK_DEFAULT_LOCATION,
    list: { status: 'idle', value: null, error: null, cwd: null },
    query: '',
    builtinOpen: false,
    view: { kind: 'list' },
    focus: null,
    detail: null,
    create: null,
    imp: null,
    discard: false,
    result: null,
    highlight: null,
  };
}

function skNewDetail(id, item) {
  return {
    id, status: 'loading', error: null, item: item ?? null, files: [], filesTotal: 0,
    original: null, draft: null, attempted: 0, saving: false, saveError: null, savedAt: 0,
    deleting: false, deleteError: null, confirmDelete: false,
  };
}

function skNewCreate(template, location) {
  return { draft: skBlankDraft(template), template, location, attempted: 0, saving: false, error: null };
}

function skNewImport(location) {
  return {
    source: '', status: 'idle', error: null, scan: null, scannedAt: 0, selected: {}, overwrite: {},
    location, installing: false, installError: null,
  };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * Owns the Host calls and all page state. Store shape: see skInitialState();
 * `detail`, `create`, and `imp` hold the per-view state described above their
 * constructors. Components read it through `props.useSkills(selector)`.
 */
function createSkillsController(ctx, t) {
  const rpc = createRpc(ctx);
  const store = createStore(skInitialState());
  const timers = new Set();
  const gen = { list: 0, detail: 0, scan: 0 };
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
  const patchImport = patch => update(s => (s.imp ? { imp: { ...s.imp, ...(typeof patch === 'function' ? patch(s.imp) : patch) } } : {}));

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

  async function loadList() {
    const token = ++gen.list;
    const cwd = get().cwd;
    update(s => ({ list: { ...s.list, status: 'loading' } }));
    try {
      const value = await rpc('skills-list', cwd ? { cwd } : {});
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
      const value = await rpc('skills-read', withCwd({ id }));
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

  /** Back to the list, dropping the draft of the view being left; focus returns to whatever opened it. */
  function leave() {
    const s = get();
    const view = s.view;
    const focus = view.kind === 'detail' ? { kind: 'row', id: view.id }
      : view.kind === 'create' ? { kind: 'new' }
        : view.kind === 'import' ? { kind: 'import' } : null;
    if (view.kind === 'detail') gen.detail += 1;
    update({
      view: { kind: 'list' }, focus, discard: false,
      detail: view.kind === 'detail' ? null : s.detail,
      create: view.kind === 'create' ? null : s.create,
    });
  }

  const face = {
    hooks: { skills: store },

    /** The page mounted: close leftover dialogs and revalidate what was already loaded. */
    activate() {
      update(s => ({ discard: false, detail: s.detail && !s.detail.deleting ? { ...s.detail, confirmDelete: false } : s.detail }));
      if (!requested) return;
      void loadList();
      const s = get();
      if (s.view.kind === 'detail' && s.detail) void loadDetail(s.detail.id, true);
    },
    /** The component resolved which workspace to list (null = none); the first call starts loading. */
    setCwd(path) {
      const next = typeof path === 'string' && path ? path : null;
      if (requested && next === get().cwd) return;
      requested = true;
      update({ cwd: next });
      void loadList();
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

    openDetail(id) {
      const s = get();
      const keep = s.detail && s.detail.id === id && s.detail.draft;
      update({ view: { kind: 'detail', id }, focus: null, detail: keep ? s.detail : skNewDetail(id, skFindItem(s.list.value, id)) });
      void loadDetail(id, Boolean(keep));
    },
    retryDetail() {
      const d = get().detail;
      if (d) void loadDetail(d.id, false);
    },
    openCreate() {
      const s = get();
      const template = t('sk_bodyTemplate');
      update({ view: { kind: 'create' }, focus: null, create: s.create ?? skNewCreate(template, s.location) });
    },
    openImport() {
      const s = get();
      let imp = s.imp;
      if (imp && imp.scan && Date.now() - imp.scannedAt > SK_SCAN_TTL_MS) {
        imp = { ...imp, scan: null, status: 'idle', selected: {}, overwrite: {}, installError: null };
      }
      update({ view: { kind: 'import' }, focus: null, imp: imp ?? skNewImport(s.location) });
    },
    /** Back to the list; a dirty editor asks first. */
    back() {
      const s = get();
      if (s.view.kind === 'detail' && s.detail && skDraftDirty(s.detail.draft, s.detail.original)) {
        update({ discard: true });
        return;
      }
      if (s.view.kind === 'create' && s.create && skDraftDirty(s.create.draft, skBlankDraft(s.create.template))) {
        update({ discard: true });
        return;
      }
      leave();
    },
    confirmDiscard() { leave(); },
    cancelDiscard() { update({ discard: false }); },

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
      if (!d || !d.draft || !d.item || !d.item.editable || d.saving) return;
      if (!skDraftDirty(d.draft, d.original)) return;
      if (!d.draft.description.trim()) {
        patchDetail(d.id, dd => ({ attempted: dd.attempted + 1 }));
        return;
      }
      const id = d.id;
      const submitted = d.draft;
      patchDetail(id, { saving: true, saveError: null, savedAt: 0 });
      try {
        const result = await rpc('skills-save', withCwd({ target: { create: false, id }, ...skSavePayload(submitted, d.original.name) }));
        if (disposed) return;
        const stamp = Date.now();
        const nextId = result && result.item && result.item.id ? result.item.id : id;
        patchDetail(id, dd => ({ id: nextId, saving: false, item: (result && result.item) || dd.item, original: submitted, attempted: 0, savedAt: stamp }));
        if (nextId !== id) update(s => (s.view.kind === 'detail' && s.view.id === id ? { view: { kind: 'detail', id: nextId } } : {}));
        later(SK_SAVED_MS, () => patchDetail(nextId, dd => (dd.savedAt === stamp ? { savedAt: 0 } : {})));
        void loadList();
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
        await rpc('skills-delete', withCwd({ id }));
        if (disposed) return;
        gen.detail += 1;
        update(s => ({
          detail: null, focus: { kind: 'search' },
          view: s.view.kind === 'detail' && s.view.id === id ? { kind: 'list' } : s.view,
        }));
        void loadList();
      } catch (error) {
        patchDetail(id, { deleting: false, deleteError: skErr(error) });
      }
    },

    setCreateField(field, value) {
      patchCreate(c => ({ draft: { ...c.draft, [field]: value } }));
    },
    setCreateLocation(root) {
      if (!SK_ROOT_IDS.includes(root)) return;
      writePref('skillsLocation', root);
      update(s => ({ location: root, create: s.create ? { ...s.create, location: root } : s.create }));
    },
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
        const result = await rpc('skills-save', withCwd({ target: { create: true, root: location }, ...skSavePayload(draft, draft.name) }));
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

    setImportSource(source) { patchImport({ source: String(source ?? ''), error: null }); },
    async scan() {
      const imp = get().imp;
      if (!imp || imp.status === 'scanning' || imp.installing) return;
      const source = imp.source.trim();
      if (!source) return;
      const token = ++gen.scan;
      patchImport({ source, status: 'scanning', error: null, installError: null, scan: null, selected: {}, overwrite: {} });
      try {
        const value = await rpc('skills-scan', { source });
        if (disposed || token !== gen.scan) return;
        const candidates = value && Array.isArray(value.candidates) ? value.candidates : [];
        // A small source (one skill or a handful) starts fully selected; a catalog-sized
        // repository starts empty so nothing is installed without an explicit choice.
        const selected = {};
        const valid = candidates.filter(candidate => candidate.valid);
        if (valid.length <= SK_AUTO_SELECT_MAX) for (const candidate of valid) selected[candidate.key] = true;
        patchImport({ status: 'ready', scan: { ...value, candidates }, selected, overwrite: {}, scannedAt: Date.now() });
      } catch (error) {
        if (disposed || token !== gen.scan) return;
        patchImport({ status: 'error', error: skErr(error) });
      }
    },
    toggleCandidate(key, on) { patchImport(imp => ({ selected: { ...imp.selected, [key]: Boolean(on) } })); },
    toggleAllCandidates(on) {
      patchImport((imp) => {
        const selected = {};
        for (const candidate of imp.scan ? imp.scan.candidates : []) if (candidate.valid) selected[candidate.key] = Boolean(on);
        return { selected };
      });
    },
    setCandidateOverwrite(key, on) { patchImport(imp => ({ overwrite: { ...imp.overwrite, [key]: Boolean(on) } })); },
    setImportLocation(root) {
      if (!SK_ROOT_IDS.includes(root)) return;
      writePref('skillsLocation', root);
      update(s => ({ location: root, imp: s.imp ? { ...s.imp, location: root } : s.imp }));
    },
    async install() {
      const s = get();
      const imp = s.imp;
      if (!imp || !imp.scan || imp.installing || imp.status === 'scanning') return;
      const listing = s.list.value;
      const root = skEffectiveLocation(imp.location, skHasProject(listing));
      const plan = skImportPlan(imp.scan.candidates, imp.selected, imp.overwrite, skExistingNames(listing ? listing.skills : [], root));
      if (plan.install === 0) return;
      patchImport({ installing: true, installError: null });
      try {
        const value = await rpc('skills-install', withCwd({ scanId: imp.scan.scanId, root, items: plan.items }));
        if (disposed) return;
        const list = key => (value && Array.isArray(value[key]) ? value[key] : []);
        const at = Date.now();
        const result = { installed: list('installed'), skipped: list('skipped'), failed: list('failed'), root, at };
        // Judged against the listing the user saw while choosing; same-root copies never count.
        Object.assign(result, skInstallRelations(result.installed, listing ? listing.skills : [], root, listing ? listing.roots : []));
        writePref('skillsLocation', root);
        gen.scan += 1;
        update({
          imp: null, location: root, result, view: { kind: 'list' }, focus: { kind: 'import' },
          highlight: result.installed.length ? { id: at, names: result.installed, root, armed: false } : null,
        });
        void loadList();
      } catch (error) {
        patchImport({ installing: false, installError: skErr(error) });
      }
    },
  };

  return {
    face,
    refresh() {
      if (!requested) return;
      void loadList();
      const s = get();
      if (s.view.kind === 'detail' && s.detail) void loadDetail(s.detail.id, true);
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
  if (view.kind === 'detail') body = h(SkillDetailView, { face: props, state, t });
  else if (view.kind === 'create') body = h(SkillCreateView, { face: props, state, t });
  else if (view.kind === 'import') body = h(SkillImportView, { face: props, state, t });
  else body = h(SkillListView, { face: props, state, t, workspaces, resolved });

  return h('div', { className: `${PREFIX}-root` },
    h(Styles),
    h(ViewFrame, { viewKey: view.kind === 'detail' ? `detail:${view.id}` : view.kind }, body),
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
    h(SkillDeleteDialog, { face: props, state, t }));
}

// ---- List ----------------------------------------------------------------

function skFocusTarget(container, focus) {
  if (focus.kind === 'row') {
    return [...container.querySelectorAll('[data-sk-row]')].find(node => node.dataset.skRow === focus.id) ?? null;
  }
  if (focus.kind === 'search') return container.querySelector('input[type="search"]');
  return container.querySelector(`[data-sk-focus="${focus.kind}"]`);
}

function SkillListView({ face, state, t, workspaces, resolved }) {
  const rootRef = useRef(null);
  const listing = state.list.value;
  const hasValue = Boolean(listing);
  const groups = useMemo(
    () => skGroupSkills(listing ? listing.skills : [], listing ? listing.roots : [], state.query),
    [listing, state.query],
  );

  useEffect(() => {
    const focus = state.focus;
    const node = rootRef.current;
    if (!focus || !node) return;
    if (focus.kind === 'row' && !hasValue) return;
    const target = skFocusTarget(node, focus);
    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView?.({ block: 'nearest' });
    }
    face.consumeFocus();
  }, [state.focus, hasValue]);

  const searching = state.query.trim() !== '';
  const own = groups.filter(group => group.scope !== 'builtin').reduce((sum, group) => sum + group.total, 0);
  const shown = groups.filter(group => group.items.length > 0);
  const home = skHomeFrom(listing ? listing.roots : []);
  const projectName = resolved.workspace ? resolved.workspace.title : skBaseName(state.cwd || '');
  const switching = state.list.status === 'loading' && hasValue && state.list.cwd !== state.cwd;

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
              highlight: state.highlight,
              title: group.scope === 'project' ? fill(t('sk_groupProject'), { name: projectName })
                : group.scope === 'user' ? t('sk_groupUser') : t('sk_groupBuiltin'),
              collapsible: builtin && !forced,
              open: builtin ? (forced || state.builtinOpen) : true,
            });
          }))
        : null);
  }

  return h('div', { ref: rootRef, className: `${PREFIX}-sk-stack` },
    h(PageHeader, { title: t('sk_title'), intro: t('sk_intro') }),
    state.result ? h(SkillResultLine, { result: state.result, t, onDismiss: face.dismissResult }) : null,
    h('div', { className: `${PREFIX}-sk-toolbar` },
      h(SearchInput, { value: state.query, onValue: face.setQuery, placeholder: t('sk_searchPlaceholder'), t }),
      h(Button, { icon: Icon.download(14), onClick: face.openImport, 'data-sk-focus': 'import' }, t('sk_import')),
      h(Button, { variant: 'primary', icon: Icon.plus(14), onClick: face.openCreate, 'data-sk-focus': 'new' }, t('sk_new'))),
    workspaces.length
      ? h(SkillWorkspacePicker, { t, workspaces, resolved, home, onPick: face.pickWorkspace })
      : null,
    content);
}

function SkillWorkspacePicker({ t, workspaces, resolved, home, onPick }) {
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
      icon: Icon.folder(14),
    }));
}

function SkillListSkeleton({ t }) {
  return h('div', { className: `${PREFIX}-sk-skeletons`, role: 'status' },
    h('span', { className: `${PREFIX}-visually-hidden` }, t('sk_listLoading')),
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
      h(Button, { icon: Icon.download(14), onClick: face.openImport }, t('sk_import'))));
}

function SkillGroup({ group, title, collapsible, open, t, face, highlight }) {
  const listId = `${PREFIX}-sk-group-${group.scope}`;
  const count = h('span', { className: `${PREFIX}-count` }, String(group.items.length));
  const meta = group.scope === 'builtin'
    ? h('span', { className: `${PREFIX}-sk-group-meta` }, t('sk_readOnly'))
    : group.paths.length
      ? h('span', { className: cx(`${PREFIX}-sk-group-meta`, `${PREFIX}-mono`), title: group.paths.join('\n') }, group.paths.join(' · '))
      : null;
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
      open ? group.items.map(item => h(SkillRow, { key: item.id, item, t, onOpen: face.openDetail, fresh: skIsHighlighted(item, highlight) })) : null));
}

function SkillBadges({ item, t, omit }) {
  const badges = skBadges(item).filter(badge => !omit || !omit.includes(badge.id));
  if (!badges.length) return null;
  return h(Fragment, null, badges.map((badge) => {
    let title;
    if (badge.id === 'shadowed') title = fill(t('sk_badgeShadowedTip'), { path: badge.path || t('sk_builtinSource') });
    else if (badge.id === 'invalid') title = badge.reason;
    else title = t(`${SK_BADGE_LABELS[badge.id]}Tip`);
    return h(Tag, { key: badge.id, tone: badge.tone, title }, t(SK_BADGE_LABELS[badge.id]));
  }));
}

function SkillRow({ item, t, onOpen, fresh }) {
  const description = item.description || (item.invalid ? '' : t('sk_noDescription'));
  return h('button', {
    type: 'button',
    className: `${PREFIX}-sk-row`,
    'data-sk-row': item.id,
    'data-new': fresh ? '' : undefined,
    'data-inactive': item.active === false ? '' : undefined,
    onClick: () => onOpen(item.id),
  },
  h('span', { className: `${PREFIX}-sk-row-head` },
    h('span', { className: `${PREFIX}-sk-row-name` }, item.name),
    h(SkillBadges, { item, t })),
  description
    ? h('span', { className: `${PREFIX}-sk-row-desc` }, description)
    : h('span', { className: `${PREFIX}-sk-row-desc`, 'data-tone': 'error' }, item.invalid));
}

function SkillResultLine({ result, t, onDismiss }) {
  const overrides = Array.isArray(result.overrides) ? result.overrides : [];
  const overridden = Array.isArray(result.overridden) ? result.overridden : [];
  // 「已安装 2 个，其中 1 个会覆盖同名技能、1 个被同名技能覆盖而不会生效，跳过 1 个」:
  // the relations qualify the installed count, so they follow it as one clause.
  const parts = [fill(t('sk_resultInstalled'), { n: result.installed.length })];
  const relations = [
    overrides.length ? skCount(t, 'sk_resultOverrides', overrides.length) : null,
    overridden.length ? skCount(t, 'sk_resultOverridden', overridden.length) : null,
  ].filter(Boolean);
  if (relations.length) parts.push(fill(t('sk_resultRelations'), { list: relations.join(t('sk_resultRelationsJoin')) }));
  if (result.skipped.length) parts.push(fill(t('sk_resultSkipped'), { n: result.skipped.length }));
  if (result.failed.length) parts.push(fill(t('sk_resultFailed'), { n: result.failed.length }));
  const warn = result.failed.length > 0 || overridden.length > 0;
  return h('div', { className: `${PREFIX}-sk-result`, 'data-tone': warn ? 'warn' : 'success', role: 'status' },
    h('span', { className: `${PREFIX}-sk-result-icon` }, warn ? Icon.warning(14) : Icon.check(14)),
    h('div', { className: `${PREFIX}-sk-result-body` },
      h('div', { className: `${PREFIX}-sk-result-text` }, parts.join(t('sk_resultSep'))),
      overridden.length
        ? h('div', { className: `${PREFIX}-sk-result-meta` }, fill(t('sk_resultOverriddenNames'), { names: overridden.join(t('sk_nameSep')) }))
        : null,
      result.skipped.length
        ? h('div', { className: `${PREFIX}-sk-result-meta` }, fill(t('sk_resultSkippedNames'), { names: result.skipped.join(t('sk_nameSep')) }))
        : null,
      result.failed.length
        ? h('ul', { className: `${PREFIX}-sk-result-failures` },
          result.failed.map((failure, index) => h('li', { key: `${failure.name}-${index}` },
            fill(t('sk_resultFailure'), { name: failure.name, error: failure.error }))))
        : null),
    h(IconButton, { label: t('sk_dismiss'), icon: Icon.close(12), onClick: onDismiss, className: `${PREFIX}-sk-result-close` }));
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
      h(SkillBanners, { item, t }),
      h(SkillEditor, {
        t, draft: d.draft, readOnly: !editable, onField: face.setDetailField,
        errors: { description: d.attempted && !d.draft.description.trim() ? t('sk_descriptionRequired') : null },
      }),
      d.filesTotal > 0 || d.files.length > 0 ? h(SkillFiles, { files: d.files, total: Math.max(d.filesTotal, d.files.length), t }) : null,
      saveError ? h(Alert, { tone: 'error', title: saveError.title }, saveError.detail || null) : null,
      editable
        ? h('div', { className: `${PREFIX}-sk-actions` },
          h(Button, { variant: 'danger', icon: Icon.trash(14), onClick: face.requestDelete, disabled: d.saving }, t('sk_deleteSkill')),
          h('div', { className: `${PREFIX}-actions-end` },
            d.savedAt && !dirty ? h('span', { className: `${PREFIX}-sk-saved`, role: 'status' }, Icon.check(12), t('sk_saved')) : null,
            h(Button, { onClick: face.revertDetail, disabled: !dirty || d.saving }, t('c_cancel')),
            h(Button, { variant: 'primary', onClick: face.saveDetail, disabled: !dirty || d.saving, busy: d.saving },
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
    status: item ? h('span', { className: `${PREFIX}-sk-title-tags` }, h(SkillBadges, { item, t, omit: ['manual', 'noMenu'] })) : null,
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

// ---- Import ---------------------------------------------------------------

function SkillCandidateRow({ candidate, selected, conflict, relation, overwrite, busy, t, face }) {
  const usable = candidate.valid;
  return h('div', { className: `${PREFIX}-sk-cand`, 'data-disabled': usable ? undefined : '' },
    h('label', { className: `${PREFIX}-sk-cand-main` },
      h('input', {
        type: 'checkbox', checked: usable && selected, disabled: !usable || busy,
        onChange: event => face.toggleCandidate(candidate.key, event.target.checked),
      }),
      h('span', { className: `${PREFIX}-sk-cand-text` },
        h('span', { className: `${PREFIX}-sk-cand-head` },
          h('span', { className: `${PREFIX}-sk-cand-name`, title: candidate.key }, candidate.name),
          usable && conflict ? h(Tag, { tone: 'warn', title: t('sk_existsTip') }, t('sk_exists')) : null,
          usable && relation
            ? h(Tag, { tone: 'warn', title: skShadowTitle(relation, t) },
              h('span', { 'aria-hidden': true }, t(relation.direction === 'overrides' ? 'sk_tagOverrides' : 'sk_tagOverridden')),
              h('span', { className: `${PREFIX}-visually-hidden` }, skShadowText(relation, t)))
            : null,
          usable ? null : h(Tag, { tone: 'error' }, t('sk_badgeInvalid'))),
        usable
          ? h('span', { className: `${PREFIX}-sk-cand-desc`, title: candidate.description || undefined }, candidate.description || t('sk_noDescription'))
          : h('span', { className: `${PREFIX}-sk-cand-desc`, 'data-tone': 'error' }, candidate.error || t('sk_badgeInvalid')))),
    usable && conflict
      ? h('div', { className: `${PREFIX}-sk-cand-side` },
        h(Segmented, {
          label: fill(t('sk_conflictLabel'), { name: candidate.name }),
          size: 'sm',
          value: overwrite ? 'overwrite' : 'skip',
          disabled: busy || !selected,
          options: [{ value: 'skip', label: t('sk_skip') }, { value: 'overwrite', label: t('sk_overwrite') }],
          onChange: value => face.setCandidateOverwrite(candidate.key, value === 'overwrite'),
        }))
      : null);
}

function SkillImportView({ face, state, t }) {
  const imp = state.imp;
  const inputRef = useRef(null);
  const uid = useId().replace(/:/g, '');
  useEffect(() => { if (!imp) face.openImport(); }, [imp === null]);
  if (!imp) return null;

  const listing = state.list.value;
  const hasProject = skHasProject(listing);
  const location = skEffectiveLocation(imp.location, hasProject);
  const existing = skExistingNames(listing ? listing.skills : [], location);
  const candidates = imp.scan ? imp.scan.candidates : [];
  const valid = candidates.filter(candidate => candidate.valid);
  const selectedCount = valid.filter(candidate => imp.selected[candidate.key]).length;
  const plan = skImportPlan(candidates, imp.selected, imp.overwrite, existing);
  const skills = listing ? listing.skills : [];
  const roots = listing ? listing.roots : [];
  // Names that would actually be written, judged against same-name skills in other roots.
  const landing = valid
    .filter(candidate => imp.selected[candidate.key] && (!existing.has(candidate.name) || imp.overwrite[candidate.key]))
    .map(candidate => candidate.name);
  const relations = skInstallRelations(landing, skills, location, roots);
  const note = [
    plan.skip ? skCount(t, 'sk_willSkip', plan.skip) : null,
    relations.overrides.length ? skCount(t, 'sk_willOverride', relations.overrides.length) : null,
    relations.overridden.length ? skCount(t, 'sk_willBeOverridden', relations.overridden.length) : null,
  ].filter(Boolean).join(t('sk_noteSep'));
  const scanning = imp.status === 'scanning';
  const busy = scanning || imp.installing;
  const scanError = imp.status === 'error' && imp.error ? skErrorInfo(imp.error, t, 'scan') : null;
  const installError = imp.installError ? skErrorInfo(imp.installError, t, 'install') : null;
  const found = skCount(t, 'sk_found', candidates.length);

  const results = imp.scan
    ? h('section', { className: `${PREFIX}-sk-results`, 'aria-label': found },
      h('div', { className: `${PREFIX}-sk-results-head` },
        h('h3', { className: `${PREFIX}-section-title` }, found),
        imp.scan.label ? h('span', { className: cx(`${PREFIX}-sk-results-from`, `${PREFIX}-mono`), title: imp.scan.label }, imp.scan.label) : null),
      candidates.length === 0
        ? h('p', { className: `${PREFIX}-sk-nomatch` }, t('sk_foundNone'))
        : h('div', { className: cx(`${PREFIX}-card`, `${PREFIX}-sk-cands`) },
          valid.length > 1
            ? h('div', { className: `${PREFIX}-sk-cands-bar` },
              h(Checkbox, {
                checked: selectedCount === valid.length,
                indeterminate: selectedCount > 0 && selectedCount < valid.length,
                disabled: busy,
                label: t('sk_selectAll'),
                onChange: face.toggleAllCandidates,
              }),
              h('span', { className: `${PREFIX}-sk-cands-count` }, fill(t('sk_selectedCount'), { n: selectedCount, total: valid.length })))
            : null,
          h('div', { className: `${PREFIX}-sk-cands-list` },
            candidates.map(candidate => h(SkillCandidateRow, {
              key: candidate.key,
              candidate,
              selected: Boolean(imp.selected[candidate.key]),
              conflict: existing.has(candidate.name),
              relation: candidate.valid ? skShadowRelation(candidate.name, skills, location, roots) : null,
              overwrite: Boolean(imp.overwrite[candidate.key]),
              busy,
              t,
              face,
            })))),
      valid.length
        ? h(Fragment, null,
          h('div', { className: `${PREFIX}-sk-loc` },
            h(Field, { label: t('sk_installTo'), htmlFor: `${uid}-loc`, t },
              h(Select, {
                id: `${uid}-loc`, label: t('sk_installTo'), value: location, disabled: busy,
                options: skLocationOptions(listing ? listing.roots : [], hasProject, t), onChange: face.setImportLocation,
                icon: location.startsWith('project-') ? Icon.folder(14) : Icon.user(14),
              }))),
          installError ? h(Alert, { tone: 'error', title: installError.title }, installError.detail || null) : null,
          h('div', { className: `${PREFIX}-sk-actions` },
            h('span', { className: `${PREFIX}-sk-install-note`, 'aria-live': 'polite', 'data-tone': relations.overridden.length ? 'warn' : undefined }, note),
            h('div', { className: `${PREFIX}-actions-end` },
              h(Button, {
                variant: 'primary', icon: Icon.download(14), onClick: face.install,
                disabled: plan.install === 0 || busy, busy: imp.installing,
              }, imp.installing ? t('sk_installing') : skCount(t, 'sk_install', plan.install)))))
        : null)
    : null;

  return h('div', { className: `${PREFIX}-sk-stack` },
    h(BackBar, { label: t('sk_title'), onBack: face.back, t }),
    h(DetailTitle, { title: t('sk_importTitle'), subtitle: t('sk_importIntro') }),
    h(Field, { label: t('sk_source'), htmlFor: `${uid}-src`, t },
      h('div', { className: `${PREFIX}-sk-source` },
        h(TextInput, {
          ref: inputRef, id: `${uid}-src`, value: imp.source, mono: true, disabled: busy,
          placeholder: t('sk_sourcePlaceholder'), onValue: face.setImportSource,
          onKeyDown: (event) => {
            if (event.key === 'Enter' && !(event.nativeEvent && event.nativeEvent.isComposing)) { event.preventDefault(); face.scan(); }
          },
        }),
        h(Button, {
          variant: imp.scan ? 'secondary' : 'primary', onClick: face.scan,
          disabled: busy || !imp.source.trim(), busy: scanning,
        }, scanning ? t('sk_scanning') : t('sk_scan'))),
      h('div', { className: `${PREFIX}-sk-examples` },
        h('span', { className: `${PREFIX}-sk-examples-label` }, t('sk_examples')),
        SK_EXAMPLES.map(example => h('button', {
          key: example, type: 'button', className: `${PREFIX}-sk-chip`, disabled: busy, title: example,
          onClick: () => { face.setImportSource(example); inputRef.current?.focus(); },
        }, example.replace(/^https?:\/\//, ''))))),
    scanning
      ? h('div', { className: `${PREFIX}-sk-scanning`, role: 'status' },
        h(Spinner, { size: 14 }), t(skLooksLocal(imp.source) ? 'sk_scanningLocal' : 'sk_scanningGit'))
      : null,
    scanError ? h(Alert, { tone: 'error', title: scanError.title }, scanError.detail || null) : null,
    results);
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

addCss(`
.${PREFIX}-sk-stack { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
/* Core's .input { font: inherit } follows .mono in the cascade; restore the mono family for this page's mono fields. */
.${PREFIX}-sk-stack .${PREFIX}-input.${PREFIX}-mono { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.${PREFIX}-sk-toolbar { display: flex; align-items: center; gap: 8px; min-width: 0; }
.${PREFIX}-sk-toolbar .${PREFIX}-search { min-width: 140px; }
.${PREFIX}-sk-picker { display: flex; align-items: center; gap: 6px; min-width: 0; margin-top: -4px; }
.${PREFIX}-sk-picker-label { flex: none; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-sk-picker .${PREFIX}-select { height: 28px; max-width: min(100%, 360px); }
.${PREFIX}-sk-note { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-sk-nomatch { margin: 0; padding: 12px 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }

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

.${PREFIX}-sk-rows { overflow: hidden; }
.${PREFIX}-sk-rows[hidden] { display: none; }
.${PREFIX}-sk-row { display: flex; flex-direction: column; gap: 2px; width: 100%; min-width: 0; margin: 0; padding: 10px 14px; border: 0; border-top: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; text-align: start; cursor: pointer; transition: background-color 120ms ease; }
.${PREFIX}-sk-row:first-child { border-top: 0; }
@media (hover: hover) { .${PREFIX}-sk-row:hover { background: var(--dsw-alias-interactive-bg-hover); } }
.${PREFIX}-sk-row:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))); }
.${PREFIX}-sk-row-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; min-width: 0; }
.${PREFIX}-sk-row-name { min-width: 0; max-width: 100%; margin-right: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; line-height: 22px; font-weight: 500; }
.${PREFIX}-sk-row[data-inactive] .${PREFIX}-sk-row-name { color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-sk-row-desc { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.${PREFIX}-sk-row-desc[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-sk-row[data-new] { animation: ${PREFIX}-sk-flash 2s ease-out; }
@keyframes ${PREFIX}-sk-flash { from { background-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent); } to { background-color: transparent; } }

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
.${PREFIX}-sk-result-text { font-weight: 500; }
.${PREFIX}-sk-result-meta { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.${PREFIX}-sk-result-failures { margin: 0; padding: 0; list-style: none; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.${PREFIX}-sk-result-close { flex: none; }

.${PREFIX}-sk-title-tags { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; }
.${PREFIX}-sk-form { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
.${PREFIX}-sk-block { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.${PREFIX}-sk-warn-text { color: var(--dsw-alias-state-warn-primary); }
.${PREFIX}-sk-shortcut { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-sk-body { min-height: 120px; }
.${PREFIX}-sk-files { display: flex; flex-direction: column; margin: 0; padding: 6px 0; list-style: none; max-height: 240px; overflow-y: auto; border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-1)); }
.${PREFIX}-sk-files li { padding: 1px 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); user-select: text; }
.${PREFIX}-sk-files li.${PREFIX}-sk-files-more { font-family: inherit; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-sk-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-top: 16px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.${PREFIX}-sk-saved { display: inline-flex; align-items: center; gap: 4px; margin-right: 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-success-primary); animation: ${PREFIX}-fade 120ms ease-out; }

.${PREFIX}-sk-source { display: flex; align-items: center; gap: 8px; min-width: 0; }
.${PREFIX}-sk-source .${PREFIX}-input { flex: 1 1 auto; }
.${PREFIX}-sk-examples { display: flex; flex-wrap: wrap; align-items: center; gap: 0 2px; min-width: 0; }
.${PREFIX}-sk-examples-label { margin-right: 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-sk-chip { display: inline-block; max-width: 100%; height: 22px; padding: 0 6px; border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-secondary); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; line-height: 22px; text-decoration: underline dotted var(--dsw-alias-label-tertiary); text-underline-offset: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; transition: background-color 120ms ease, color 120ms ease; }
@media (hover: hover) { .${PREFIX}-sk-chip:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); } }
.${PREFIX}-sk-chip:disabled { opacity: 0.5; cursor: default; }
.${PREFIX}-sk-chip:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))); }
.${PREFIX}-sk-scanning { display: flex; align-items: center; gap: 8px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }

.${PREFIX}-sk-results { display: flex; flex-direction: column; gap: 12px; min-width: 0; padding-top: 16px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.${PREFIX}-sk-results-head { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
.${PREFIX}-sk-results-head .${PREFIX}-section-title { flex: none; }
.${PREFIX}-sk-results-from { flex: 1 1 auto; min-width: 0; text-align: end; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-sk-cands { overflow: hidden; }
.${PREFIX}-sk-cands-bar { display: flex; align-items: center; gap: 12px; min-height: 40px; padding: 0 14px; border-bottom: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); }
.${PREFIX}-sk-cands-count { margin-left: auto; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.${PREFIX}-sk-cands-list { max-height: min(60vh, 480px); overflow-y: auto; }
.${PREFIX}-sk-cand { display: flex; align-items: flex-start; gap: 12px; padding: 10px 14px; border-top: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); }
.${PREFIX}-sk-cand:first-child { border-top: 0; }
.${PREFIX}-sk-cand-main { flex: 1 1 auto; min-width: 0; display: flex; align-items: flex-start; gap: 10px; cursor: pointer; }
.${PREFIX}-sk-cand-main input { flex: none; width: 16px; height: 16px; margin: 3px 0 0; accent-color: var(--dsw-alias-brand-primary); cursor: inherit; }
.${PREFIX}-sk-cand-main input:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))); outline-offset: 2px; }
.${PREFIX}-sk-cand[data-disabled] .${PREFIX}-sk-cand-main { cursor: default; }
.${PREFIX}-sk-cand[data-disabled] .${PREFIX}-sk-cand-name { color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-sk-cand-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.${PREFIX}-sk-cand-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.${PREFIX}-sk-cand-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; line-height: 22px; font-weight: 500; }
.${PREFIX}-sk-cand-desc { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-sk-cand-desc[data-tone="error"] { white-space: normal; overflow-wrap: anywhere; color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-sk-cand-side { flex: none; display: flex; align-items: center; }
.${PREFIX}-sk-loc .${PREFIX}-select { align-self: flex-start; min-width: 240px; }
.${PREFIX}-sk-install-note { flex: 1 1 0%; min-width: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-sk-install-note[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }

@media (prefers-reduced-motion: reduce) {
  .${PREFIX}-sk-row[data-new] { animation: none; box-shadow: inset 3px 0 0 var(--dsw-alias-state-success-primary); }
  .${PREFIX}-sk-result, .${PREFIX}-sk-saved { animation: none; }
  .${PREFIX}-sk-row, .${PREFIX}-sk-chip, .${PREFIX}-sk-groups, .${PREFIX}-sk-group-toggle, .${PREFIX}-sk-group-toggle > svg { transition: none; }
}
`);
