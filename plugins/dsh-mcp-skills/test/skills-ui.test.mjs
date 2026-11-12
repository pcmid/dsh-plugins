// Skills page (client/20-skills.js): pure helpers and controller flows against a fake Host.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { loadPart } from './load-part.mjs'

const HELPERS = [
  'skNormalizeName', 'skValidateName', 'skMatches', 'skGroupSkills', 'skBadges',
  'skResolveWorkspace', 'skWorkspaceItems', 'skLocationOptions', 'skEffectiveLocation', 'skNameConflicts', 'skCreateProblems',
  'skHomeFrom', 'skAbbreviate', 'skDisplayDir', 'skErrorInfo', 'skErr', 'skIsHighlighted', 'skCount', 'skLooksLocal',
  'skDraftDirty', 'skDraftFromRead', 'skSavePayload', 'DICT', 'CallError', 'SK_NO_PROJECT',
  'skRootRank', 'skShadowRelation', 'skInstallRelations', 'skShadowText', 'skShadowTitle',
  'skTriState', 'skSelectableIds', 'skSelectedForDelete', 'skBatchSummary', 'skToggle',
  'skGithubRepo', 'skRepoKey', 'skVisibleSuggestions', 'skUpdateCount', 'skNeedsCheck', 'SK_REPO_SUGGESTIONS',
  'skRepoRowStatus', 'skRepoSelectable', 'skRepoInstallPlan', 'skRepoUpdatePlan', 'skPlaces', 'skResultSummary', 'skFailureText',
]
const api = loadPart(['20-skills.js'], HELPERS)
const en = key => api.DICT.en[key] ?? key
const zh = key => api.DICT.zh[key] ?? key
const plain = value => JSON.parse(JSON.stringify(value))
/** deepEqual across the VM realm boundary (arrays/objects from the sandbox have other prototypes). */
const same = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message)

const ROOTS = [
  { id: 'project-dsh', scope: 'project', path: '/home/me/proj/.dsh/skills', displayPath: '~/proj/.dsh/skills', rank: 100, exists: true },
  { id: 'project-agents', scope: 'project', path: '/home/me/proj/.agents/skills', displayPath: '~/proj/.agents/skills', rank: 200, exists: false },
  { id: 'user-dsh', scope: 'user', path: '/home/me/.dsh/skills', displayPath: '~/.dsh/skills', rank: 400, exists: true },
  { id: 'user-agents', scope: 'user', path: '/home/me/.agents/skills', displayPath: '~/.agents/skills', rank: 500, exists: true },
]

function skill(name, extra = {}) {
  const root = extra.root === undefined ? 'user-dsh' : extra.root
  const base = ROOTS.find(r => r.id === root)
  const scope = root === null ? 'builtin' : base.scope
  return {
    id: root === null ? `builtin:${name}` : `${base.path}/${name}/SKILL.md`,
    name, description: `${name} description`, modelInvocable: true, userInvocable: true, root, scope,
    source: root ?? 'bundled', layout: root === null ? 'builtin' : 'bundle', editable: root !== null, active: true,
    ...(root === null ? {} : { path: `${base.path}/${name}/SKILL.md`, displayPath: `${base.displayPath}/${name}/SKILL.md`, dir: `${base.path}/${name}` }),
    ...extra,
  }
}

/** A local copy of a repository skill (RepoSkill.installs entry). */
function copy(root, name, extra = {}) {
  const base = ROOTS.find(r => r.id === root)
  return {
    skillId: `${base.path}/${name}/SKILL.md`, root, path: `${base.path}/${name}`, displayPath: `${base.displayPath}/${name}`,
    tracked: false, updateAvailable: false, modified: false, active: true, ...extra,
  }
}

function repoSkill(name, installs = [], extra = {}) {
  return { key: `skills/${name}`, name, description: `${name} from the repository`, valid: true, fileCount: 2, installs, ...extra }
}

const REPO = {
  id: 'r1', label: 'anthropics/skills', kind: 'git',
  source: 'https://github.com/anthropics/skills/tree/HEAD/skills', url: 'https://github.com/anthropics/skills.git',
  webUrl: 'https://github.com/anthropics/skills/tree/HEAD/skills', subpath: 'skills',
  addedAt: 1, checkedAt: Date.now(), commit: 'abc1234def5678', skillCount: 4, installedCount: 1, updateCount: 1,
}

describe('name normalization and validation', () => {
  test('normalizes while typing', () => {
    assert.equal(api.skNormalizeName('My Skill'), 'my-skill')
    assert.equal(api.skNormalizeName('Café_Notes!'), 'cafe-notes')
    assert.equal(api.skNormalizeName('--a--b'), 'a-b')
    assert.equal(api.skNormalizeName('中文 skill'), 'skill')
    assert.equal(api.skNormalizeName('pdf.tools v2'), 'pdf-tools-v2')
    assert.equal(api.skNormalizeName('abc-'), 'abc-', 'a trailing hyphen stays so the next word can be typed')
  })

  test('validates the Host rule', () => {
    assert.equal(api.skValidateName(''), 'required')
    assert.equal(api.skValidateName('a'.repeat(65)), 'tooLong')
    assert.equal(api.skValidateName('a'.repeat(64)), null)
    assert.equal(api.skValidateName('abc-'), 'invalid')
    assert.equal(api.skValidateName('a--b'), 'invalid')
    assert.equal(api.skValidateName('Abc'), 'invalid')
    assert.equal(api.skValidateName('a-b-1'), null)
  })
})

describe('grouping and filtering', () => {
  const skills = [
    skill('alpha', { root: 'project-dsh' }),
    skill('beta', { description: 'Summarize PDF files' }),
    skill('gamma', { root: 'user-agents' }),
    skill('pdf', { root: null, description: 'Built-in PDF helper' }),
  ]

  test('groups by scope in display order with root paths', () => {
    const groups = api.skGroupSkills(skills, ROOTS, '')
    same(groups.map(g => g.scope), ['project', 'user', 'builtin'])
    same(groups.map(g => g.items.map(i => i.name)), [['alpha'], ['beta', 'gamma'], ['pdf']])
    same(groups[0].paths, ['~/proj/.dsh/skills'], 'only roots that exist are listed when any exists')
    same(groups[1].paths, ['~/.dsh/skills', '~/.agents/skills'])
    same(groups[2].paths, [])
  })

  test('search matches name and description, case-insensitive, across groups', () => {
    const groups = api.skGroupSkills(skills, ROOTS, '  PDF ')
    same(groups.map(g => g.items.map(i => i.name)), [[], ['beta'], ['pdf']])
    assert.equal(groups[1].total, 2, 'totals stay unfiltered')
    assert.equal(api.skMatches(skills[1], 'summarize files'), true, 'every token must match somewhere')
    assert.equal(api.skMatches(skills[1], 'summarize words'), false)
  })

  test('tolerates a missing listing', () => {
    same(api.skGroupSkills(undefined, undefined, 'x').map(g => g.items.length), [0, 0, 0])
  })
})

describe('badges', () => {
  test('lists badges in display order', () => {
    const item = skill('x', {
      root: 'user-agents', modelInvocable: false, userInvocable: false, active: false,
      shadowedBy: { id: 'p', displayPath: '~/proj/.dsh/skills/x/SKILL.md', root: 'project-dsh' }, invalid: 'bad yaml',
    })
    same(api.skBadges(item), [
      { id: 'agents', tone: 'outline' },
      { id: 'manual', tone: 'neutral' },
      { id: 'noMenu', tone: 'neutral' },
      { id: 'shadowed', tone: 'warn', path: '~/proj/.dsh/skills/x' },
      { id: 'invalid', tone: 'error', reason: 'bad yaml' },
    ])
    same(api.skBadges(skill('y')), [{ id: 'dsh', tone: 'outline' }])
    same(api.skBadges(skill('z', { root: null })), [])
  })

  test('skills installed from a repository carry the repository, update, and modified badges', () => {
    const origin = { repoId: 'r1', repoLabel: 'anthropics/skills', key: 'skills/pdf', updateAvailable: true, modified: true, installedAt: 1 }
    same(api.skBadges(skill('pdf', { origin })), [
      { id: 'dsh', tone: 'outline' },
      { id: 'repo', tone: 'neutral', repo: 'anthropics/skills' },
      { id: 'update', tone: 'info' },
      { id: 'modified', tone: 'outline' },
    ])
    same(api.skBadges(skill('pdf', { origin: { ...origin, updateAvailable: false, modified: false } })).map(b => b.id), ['dsh', 'repo'])
  })
})

describe('workspaces and locations', () => {
  const items = api.skWorkspaceItems({ items: [{ workspaceId: 'w1', path: '/home/me/proj', title: 'proj' }, { workspaceId: 'w2', path: '/home/me/other' }, { workspaceId: 'w3' }] })

  test('normalizes workspace items', () => {
    same(items, [{ id: 'w1', path: '/home/me/proj', title: 'proj' }, { id: 'w2', path: '/home/me/other', title: 'other' }])
  })

  test('resolves the selected workspace', () => {
    same(api.skResolveWorkspace(null, items, 'ready'), { ready: true, path: null, workspace: null })
    assert.equal(api.skResolveWorkspace('/home/me/other', items, 'ready').path, '/home/me/other')
    assert.equal(api.skResolveWorkspace(undefined, items, 'ready').path, '/home/me/proj', 'defaults to the first workspace')
    assert.equal(api.skResolveWorkspace('/gone', items, 'ready').path, '/home/me/proj', 'a removed workspace falls back to the first')
    assert.equal(api.skResolveWorkspace(undefined, [], 'pending').ready, false, 'waits for the list when nothing is remembered')
    assert.equal(api.skResolveWorkspace('/remembered', [], 'pending').path, '/remembered', 'a remembered path is used while loading')
    assert.equal(api.skResolveWorkspace(undefined, [], 'ready').path, null)
  })

  test('builds location options from the listing roots', () => {
    const personal = api.skLocationOptions(ROOTS, false, zh)
    same(personal.map(o => o.value), ['user-dsh', 'user-agents'])
    assert.equal(personal[0].label, '个人 · DSH 专用')
    assert.equal(personal[0].detail, '~/.dsh/skills')
    assert.equal(personal[1].detail, '~/.agents/skills · Claude Code、Codex 等也会读取')
    const withProject = api.skLocationOptions(ROOTS, true, en)
    same(withProject.map(o => [o.value, o.group]), [
      ['user-dsh', 'Personal'], ['user-agents', 'Personal'], ['project-dsh', 'Project'], ['project-agents', 'Project'],
    ])
    assert.equal(withProject[2].detail, '~/proj/.dsh/skills')
  })

  test('falls back to the personal DSH folder when the chosen one is unavailable', () => {
    assert.equal(api.skEffectiveLocation('project-agents', true), 'project-agents')
    assert.equal(api.skEffectiveLocation('project-agents', false), 'user-dsh')
    assert.equal(api.skEffectiveLocation('bogus', true), 'user-dsh')
  })

  test('abbreviates paths under home', () => {
    const home = api.skHomeFrom(ROOTS)
    assert.equal(home, '/home/me')
    assert.equal(api.skAbbreviate('/home/me/proj', home), '~/proj')
    assert.equal(api.skAbbreviate('/home/meow', home), '/home/meow')
    assert.equal(api.skAbbreviate('/srv/x', null), '/srv/x')
  })
})

describe('cross-root shadowing direction', () => {
  const agentsCopy = skill('lark-doc', { root: 'user-agents' })
  const projectCopy = skill('lark-doc', { root: 'project-dsh' })
  const builtin = skill('pdf', { root: null })

  test('ranks come from the listing roots, with fallbacks', () => {
    assert.equal(api.skRootRank(ROOTS, 'user-dsh'), 400)
    assert.equal(api.skRootRank([{ id: 'user-dsh', rank: 450 }], 'user-dsh'), 450)
    assert.equal(api.skRootRank([], 'project-agents'), 200)
    assert.equal(api.skRootRank(ROOTS, null), 600)
  })

  test('a higher-priority target overrides the existing copy', () => {
    const relation = api.skShadowRelation('lark-doc', [agentsCopy], 'user-dsh', ROOTS)
    assert.equal(relation.direction, 'overrides')
    assert.equal(relation.root, 'user-agents')
    assert.equal(api.skShadowText(relation, zh), '将覆盖「个人 · 通用」中的同名技能')
    assert.equal(api.skShadowText(relation, en), 'Overrides the skill with the same name in “Personal · Shared”')
    assert.equal(api.skShadowTitle(relation, zh), '将覆盖「个人 · 通用」中的同名技能\n~/.agents/skills/lark-doc')
  })

  test('a lower-priority target is overridden and would not take effect', () => {
    const relation = api.skShadowRelation('lark-doc', [projectCopy], 'user-agents', ROOTS)
    assert.equal(relation.direction, 'overridden')
    assert.equal(relation.root, 'project-dsh')
    assert.equal(api.skShadowText(relation, zh), '会被「项目 · DSH 专用」中的同名技能覆盖，不会生效')
  })

  test('being overridden wins over overriding, and the nearest copy is named', () => {
    const relation = api.skShadowRelation('lark-doc', [agentsCopy, projectCopy], 'user-dsh', ROOTS)
    assert.equal(relation.direction, 'overridden')
    assert.equal(relation.root, 'project-dsh')
    const lower = api.skShadowRelation('lark-doc', [agentsCopy, skill('lark-doc', { root: 'project-agents' })], 'project-dsh', ROOTS)
    assert.equal(lower.direction, 'overrides')
    assert.equal(lower.root, 'project-agents', 'the copy that is currently in effect is the one displaced')
  })

  test('built-ins rank last; same-root copies and other names are ignored', () => {
    const relation = api.skShadowRelation('pdf', [builtin], 'user-agents', ROOTS)
    assert.equal(relation.direction, 'overrides')
    assert.equal(relation.root, null)
    assert.equal(api.skShadowText(relation, zh), '将覆盖「内置」中的同名技能')
    assert.equal(api.skShadowTitle(relation, zh), '将覆盖「内置」中的同名技能', 'no folder for built-ins')
    assert.equal(api.skShadowRelation('lark-doc', [skill('lark-doc')], 'user-dsh', ROOTS), null)
    assert.equal(api.skShadowRelation('other', [agentsCopy], 'user-dsh', ROOTS), null)
    assert.equal(api.skShadowRelation('', [agentsCopy], 'user-dsh', ROOTS), null)
  })

  test('batch relations for an install', () => {
    same(api.skInstallRelations(['lark-doc', 'pdf', 'fresh'], [projectCopy, builtin], 'user-dsh', ROOTS), {
      overrides: ['pdf'], overridden: ['lark-doc'],
    })
  })
})

describe('create checks', () => {
  const skills = [skill('notes'), skill('pdf', { root: null })]

  test('same root blocks, other roots warn', () => {
    const here = api.skNameConflicts('notes', skills, 'user-dsh')
    assert.equal(here.here.name, 'notes')
    assert.equal(here.elsewhere, null)
    const other = api.skNameConflicts('notes', skills, 'user-agents')
    assert.equal(other.here, null)
    assert.equal(other.elsewhere.root, 'user-dsh')
    assert.equal(api.skNameConflicts('pdf', skills, 'user-dsh').elsewhere.root, null, 'built-ins count as another root')
  })

  test('problems', () => {
    same(api.skCreateProblems({ name: 'notes', description: ' ' }, skills, 'user-dsh'), { name: 'exists', description: true })
    same(api.skCreateProblems({ name: 'fresh', description: 'x' }, skills, 'user-dsh'), { name: null, description: false })
    same(api.skCreateProblems({ name: '', description: 'x' }, skills, 'user-dsh'), { name: 'required', description: false })
  })

  test('drafts and payloads', () => {
    const draft = api.skDraftFromRead({ item: skill('x', { whenToUse: 'often', modelInvocable: false }), body: 'Body' })
    same(draft, { name: 'x', description: 'x description', whenToUse: 'often', modelInvocable: false, userInvocable: true, body: 'Body' })
    assert.equal(api.skDraftDirty(draft, { ...draft }), false)
    assert.equal(api.skDraftDirty(draft, { ...draft, body: 'Body\n' }), true)
    same(api.skSavePayload({ ...draft, description: '  d  ', whenToUse: ' ' }, 'x'), {
      name: 'x', description: 'd', whenToUse: '', modelInvocable: false, userInvocable: true, body: 'Body',
    })
  })
})

describe('multi-select', () => {
  test('tri-state over a set of ids', () => {
    same(api.skTriState(['a', 'b'], {}), { state: 'none', chosen: 0, total: 2 })
    same(api.skTriState(['a', 'b'], { a: true }), { state: 'some', chosen: 1, total: 2 })
    same(api.skTriState(['a', 'b'], { a: true, b: true, c: true }), { state: 'all', chosen: 2, total: 2 }, 'ids outside the set do not count')
    same(api.skTriState([], { a: true }), { state: 'none', chosen: 0, total: 0 })
    same(api.skTriState(['a'], null), { state: 'none', chosen: 0, total: 1 })
  })

  test('only deletable skills are selectable', () => {
    same(api.skSelectableIds([skill('a'), skill('b', { root: null }), skill('c', { editable: false })]), [skill('a').id])
  })

  test('toggling keeps a clean map', () => {
    same(api.skToggle({ a: true }, ['b', 'c'], true), { a: true, b: true, c: true })
    same(api.skToggle({ a: true, b: true }, ['a'], false), { b: true })
  })

  test('a delete acts on selected, deletable skills visible under the search', () => {
    const listing = { skills: [skill('pdf-tools'), skill('notes'), skill('pdf', { root: null }), skill('pdf-ro', { editable: false })] }
    const selected = Object.fromEntries(listing.skills.map(item => [item.id, true]))
    same(api.skSelectedForDelete(listing, '', selected).map(i => i.name), ['pdf-tools', 'notes'])
    same(api.skSelectedForDelete(listing, 'pdf', selected).map(i => i.name), ['pdf-tools'], 'hidden by the search → kept')
    same(api.skSelectedForDelete(null, '', selected), [])
    same(api.skSelectedForDelete(listing, '', null), [])
  })

  test('confirmation names at most eight, mark duplicates, and count shared folders', () => {
    const few = [skill('glab'), skill('glab', { root: 'user-agents' }), skill('notes', { root: 'user-agents' })]
    same(api.skBatchSummary(few, zh), { names: 'glab（个人 · DSH 专用）、glab（个人 · 通用）、notes', shared: 2, count: 3 })
    const many = Array.from({ length: 12 }, (_, i) => skill(`s${i}`))
    const summary = api.skBatchSummary(many, zh)
    assert.equal(summary.names, 's0、s1、s2、s3、s4、s5、s6、s7 等 12 个')
    assert.equal(api.skBatchSummary(many, en).names, 's0, s1, s2, s3, s4, s5, s6, s7, and 4 more')
    assert.equal(summary.shared, 0)
    assert.equal(api.skCount(en, 'sk_batchTitle', 1), 'Delete 1 skill?')
    assert.equal(api.skCount(zh, 'sk_batchTitle', 12), '删除 12 个技能？')
    assert.equal(api.skCount(en, 'sk_batchShared', 2), '2 of them are in shared folders, so Claude Code, Codex, and other tools will lose them too.')
  })
})

describe('repository rows', () => {
  test('status from local copies', () => {
    assert.equal(api.skRepoRowStatus(repoSkill('a')).kind, 'none')
    assert.equal(api.skRepoRowStatus(repoSkill('a', [copy('user-agents', 'a')])).kind, 'exists')
    assert.equal(api.skRepoRowStatus(repoSkill('a', [copy('user-dsh', 'a', { tracked: true })])).kind, 'installed')
    const update = api.skRepoRowStatus(repoSkill('a', [
      copy('user-dsh', 'a', { tracked: true, updateAvailable: true, modified: true }),
      copy('project-dsh', 'a', { tracked: true }),
      copy('user-agents', 'a'),
    ]))
    assert.equal(update.kind, 'update')
    assert.equal(update.updateModified, true)
    assert.equal(update.modified, true)
    same([update.tracked.length, update.others.length, update.updatable.length], [2, 1, 1])
    const changedButCurrent = api.skRepoRowStatus(repoSkill('a', [copy('user-dsh', 'a', { tracked: true, modified: true })]))
    same([changedButCurrent.kind, changedButCurrent.modified, changedButCurrent.updateModified], ['installed', true, false])
    assert.equal(api.skRepoRowStatus(repoSkill('docx', [copy('user-dsh', 'docx', { tracked: true })], { valid: false, error: 'license' })).kind, 'invalid')
  })

  test('only installable and updatable rows can be checked', () => {
    const kinds = ['none', 'exists', 'update', 'installed', 'invalid']
    same(kinds.map(kind => api.skRepoSelectable({ kind })), [true, true, true, false, false])
  })

  test('install plan: new rows install, same-name rows follow skip / overwrite only in the target location', () => {
    const skills = [
      repoSkill('fresh'),
      repoSkill('taken-here', [copy('user-dsh', 'taken-here')]),
      repoSkill('replace-here', [copy('user-dsh', 'replace-here')]),
      repoSkill('taken-elsewhere', [copy('user-agents', 'taken-elsewhere')]),
      repoSkill('current', [copy('user-dsh', 'current', { tracked: true })]),
      repoSkill('newer', [copy('user-dsh', 'newer', { tracked: true, updateAvailable: true })]),
      repoSkill('unselected'),
      repoSkill('bad', [], { valid: false }),
    ]
    const selected = Object.fromEntries(skills.filter(s => s.name !== 'unselected').map(s => [s.key, true]))
    const plan = api.skRepoInstallPlan(skills, selected, { 'skills/replace-here': true, 'skills/taken-elsewhere': true }, 'user-dsh')
    same(plan.items, [
      { key: 'skills/fresh', overwrite: false },
      { key: 'skills/taken-here', overwrite: false },
      { key: 'skills/replace-here', overwrite: true },
      { key: 'skills/taken-elsewhere', overwrite: false },
    ], 'an overwrite choice only applies when the name is taken in the target location')
    same([plan.install, plan.skip], [3, 1])
    same(plan.names, ['fresh', 'replace-here', 'taken-elsewhere'])
    const elsewhere = api.skRepoInstallPlan(skills, selected, {}, 'user-agents')
    same([elsewhere.install, elsewhere.skip], [3, 1], 'changing the location recomputes conflicts')
    assert.equal(api.skRepoInstallPlan(skills, {}, {}, 'user-dsh').items.length, 0)
  })

  test('update plan covers every updatable copy and handles local changes', () => {
    const skills = [
      repoSkill('pdf', [
        copy('user-dsh', 'pdf', { tracked: true, updateAvailable: true, modified: true }),
        copy('project-dsh', 'pdf', { tracked: true, updateAvailable: true }),
      ]),
      repoSkill('notes', [copy('user-agents', 'notes', { tracked: true, updateAvailable: true, modified: true })]),
      repoSkill('docx', [copy('user-dsh', 'docx', { tracked: true, updateAvailable: true })]),
      repoSkill('current', [copy('user-dsh', 'current', { tracked: true })]),
    ]
    const all = () => true
    const ask = api.skRepoUpdatePlan(skills, all)
    same([ask.rows, ask.modifiedRows], [3, 2])
    same(ask.modifiedNames, ['pdf', 'notes'])
    same(ask.items.map(i => i.force), [false, false, false, false], 'nothing is forced before the user chooses')
    const force = api.skRepoUpdatePlan(skills, all, 'force')
    same(force.items, [
      { path: '/home/me/.dsh/skills/pdf', force: true },
      { path: '/home/me/proj/.dsh/skills/pdf', force: false },
      { path: '/home/me/.agents/skills/notes', force: true },
      { path: '/home/me/.dsh/skills/docx', force: false },
    ])
    const skip = api.skRepoUpdatePlan(skills, all, 'skip')
    same(skip.items.map(i => i.path), ['/home/me/proj/.dsh/skills/pdf', '/home/me/.dsh/skills/docx'], 'modified copies are left out')
    same(skip.names, ['pdf', 'docx'])
    same(skip.skippedNames, ['notes'], 'a row whose only copies are modified is skipped entirely')
    const picked = api.skRepoUpdatePlan(skills, s => s.name === 'docx' || s.name === 'current')
    same([picked.rows, picked.modifiedRows, picked.items.length], [1, 0, 1], 'up-to-date rows add nothing')
  })

  test('places of copies', () => {
    assert.equal(api.skPlaces([copy('user-dsh', 'a'), copy('project-agents', 'a'), copy('user-dsh', 'a')], zh), '个人 · DSH 专用、项目 · 通用')
  })
})

describe('repository suggestions and badge', () => {
  test('recognizes GitHub repositories in every accepted form', () => {
    for (const source of [
      'anthropics/skills', 'Anthropics/Skills.git', 'https://github.com/anthropics/skills', 'github.com/anthropics/skills/tree/main/skills',
      'https://github.com/anthropics/skills.git', 'git@github.com:anthropics/skills.git', 'ssh://git@github.com/anthropics/skills',
      'https://www.github.com/anthropics/skills/', 'https://github.com/anthropics/skills?tab=readme',
    ]) assert.equal(api.skGithubRepo(source), 'anthropics/skills', source)
    for (const source of ['~/skills', '/abs/skills', 'https://gitlab.com/a/b.git', 'a/b/c', '', 'file:///tmp/x']) {
      assert.equal(api.skGithubRepo(source), null, source)
    }
  })

  test('repository keys: owner/repo and subpath; local folders have none', () => {
    assert.equal(api.skRepoKey(REPO), 'anthropics/skills|skills')
    assert.equal(api.skRepoKey({ kind: 'git', source: 'https://github.com/mattpocock/skills', url: 'https://github.com/mattpocock/skills.git' }), 'mattpocock/skills|')
    assert.equal(api.skRepoKey({ kind: 'local', source: '~/x', path: '/home/me/x' }), null)
    assert.equal(api.skRepoKey({ kind: 'git', source: 'https://gitlab.com/a/b.git', url: 'https://gitlab.com/a/b.git' }), null)
  })

  test('hides suggestions that were added, with the same subpath', () => {
    const labels = repos => api.skVisibleSuggestions(api.SK_REPO_SUGGESTIONS, repos).map(s => s.label)
    same(labels([]), ['Anthropic', 'OpenAI', 'Matt Pocock', 'Cursor'])
    same(labels([REPO]), ['OpenAI', 'Matt Pocock', 'Cursor'])
    same(labels([{ ...REPO, subpath: undefined }]), ['Anthropic', 'OpenAI', 'Matt Pocock', 'Cursor'], 'the whole repository is a different source')
    same(labels([
      { kind: 'git', source: 'https://github.com/openai/skills/tree/HEAD/skills/.curated', url: 'https://github.com/OpenAI/skills.git', subpath: '/skills/.curated/' },
      { kind: 'git', source: 'https://github.com/mattpocock/skills', url: 'https://github.com/mattpocock/skills.git' },
    ]), ['Anthropic', 'Cursor'])
  })

  test('update badge sums repositories', () => {
    assert.equal(api.skUpdateCount([{ updateCount: 2 }, { updateCount: 0 }, { updateCount: 3 }]), 5)
    assert.equal(api.skUpdateCount([{}, { updateCount: -1 }, { updateCount: 'x' }, null]), 0)
    assert.equal(api.skUpdateCount(null), 0)
  })

  test('a repository page checks in the background when stale or missing its cache', () => {
    const now = Date.now()
    const detail = repository => ({ repository, skills: [repoSkill('a')] })
    assert.equal(api.skNeedsCheck(detail({ ...REPO, checkedAt: now - 60_000 }), now), false)
    assert.equal(api.skNeedsCheck(detail({ ...REPO, checkedAt: now - 25 * 3600_000 }), now), true)
    assert.equal(api.skNeedsCheck(detail({ ...REPO, checkedAt: undefined }), now), true)
    assert.equal(api.skNeedsCheck({ repository: { ...REPO, checkedAt: now, lastError: 'Not downloaded yet; check for updates' }, skills: [] }, now), true)
    assert.equal(api.skNeedsCheck({ repository: { ...REPO, checkedAt: now, lastError: 'fetch failed' }, skills: [repoSkill('a')] }, now), false)
    assert.equal(api.skNeedsCheck(null, now), false)
  })
})

describe('result lines', () => {
  test('install: relations qualify the installed count; skip reasons are listed', () => {
    const summary = api.skResultSummary({
      kind: 'install', installed: ['a', 'b'], overrides: ['a'], overridden: ['b'],
      skipped: [{ name: 'c', reason: 'exists' }, { name: 'd', reason: 'identical' }], failed: [],
    }, zh)
    assert.equal(summary.text, '已安装 2 个，其中 1 个会覆盖同名技能、1 个被同名技能覆盖而不会生效，跳过 2 个')
    assert.equal(summary.warn, true)
    same(summary.metas, ['被覆盖、不会生效：b', '已存在，未覆盖：c', '内容相同，已记录来源：d'])
  })

  test('update: counts skills, not copies; failures turn the line to warn', () => {
    const summary = api.skResultSummary({
      kind: 'update', updated: ['pdf'], failed: [{ name: 'x', error: 'forbidden' }],
      skipped: [{ name: 'notes', path: '/a', reason: 'current' }, { name: 'notes', path: '/b', reason: 'current' }],
    }, en)
    assert.equal(summary.text, 'Updated 1, skipped 1, 1 failed')
    assert.equal(summary.warn, true)
    same(summary.metas, ['Already up to date: notes'])
    assert.equal(api.skFailureText(summary.failures[0].error, en), 'no record of installing it from this repository, or outside the skill folders')
    assert.equal(api.skFailureText('EACCES: permission denied', en), 'EACCES: permission denied')
  })

  test('delete, check, add, remove, and lines left for the repository list', () => {
    assert.equal(api.skResultSummary({ kind: 'delete', removed: ['a', 'b'], failed: [] }, zh).text, '已删除 2 个')
    const partial = api.skResultSummary({ kind: 'delete', removed: ['a'], failed: [{ name: 'b', error: 'busy' }] }, zh)
    same([partial.text, partial.warn, partial.failures.length], ['已删除 1 个，1 个失败', true, 1])
    assert.equal(api.skResultSummary({ kind: 'check', updates: 3, failed: [] }, zh).text, '检查完毕，3 个技能有更新')
    assert.equal(api.skResultSummary({ kind: 'check', updates: 1, failed: [] }, en).text, 'Check complete: 1 skill update available')
    const failedCheck = api.skResultSummary({ kind: 'check', updates: 0, failed: [{ name: 'r', error: 'x' }] }, zh)
    same([failedCheck.text, failedCheck.warn], ['检查完毕，没有更新，1 个仓库检查失败', true])
    assert.equal(api.skResultSummary({ kind: 'added', label: 'anthropics/skills' }, zh).text, '已添加技能仓库 anthropics/skills')
    assert.equal(api.skResultSummary({ kind: 'removed', label: 'anthropics/skills' }, en).text, 'Removed the skill repository anthropics/skills')
    assert.equal(api.skResultSummary({ kind: 'install', installed: ['a'], skipped: [], failed: [], label: 'anthropics/skills' }, zh).text,
      'anthropics/skills：已安装 1 个')
  })
})

describe('misc helpers', () => {
  test('display dir for delete confirmation', () => {
    assert.equal(api.skDisplayDir(skill('x')), '~/.dsh/skills/x')
    assert.equal(api.skDisplayDir({ layout: 'flat', displayPath: '~/.dsh/skills/x.md' }), '~/.dsh/skills/x.md')
  })

  test('error mapping: context first, then repository-wide, then generic; the Host message stays as detail', () => {
    same(api.skErrorInfo({ code: 'not-found', message: 'No such folder /x' }, zh, 'add'), { title: '找不到这个文件夹、仓库或子目录', detail: 'No such folder /x' })
    assert.equal(api.skErrorInfo({ code: 'git-failed', message: 'exit 128' }, zh, 'add').title, '无法下载仓库')
    assert.equal(api.skErrorInfo({ code: 'git-failed', message: 'exit 128' }, en, 'check').title, 'Could not download the repository')
    assert.equal(api.skErrorInfo({ code: 'invalid', message: 'No SKILL.md found under /x' }, zh, 'add').title, '这里没有找到可安装的技能')
    assert.equal(api.skErrorInfo({ code: 'not-found', message: '' }, zh, 'check').title, '找不到这个技能仓库，可能已被移除')
    assert.equal(api.skErrorInfo({ code: 'not-found', message: 'Not downloaded yet; check for updates' }, zh, 'install').title, '仓库内容还没有下载，请先检查更新')
    assert.equal(api.skErrorInfo({ code: 'not-found', message: '' }, zh, 'read').title, '找不到这个技能')
    assert.equal(api.skErrorInfo({ code: 'weird', message: '' }, en).title, 'Something went wrong')
    assert.equal(api.skErr(new api.CallError('exists', 'taken')).code, 'exists')
    assert.equal(api.skErr(new Error('socket closed')).code, 'transport')
  })

  test('highlight, plurals, local sources', () => {
    const highlight = { names: ['pdf'], root: 'user-dsh' }
    assert.equal(api.skIsHighlighted(skill('pdf'), highlight), true)
    assert.equal(api.skIsHighlighted(skill('pdf', { root: 'user-agents' }), highlight), false)
    assert.equal(api.skCount(en, 'sk_repoSkills', 1), '1 skill')
    assert.equal(api.skCount(en, 'sk_repoSkills', 3), '3 skills')
    assert.equal(api.skCount(zh, 'sk_repoSkills', 1), '1 个技能')
    assert.equal(api.skLooksLocal('~/Downloads/my-skill'), true)
    assert.equal(api.skLooksLocal('/abs/path'), true)
    assert.equal(api.skLooksLocal('file:///tmp/skills'), true)
    assert.equal(api.skLooksLocal('anthropics/skills'), false)
    assert.equal(api.skLooksLocal('https://github.com/anthropics/skills'), false)
  })

  test('every sk_ key exists in both languages', () => {
    const zhKeys = Object.keys(api.DICT.zh).filter(k => k.startsWith('sk_')).sort()
    const enKeys = Object.keys(api.DICT.en).filter(k => k.startsWith('sk_')).sort()
    same(zhKeys, enKeys)
    assert.equal(api.DICT.zh.sk_nav, '技能')
    assert.equal(api.DICT.en.sk_nav, 'Skills')
    assert.equal(api.DICT.zh['sk_err_git-failed'], '无法下载仓库')
  })
})

// ---------------------------------------------------------------------------
// Controller flows. load-part.mjs has no timers or localStorage in its sandbox,
// and the controller needs both, so this loader adds them.
// ---------------------------------------------------------------------------

function loadController() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const body = ['00-core.js', '20-skills.js'].map(name => readFileSync(join(root, 'client', name), 'utf8')).join('\n')
  const source = `(function factory(require) {\n'use strict';\n${body}\nreturn { createSkillsController, DICT };\n})`
  const storage = new Map()
  const window = {
    localStorage: {
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)) },
    },
  }
  const stubReact = {
    createElement: () => null, Fragment: 'Fragment', forwardRef: fn => fn,
    useCallback: fn => fn, useEffect: () => {}, useId: () => 'id', useLayoutEffect: () => {}, useMemo: fn => fn(), useRef: v => ({ current: v }), useState: v => [v, () => {}],
  }
  const factory = vm.runInNewContext(source, { window, CSS: { escape: s => s }, console, URL, JSON, Math, Date, Intl, structuredClone, setTimeout, clearTimeout })
  return { ...factory(id => (id === 'react' ? stubReact : {})), storage }
}

const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve)) }

function fakeHost(handlers) {
  const calls = []
  const ctx = {
    connection: {
      rpc: {
        async call(channel, path, payload) {
          assert.ok(path.startsWith('pcmid/skill-settings/'), `Skills page calls the Skills API: ${path}`)
          const op = path.slice('pcmid/skill-settings/'.length)
          calls.push({ channel, op, payload: plain(payload) })
          const handler = handlers[op]
          if (!handler) return { ok: false, error: { code: 'internal', message: `no handler for ${path}` } }
          try {
            return { ok: true, value: await handler(payload) }
          } catch (error) {
            return { ok: false, error: { code: error.code ?? 'internal', message: error.message } }
          }
        },
      },
    },
  }
  const ops = name => calls.filter(c => c.op === name)
  return { ctx, calls, ops }
}

function hostError(code, message) {
  return Object.assign(new Error(message), { code })
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function setup(handlers) {
  const { createSkillsController, DICT, storage } = loadController()
  const host = fakeHost({
    'list': () => ({ roots: ROOTS, skills: [], complete: true }),
    'repos-list': () => ({ repositories: [] }),
    ...handlers,
  })
  const controller = createSkillsController(host.ctx, key => DICT.en[key] ?? key)
  const face = controller.face
  const snap = () => face.hooks.skills.getSnapshot()
  return { ...host, controller, face, snap, DICT, storage }
}

describe('controller: 已安装', () => {
  test('lists skills and repositories with the workspace cwd, and without cwd when project skills are hidden', async () => {
    const listing = { roots: ROOTS, skills: [skill('alpha')], complete: true }
    const { face, controller, calls, snap, storage } = setup({
      'list': () => listing,
      'repos-list': () => ({ repositories: [REPO, { ...REPO, id: 'r2', updateCount: 2 }] }),
    })

    face.activate()
    assert.equal(calls.length, 0, 'nothing loads before the page resolves its workspace')
    face.setCwd('/home/me/proj')
    await flush()
    same(calls.map(c => [c.channel, c.op, c.payload]), [
      ['/api', 'list', { cwd: '/home/me/proj' }],
      ['/api', 'repos-list', { cwd: '/home/me/proj' }],
    ])
    assert.equal(snap().list.status, 'ready')
    assert.equal(snap().list.value.skills[0].name, 'alpha')
    assert.equal(snap().repos.value.length, 2, 'the tab badge reads repos-list')

    face.setCwd('/home/me/proj')
    assert.equal(calls.length, 2, 'the same cwd does not reload')

    face.pickWorkspace(':none')
    assert.equal(snap().workspacePref, null)
    assert.equal(storage.get('dsh-ms:skillsWorkspace'), 'null')
    face.setCwd(null)
    await flush()
    same(calls.slice(2).map(c => [c.op, c.payload]), [['list', {}], ['repos-list', {}]], 'repository counts follow the workspace too')

    controller.refresh()
    await flush()
    assert.equal(calls.length, 6, 'connection reset reloads both once the page was opened')
    controller.dispose()
  })

  test('a failed listing keeps the error for the retry line', async () => {
    const { face, controller, snap } = setup({ 'list': () => { throw hostError('unavailable', 'no skills service') } })
    face.setCwd(null)
    await flush()
    const list = snap().list
    assert.equal(list.status, 'error')
    same(list.error, { code: 'unavailable', message: 'no skills service' })
    controller.dispose()
  })

  test('edit, discard confirmation, save, and delete', async () => {
    const item = skill('notes', { root: 'user-agents' })
    const listing = { roots: ROOTS, skills: [item], complete: true }
    const { face, controller, ops, snap } = setup({
      'list': () => listing,
      'read': () => ({ item, body: 'Old body', files: ['ref.md'], filesTotal: 1 }),
      'save': payload => ({ item: { ...item, description: payload.description } }),
      'delete': () => ({ removed: [{ id: item.id, name: 'notes', path: item.dir }], failed: [] }),
    })
    face.setCwd('/home/me/proj')
    await flush()

    face.openDetail(item.id)
    same(snap().view, { kind: 'detail', id: item.id })
    await flush()
    assert.equal(snap().detail.status, 'ready')
    assert.equal(snap().detail.draft.body, 'Old body')
    same(snap().detail.files, ['ref.md'])

    face.setDetailField('body', 'New body')
    face.back()
    assert.equal(snap().discard, true, 'leaving a dirty editor asks first')
    face.cancelDiscard()
    assert.equal(snap().discard, false)
    assert.equal(snap().view.kind, 'detail')

    face.setDetailField('description', '')
    await face.saveDetail()
    assert.equal(snap().detail.attempted, 1, 'an empty description blocks the save')
    assert.equal(ops('save').length, 0)

    face.setDetailField('description', 'Better description ')
    await face.saveDetail()
    same(ops('save')[0].payload, {
      cwd: '/home/me/proj', target: { create: false, id: item.id }, name: 'notes', description: 'Better description',
      whenToUse: '', modelInvocable: true, userInvocable: true, body: 'New body',
    })
    assert.ok(snap().detail.savedAt > 0)
    await flush()

    face.back()
    assert.equal(snap().discard, false, 'a saved editor leaves without asking')
    same(snap().view, { kind: 'list' })
    same(snap().focus, { kind: 'row', id: item.id }, 'focus returns to the opening row')
    face.consumeFocus()

    face.openDetail(item.id)
    await flush()
    face.requestDelete()
    assert.equal(snap().detail.confirmDelete, true)
    await face.confirmDelete()
    same(ops('delete')[0].payload, { ids: [item.id], cwd: '/home/me/proj' })
    same(snap().view, { kind: 'list' })
    assert.equal(snap().detail, null)
    controller.dispose()
  })

  test('a single delete that the Host reports as failed stays on the page with the reason', async () => {
    const item = skill('notes')
    const { face, controller, snap } = setup({
      'list': () => ({ roots: ROOTS, skills: [item], complete: true }),
      'read': () => ({ item, body: '', files: [], filesTotal: 0 }),
      'delete': () => ({ removed: [], failed: [{ id: item.id, name: 'notes', error: 'EBUSY' }] }),
    })
    face.setCwd(null)
    await flush()
    face.openDetail(item.id)
    await flush()
    face.requestDelete()
    await face.confirmDelete()
    assert.equal(snap().view.kind, 'detail')
    same(snap().detail.deleteError, { code: 'failed', message: 'EBUSY' })
    assert.equal(snap().detail.deleting, false)
    controller.dispose()
  })

  test('create: validation, exists from the Host, success opens the new skill', async () => {
    const existing = skill('taken')
    const created = skill('fresh', { root: 'user-agents' })
    let firstSave = true
    const { face, controller, ops, snap, storage, DICT } = setup({
      'list': () => ({ roots: ROOTS, skills: [existing], complete: true }),
      'save': (payload) => {
        if (firstSave) { firstSave = false; throw hostError('exists', 'already there') }
        return { item: { ...created, description: payload.description } }
      },
      'read': () => ({ item: created, body: 'Body', files: [], filesTotal: 0 }),
    })
    face.setCwd(null)
    await flush()

    face.openCreate()
    assert.equal(snap().create.draft.body, DICT.en.sk_bodyTemplate, 'new skills start from the template')
    assert.equal(snap().create.location, 'user-dsh')
    face.back()
    assert.equal(snap().view.kind, 'list', 'an untouched draft leaves without asking')
    same(snap().focus, { kind: 'new' })

    face.openCreate()
    await face.submitCreate()
    assert.equal(snap().create.attempted, 1)
    assert.equal(ops('save').length, 0)

    face.setCreateField('name', 'taken')
    face.setCreateField('description', 'Does things')
    await face.submitCreate()
    assert.equal(ops('save').length, 0, 'a same-root duplicate is caught before the Host')

    face.setCreateLocation('user-agents')
    assert.equal(storage.get('dsh-ms:skillsLocation'), '"user-agents"')
    face.setCreateField('name', 'fresh')
    await face.submitCreate()
    assert.equal(snap().create.error.code, 'exists')
    face.back()
    assert.equal(snap().discard, true, 'a dirty create draft asks before leaving')
    face.cancelDiscard()

    await face.submitCreate()
    const save = ops('save')[1]
    same(save.payload.target, { create: true, root: 'user-agents' })
    assert.equal(save.payload.cwd, undefined)
    same(snap().view, { kind: 'detail', id: created.id })
    assert.equal(snap().create, null)
    assert.equal(snap().detail.status, 'ready')
    await flush()
    controller.dispose()
  })

  test('tabs: switching leaves selection mode; the empty state opens the repository tab', async () => {
    const { face, controller, snap } = setup({ 'list': () => ({ roots: ROOTS, skills: [skill('a')], complete: true }) })
    face.setCwd(null)
    await flush()
    assert.equal(snap().tab, 'installed')
    face.startSelect()
    same(snap().select, { ids: {} })
    same(snap().focus, { kind: 'select-all' }, 'focus moves into the replaced toolbar')
    face.setTab('repos')
    assert.equal(snap().tab, 'repos')
    assert.equal(snap().select, null)
    face.startSelect()
    assert.equal(snap().select, null, 'selection belongs to the installed tab')
    face.setTab('bogus')
    assert.equal(snap().tab, 'repos')
    face.setTab('installed')
    face.browseRepos()
    same([snap().tab, snap().focus], ['repos', { kind: 'repo-source' }])
    controller.dispose()
  })

  test('batch delete: selection limits, partial failure, result, and reloads', async () => {
    const skills = [
      skill('pdf-tools'), skill('notes', { root: 'user-agents' }), skill('pdf-extra', { root: 'project-dsh' }),
      skill('pdf', { root: null }), skill('pdf-ro', { editable: false }),
    ]
    const { face, controller, ops, snap } = setup({
      'list': () => ({ roots: ROOTS, skills, complete: true }),
      'delete': ({ ids }) => ({
        removed: [{ id: ids[0], name: 'pdf-tools', path: skills[0].dir }],
        failed: [{ id: ids[1], name: 'pdf-extra', error: 'EACCES: permission denied' }],
      }),
    })
    face.setCwd('/home/me/proj')
    await flush()
    face.startSelect()
    face.toggleSelect(skills[3].id, true)
    face.toggleSelect(skills[4].id, true)
    same(snap().select.ids, {}, 'built-in and read-only skills cannot be selected')
    face.selectIds(skills.map(s => s.id), true)
    same(Object.keys(snap().select.ids), [skills[0].id, skills[1].id, skills[2].id])
    face.setQuery('pdf')
    face.toggleSelect(skills[1].id, false)
    face.toggleSelect(skills[1].id, true)

    face.requestBatchDelete()
    same(snap().batch, { deleting: false, error: null })
    face.cancelBatchDelete()
    assert.equal(snap().batch, null)
    face.requestBatchDelete()
    const listsBefore = ops('list').length
    await face.confirmBatchDelete()
    same(ops('delete')[0].payload, { ids: [skills[0].id, skills[2].id], cwd: '/home/me/proj' }, 'notes is hidden by the search and is kept')
    assert.equal(snap().select, null, 'selection mode ends')
    assert.equal(snap().batch, null)
    same(snap().focus, { kind: 'select' })
    same(plain(snap().result), {
      kind: 'delete', removed: ['pdf-tools'], failed: [{ name: 'pdf-extra', error: 'EACCES: permission denied' }], at: snap().result.at,
    })
    await flush()
    assert.equal(ops('list').length, listsBefore + 1)
    assert.ok(ops('repos-list').length >= 2, 'installed counts are refreshed')

    face.startSelect()
    face.cancelSelect()
    same([snap().select, snap().focus], [null, { kind: 'select' }])
    controller.dispose()
  })

  test('a failed batch delete keeps the dialog open with the error', async () => {
    const { face, controller, snap } = setup({
      'list': () => ({ roots: ROOTS, skills: [skill('a')], complete: true }),
      'delete': () => { throw hostError('internal', 'disk on fire') },
    })
    face.setCwd(null)
    await flush()
    face.startSelect()
    face.selectIds([skill('a').id], true)
    face.requestBatchDelete()
    await face.confirmBatchDelete()
    same(snap().batch, { deleting: false, error: { code: 'internal', message: 'disk on fire' } })
    assert.ok(snap().select, 'still selecting')
    face.activate()
    same([snap().batch, snap().select], [null, null], 'reopening the page closes the dialog and selection')
    controller.dispose()
  })

  test('origin banner: update asks first when modified, then calls repos-update for the skill folder; 查看仓库 opens the repository', async () => {
    let origin = { repoId: 'r1', repoLabel: 'anthropics/skills', key: 'skills/pdf', updateAvailable: true, modified: true, installedAt: 1 }
    const item = () => skill('pdf', { origin })
    const { face, controller, ops, snap } = setup({
      'list': () => ({ roots: ROOTS, skills: [item()], complete: true }),
      'repos-list': () => ({ repositories: [REPO] }),
      'read': () => ({ item: item(), body: 'Body', files: [], filesTotal: 0 }),
      'repos-update': (payload) => {
        origin = { ...origin, updateAvailable: false, modified: false }
        return { updated: [{ name: 'pdf', path: payload.items[0].path }], skipped: [], failed: [] }
      },
      'repos-get': () => ({ repository: REPO, skills: [] }),
    })
    face.setCwd('/home/me/proj')
    await flush()
    face.openDetail(item().id)
    await flush()

    face.setDetailField('body', 'dirty')
    face.requestSkillUpdate()
    assert.equal(snap().detail.confirmUpdate, false, 'a dirty editor cannot update')
    face.revertDetail()

    face.requestSkillUpdate()
    assert.equal(snap().detail.confirmUpdate, true, 'local changes ask first')
    assert.equal(ops('repos-update').length, 0)
    face.cancelSkillUpdate()
    assert.equal(snap().detail.confirmUpdate, false)
    face.requestSkillUpdate()
    face.confirmSkillUpdate()
    await flush()
    same(ops('repos-update')[0].payload, { id: 'r1', cwd: '/home/me/proj', items: [{ path: '/home/me/.dsh/skills/pdf', force: true }] })
    assert.equal(snap().detail.confirmUpdate, false)
    assert.ok(snap().detail.updatedAt > 0)
    assert.equal(snap().detail.item.origin.updateAvailable, false, 'the detail rereads the skill')

    face.setDetailField('body', 'dirty again')
    face.viewRepo()
    same([snap().discard, snap().discardNext], [true, { kind: 'repo', id: 'r1' }], 'a dirty editor asks before leaving for the repository')
    face.confirmDiscard()
    same(snap().view, { kind: 'repo', id: 'r1' })
    assert.equal(snap().tab, 'repos')
    assert.equal(snap().detail, null)
    await flush()
    face.back()
    same([snap().view, snap().tab, snap().focus], [{ kind: 'list' }, 'repos', { kind: 'repo', id: 'r1' }])
    controller.dispose()
  })

  test('origin banner: a forbidden per-item failure becomes a localized error', async () => {
    const origin = { repoId: 'r1', repoLabel: 'anthropics/skills', key: 'skills/pdf', updateAvailable: true, modified: false, installedAt: 1 }
    const item = skill('pdf', { origin })
    const { face, controller, snap } = setup({
      'list': () => ({ roots: ROOTS, skills: [item], complete: true }),
      'read': () => ({ item, body: '', files: [], filesTotal: 0 }),
      'repos-update': () => ({ updated: [], skipped: [], failed: [{ name: 'pdf', path: item.dir, error: 'forbidden' }] }),
    })
    face.setCwd(null)
    await flush()
    face.openDetail(item.id)
    await flush()
    face.requestSkillUpdate()
    await flush()
    same(snap().detail.updateError, { code: 'forbidden', message: '' })
    controller.dispose()
  })
})

describe('controller: 技能仓库', () => {
  test('add → existing repository opens its page and rereads it for this workspace', async () => {
    const { face, controller, ops, snap } = setup({
      'repos-add': () => ({ repository: REPO, skills: [repoSkill('pdf')], existing: true }),
      'repos-get': () => ({ repository: REPO, skills: [repoSkill('pdf', [copy('user-dsh', 'pdf', { tracked: true })])] }),
    })
    face.setCwd('/home/me/proj')
    await flush()
    face.setTab('repos')
    face.setAddSource('  anthropics/skills ')
    face.addRepo()
    assert.equal(snap().add.status, 'adding')
    await flush()
    same(ops('repos-add')[0].payload, { source: 'anthropics/skills', cwd: '/home/me/proj' })
    same(snap().view, { kind: 'repo', id: 'r1' })
    assert.equal(snap().add.source, '', 'the box clears after a typed source')
    same(ops('repos-get')[0].payload, { id: 'r1', cwd: '/home/me/proj' })
    assert.equal(snap().repo.value.skills[0].installs.length, 1, 'the page shows the workspace-specific copies')
    assert.equal(ops('repos-refresh').length, 0, 'a fresh repository is not checked again')
    controller.dispose()
  })

  test('add from a suggestion sends its subpath; a stale page checks in the background', async () => {
    const stale = { ...REPO, id: 'r9', checkedAt: Date.now() - 2 * 86_400_000 }
    const refreshed = deferred()
    const { face, controller, ops, snap } = setup({
      'repos-add': () => ({ repository: stale, skills: [], existing: false }),
      'repos-get': () => ({ repository: stale, skills: [repoSkill('pdf')] }),
      'repos-refresh': () => refreshed.promise,
    })
    face.setCwd(null)
    await flush()
    face.setTab('repos')
    face.addSuggestion({ label: 'Anthropic', source: 'anthropics/skills', subpath: 'skills' })
    await flush()
    same(ops('repos-add')[0].payload, { source: 'anthropics/skills', subpath: 'skills' })
    same(snap().view, { kind: 'repo', id: 'r9' })
    same(ops('repos-refresh').map(c => c.payload), [{ id: 'r9' }], 'checked once, in the background')
    same(snap().checks, { r9: true })
    assert.equal(snap().repo.autoChecked, true)

    face.checkRepo()
    assert.equal(ops('repos-refresh').length, 1, 'a manual check joins the running one')
    face.toggleRepoSkill('skills/pdf', true)
    await face.installSelected()
    assert.equal(ops('repos-install').length, 0, 'nothing installs from a cache that is being rewritten')
    const listsBefore = ops('repos-list').length
    refreshed.resolve({ repository: { ...stale, checkedAt: Date.now(), commit: 'f00' }, skills: [repoSkill('pdf'), repoSkill('docx')] })
    await flush()
    same(snap().checks, {})
    assert.equal(snap().repo.value.skills.length, 2)
    assert.ok(ops('repos-list').length > listsBefore, 'counts reload after a check')
    controller.dispose()
  })

  test('an add that finishes after the user moved on leaves a result line instead of navigating', async () => {
    const pending = deferred()
    const { face, controller, snap } = setup({
      'list': () => ({ roots: ROOTS, skills: [skill('a')], complete: true }),
      'repos-add': () => pending.promise,
    })
    face.setCwd(null)
    await flush()
    face.setTab('repos')
    face.setAddSource('https://github.com/anthropics/skills')
    face.addRepo()
    face.addRepo()
    face.setAddSource('ignored while adding')
    assert.equal(snap().add.source, 'https://github.com/anthropics/skills')
    face.setTab('installed')
    face.openDetail(skill('a').id)
    pending.resolve({ repository: REPO, skills: [], existing: false })
    await flush()
    assert.equal(snap().view.kind, 'detail', 'the user stays where they are')
    same([snap().repoResult.kind, snap().repoResult.id, snap().repoResult.label], ['added', 'r1', 'anthropics/skills'])
    same([snap().add.status, snap().add.source], ['idle', ''])
    assert.equal(snap().repoHighlight.repoId, 'r1')
    assert.equal(snap().repoHighlight.armed, false, 'the new row waits to flash until the list is on screen')
    face.back()
    face.setTab('repos')
    assert.equal(snap().repoHighlight.armed, true)
    controller.dispose()
  })

  test('add failures keep the Host code for the localized line', async () => {
    const { face, controller, snap } = setup({ 'repos-add': () => { throw hostError('git-failed', 'fatal: repository not found') } })
    face.setCwd(null)
    await flush()
    face.setTab('repos')
    face.setAddSource('owner/missing')
    face.addRepo()
    await flush()
    same([snap().add.status, snap().add.error], ['error', { code: 'git-failed', message: 'fatal: repository not found' }])
    assert.equal(snap().view.kind, 'list')
    face.setAddSource('owner/other')
    same([snap().add.status, snap().add.error], ['idle', null], 'typing clears the error')
    controller.dispose()
  })

  test('install: plan, location, result, highlight, cleared selection, and reloads', async () => {
    const listing = { roots: ROOTS, skills: [skill('notes', { root: 'user-agents' }), skill('taken')], complete: true }
    let detail = {
      repository: REPO,
      skills: [repoSkill('notes'), repoSkill('taken', [copy('user-dsh', 'taken')]), repoSkill('fresh'), repoSkill('bad', [], { valid: false })],
    }
    const { face, controller, ops, snap, storage } = setup({
      'list': () => listing,
      'repos-list': () => ({ repositories: [REPO] }),
      'repos-get': () => detail,
      'repos-install': () => {
        detail = { ...detail, skills: detail.skills.map(s => (s.name === 'fresh' || s.name === 'notes' ? { ...s, installs: [copy('user-dsh', s.name, { tracked: true })] } : s)) }
        return { installed: [{ name: 'notes', path: '/home/me/.dsh/skills/notes' }, { name: 'fresh', path: '/home/me/.dsh/skills/fresh' }], skipped: [{ name: 'taken', reason: 'exists' }], failed: [] }
      },
    })
    face.setCwd('/home/me/proj')
    await flush()
    face.setTab('repos')
    face.openRepo('r1')
    await flush()
    assert.equal(snap().repo.status, 'ready')

    face.selectRepoSkills(['skills/notes', 'skills/taken', 'skills/fresh'], true)
    face.toggleRepoSkill('skills/fresh', false)
    face.toggleRepoSkill('skills/fresh', true)
    face.setRepoOverwrite('skills/taken', true)
    face.setRepoOverwrite('skills/taken', false)
    face.setLocation('project-dsh')
    face.setLocation('user-dsh')
    assert.equal(storage.get('dsh-ms:skillsLocation'), '"user-dsh"')

    const listsBefore = ops('list').length
    await face.installSelected()
    same(ops('repos-install')[0].payload, {
      id: 'r1', cwd: '/home/me/proj', root: 'user-dsh',
      items: [{ key: 'skills/notes', overwrite: false }, { key: 'skills/taken', overwrite: false }, { key: 'skills/fresh', overwrite: false }],
    })
    const result = snap().repo.result
    same([result.kind, result.installed, result.overrides, result.overridden], ['install', ['notes', 'fresh'], ['notes'], []], 'the new notes outranks the shared copy')
    same(plain(result.skipped), [{ name: 'taken', reason: 'exists' }])
    same(snap().repo.selected, {})
    same(snap().repo.highlight.keys, ['skills/notes', 'skills/fresh'])
    assert.equal(snap().repo.busy, null)
    await flush()
    assert.equal(snap().repo.highlight.armed, true, 'the highlight starts once the reread arrives')
    assert.equal(snap().repo.value.skills.find(s => s.name === 'fresh').installs.length, 1)
    assert.equal(ops('list').length, listsBefore + 1)
    face.dismissRepoDetailResult()
    assert.equal(snap().repo.result, null)
    controller.dispose()
  })

  test('install without a downloaded cache keeps the not-found error for the 检查更新 offer', async () => {
    const { face, controller, snap } = setup({
      'repos-get': () => ({ repository: REPO, skills: [repoSkill('fresh')] }),
      'repos-install': () => { throw hostError('not-found', 'Not downloaded yet; check for updates') },
    })
    face.setCwd(null)
    await flush()
    face.openRepo('r1')
    await flush()
    face.toggleRepoSkill('skills/fresh', true)
    await face.installSelected()
    same(plain(snap().repo.actionError), { code: 'not-found', message: 'Not downloaded yet; check for updates', action: 'install' })
    same(snap().repo.selected, { 'skills/fresh': true }, 'the selection stays for a retry')
    controller.dispose()
  })

  test('update: locally changed copies ask first; skip leaves them out, update anyway forces them', async () => {
    const skills = [
      repoSkill('pdf', [copy('user-dsh', 'pdf', { tracked: true, updateAvailable: true, modified: true }), copy('project-dsh', 'pdf', { tracked: true, updateAvailable: true })]),
      repoSkill('notes', [copy('user-agents', 'notes', { tracked: true, updateAvailable: true, modified: true })]),
      repoSkill('docx', [copy('user-dsh', 'docx', { tracked: true, updateAvailable: true })]),
    ]
    const { face, controller, ops, snap } = setup({
      'repos-get': () => ({ repository: REPO, skills }),
      'repos-update': ({ items }) => ({
        updated: items.map(item => ({ name: item.path.split('/').pop(), path: item.path })),
        skipped: [], failed: [],
      }),
    })
    face.setCwd('/home/me/proj')
    await flush()
    face.openRepo('r1')
    await flush()

    face.selectRepoSkills(['skills/pdf', 'skills/notes', 'skills/docx'], true)
    face.updateSelected()
    same(plain(snap().repo.modified), { scope: 'selected', names: ['pdf', 'notes'], rows: 3 })
    assert.equal(ops('repos-update').length, 0, 'nothing is sent before the choice')
    face.resolveModified('cancel')
    assert.equal(snap().repo.modified, null)
    same(Object.keys(snap().repo.selected).length, 3, 'cancel keeps the selection')

    face.updateSelected()
    face.resolveModified('skip')
    await flush()
    same(ops('repos-update')[0].payload, {
      id: 'r1', cwd: '/home/me/proj',
      items: [{ path: '/home/me/proj/.dsh/skills/pdf', force: false }, { path: '/home/me/.dsh/skills/docx', force: false }],
    })
    const skipped = snap().repo.result
    same([skipped.kind, skipped.updated], ['update', ['pdf', 'docx']])
    same(plain(skipped.skipped), [{ name: 'notes', reason: 'modified' }], 'rows left out entirely are reported as skipped')
    same(snap().repo.selected, {})

    face.updateAll()
    assert.equal(snap().repo.modified.scope, 'all')
    face.resolveModified('force')
    await flush()
    same(ops('repos-update')[1].payload.items, [
      { path: '/home/me/.dsh/skills/pdf', force: true },
      { path: '/home/me/proj/.dsh/skills/pdf', force: false },
      { path: '/home/me/.agents/skills/notes', force: true },
      { path: '/home/me/.dsh/skills/docx', force: false },
    ])
    controller.dispose()
  })

  test('update without local changes runs at once', async () => {
    const { face, controller, ops, snap } = setup({
      'repos-get': () => ({ repository: REPO, skills: [repoSkill('docx', [copy('user-dsh', 'docx', { tracked: true, updateAvailable: true })])] }),
      'repos-update': () => ({ updated: [], skipped: [{ name: 'docx', path: '/home/me/.dsh/skills/docx', reason: 'current' }], failed: [] }),
    })
    face.setCwd(null)
    await flush()
    face.openRepo('r1')
    await flush()
    face.updateAll()
    await flush()
    assert.equal(snap().repo.modified, null)
    same(ops('repos-update')[0].payload, { id: 'r1', items: [{ path: '/home/me/.dsh/skills/docx', force: false }] })
    same(plain(snap().repo.result.skipped), [{ name: 'docx', path: undefined, reason: 'current' }].map(({ path, ...rest }) => rest))
    controller.dispose()
  })

  test('remove repository: confirm, back to the list, result line', async () => {
    const { face, controller, ops, snap } = setup({
      'repos-list': () => ({ repositories: [REPO] }),
      'repos-get': () => ({ repository: REPO, skills: [] }),
      'repos-refresh': () => ({ repository: REPO, skills: [] }),
      'repos-remove': () => ({ removed: 'r1', forgotten: 2 }),
    })
    face.setCwd(null)
    await flush()
    face.setTab('repos')
    face.openRepo('r1')
    await flush()
    face.requestRemoveRepo()
    assert.equal(snap().repo.confirmRemove, true)
    face.cancelRemoveRepo()
    assert.equal(snap().repo.confirmRemove, false)
    face.requestRemoveRepo()
    await face.confirmRemoveRepo()
    same(ops('repos-remove')[0].payload, { id: 'r1' })
    same([snap().view, snap().tab, snap().repo, snap().focus], [{ kind: 'list' }, 'repos', null, { kind: 'repo-source' }])
    same([snap().repoResult.kind, snap().repoResult.label], ['removed', 'anthropics/skills'])
    controller.dispose()
  })

  test('a failed removal stays in the dialog', async () => {
    const { face, controller, snap } = setup({
      'repos-get': () => ({ repository: REPO, skills: [repoSkill('a')] }),
      'repos-remove': () => { throw hostError('internal', 'state locked') },
    })
    face.setCwd(null)
    await flush()
    face.openRepo('r1')
    await flush()
    face.requestRemoveRepo()
    await face.confirmRemoveRepo()
    same([snap().repo.removing, snap().repo.confirmRemove, snap().repo.removeError], [false, true, { code: 'internal', message: 'state locked' }])
    controller.dispose()
  })

  test('check all: sequential refresh with progress; failures are counted, updates come from the fresh list', async () => {
    const order = []
    const gates = { r1: deferred(), r2: deferred() }
    let updates = 0
    const { face, controller, snap } = setup({
      'repos-list': () => ({ repositories: [{ ...REPO, updateCount: updates }, { ...REPO, id: 'r2', label: 'openai/skills', updateCount: 0 }] }),
      'repos-refresh': ({ id }) => { order.push(id); return gates[id].promise },
    })
    face.setCwd(null)
    await flush()
    face.setTab('repos')
    const run = face.checkAll()
    await flush()
    same(snap().checkAll, { done: 0, total: 2 })
    same(order, ['r1'], 'one at a time')
    same(snap().checks, { r1: true })
    updates = 3
    gates.r1.resolve({ repository: REPO, skills: [] })
    await flush()
    same([snap().checkAll, order], [{ done: 1, total: 2 }, ['r1', 'r2']])
    gates.r2.reject(hostError('git-failed', 'timeout'))
    await run
    assert.equal(snap().checkAll, null)
    same(plain(snap().repoResult), { kind: 'check', updates: 3, failed: [{ name: 'openai/skills', error: 'timeout' }], at: snap().repoResult.at })
    controller.dispose()
  })

  test('a failed check keeps the reason on the page', async () => {
    const { face, controller, snap } = setup({
      'repos-get': () => ({ repository: REPO, skills: [repoSkill('a')] }),
      'repos-refresh': () => { throw hostError('git-failed', 'Could not resolve host') },
    })
    face.setCwd(null)
    await flush()
    face.openRepo('r1')
    await flush()
    face.checkRepo()
    await flush()
    same(snap().repo.checkError, { code: 'git-failed', message: 'Could not resolve host' })
    assert.equal(snap().repo.value.repository.lastError, 'Could not resolve host')
    same(snap().checks, {})
    controller.dispose()
  })

  test('a removed repository shows as not found', async () => {
    const { face, controller, snap } = setup({ 'repos-get': () => { throw hostError('not-found', 'Unknown repository') } })
    face.setCwd(null)
    await flush()
    face.openRepo('gone')
    await flush()
    same([snap().repo.status, snap().repo.error.code], ['error', 'not-found'])
    controller.dispose()
  })

  test('changing the workspace rereads the open repository', async () => {
    const { face, controller, ops } = setup({ 'repos-get': () => ({ repository: REPO, skills: [] }) })
    face.setCwd(null)
    await flush()
    face.openRepo('r1')
    await flush()
    face.setCwd('/home/me/proj')
    await flush()
    same(ops('repos-get').map(c => c.payload), [{ id: 'r1' }, { id: 'r1', cwd: '/home/me/proj' }])
    controller.dispose()
  })
})
