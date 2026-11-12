// Skills page (client/20-skills.js): pure helpers and controller flows against a fake Host.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { loadPart } from './load-part.mjs'

const HELPERS = [
  'skNormalizeName', 'skValidateName', 'skMatches', 'skGroupSkills', 'skBadges', 'skExistingNames', 'skImportPlan',
  'skResolveWorkspace', 'skWorkspaceItems', 'skLocationOptions', 'skEffectiveLocation', 'skNameConflicts', 'skCreateProblems',
  'skHomeFrom', 'skAbbreviate', 'skDisplayDir', 'skErrorInfo', 'skErr', 'skIsHighlighted', 'skCount', 'skLooksLocal',
  'skDraftDirty', 'skDraftFromRead', 'skSavePayload', 'DICT', 'CallError', 'SK_NO_PROJECT',
  'skRootRank', 'skShadowRelation', 'skInstallRelations', 'skShadowText', 'skShadowTitle',
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
})

describe('import conflicts', () => {
  const skills = [skill('pdf'), skill('docx', { root: 'user-agents' })]
  const candidates = [
    { key: 'skills/pdf', name: 'pdf', description: '', valid: true, fileCount: 2 },
    { key: 'skills/docx', name: 'docx', description: '', valid: true, fileCount: 1 },
    { key: 'skills/xlsx', name: 'xlsx', description: '', valid: true, fileCount: 1 },
    { key: 'skills/broken', name: 'broken', description: '', valid: false, error: 'missing description', fileCount: 1 },
  ]
  const all = { 'skills/pdf': true, 'skills/docx': true, 'skills/xlsx': true, 'skills/broken': true }

  test('existing names depend on the chosen location', () => {
    same([...api.skExistingNames(skills, 'user-dsh')], ['pdf'])
    same([...api.skExistingNames(skills, 'user-agents')], ['docx'])
    same([...api.skExistingNames(skills, 'project-dsh')], [])
  })

  test('conflicts default to skip but are still sent; invalid and unselected rows are left out', () => {
    const plan = api.skImportPlan(candidates, all, {}, api.skExistingNames(skills, 'user-dsh'))
    same(plan, {
      items: [{ key: 'skills/pdf', overwrite: false }, { key: 'skills/docx', overwrite: false }, { key: 'skills/xlsx', overwrite: false }],
      install: 2, skip: 1,
    })
    const replace = api.skImportPlan(candidates, { ...all, 'skills/xlsx': false }, { 'skills/pdf': true }, api.skExistingNames(skills, 'user-dsh'))
    same(replace, { items: [{ key: 'skills/pdf', overwrite: true }, { key: 'skills/docx', overwrite: false }], install: 2, skip: 0 })
  })

  test('changing the location recomputes conflicts', () => {
    const plan = api.skImportPlan(candidates, all, {}, api.skExistingNames(skills, 'user-agents'))
    assert.equal(plan.skip, 1)
    same(plan.items.find(i => i.key === 'skills/pdf'), { key: 'skills/pdf', overwrite: false })
    assert.equal(api.skImportPlan(candidates, {}, {}, new Set()).install, 0)
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

describe('misc helpers', () => {
  test('display dir for delete confirmation', () => {
    assert.equal(api.skDisplayDir(skill('x')), '~/.dsh/skills/x')
    assert.equal(api.skDisplayDir({ layout: 'flat', displayPath: '~/.dsh/skills/x.md' }), '~/.dsh/skills/x.md')
  })

  test('error mapping prefers the context-specific headline and keeps the Host message', () => {
    const scanMissing = api.skErrorInfo({ code: 'not-found', message: 'No such folder /x' }, zh, 'scan')
    same(scanMissing, { title: '找不到这个文件夹或仓库', detail: 'No such folder /x' })
    assert.equal(api.skErrorInfo({ code: 'git-failed', message: 'exit 128' }, en, 'scan').title, 'Could not read the Git repository')
    assert.equal(api.skErrorInfo({ code: 'weird', message: '' }, en).title, 'Something went wrong')
    assert.equal(api.skErr(new api.CallError('exists', 'taken')).code, 'exists')
    assert.equal(api.skErr(new Error('socket closed')).code, 'transport')
  })

  test('highlight, plurals, local sources', () => {
    const highlight = { names: ['pdf'], root: 'user-dsh' }
    assert.equal(api.skIsHighlighted(skill('pdf'), highlight), true)
    assert.equal(api.skIsHighlighted(skill('pdf', { root: 'user-agents' }), highlight), false)
    assert.equal(api.skCount(en, 'sk_install', 1), 'Install 1 skill')
    assert.equal(api.skCount(en, 'sk_install', 3), 'Install 3 skills')
    assert.equal(api.skCount(zh, 'sk_install', 3), '安装 3 个技能')
    assert.equal(api.skLooksLocal('~/Downloads/my-skill'), true)
    assert.equal(api.skLooksLocal('/abs/path'), true)
    assert.equal(api.skLooksLocal('anthropics/skills'), false)
    assert.equal(api.skLooksLocal('https://github.com/anthropics/skills'), false)
  })

  test('every sk_ key exists in both languages', () => {
    const zhKeys = Object.keys(api.DICT.zh).filter(k => k.startsWith('sk_')).sort()
    const enKeys = Object.keys(api.DICT.en).filter(k => k.startsWith('sk_')).sort()
    same(zhKeys, enKeys)
    assert.equal(api.DICT.zh.sk_nav, '技能')
    assert.equal(api.DICT.en.sk_nav, 'Skills')
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

const flush = () => new Promise(resolve => setImmediate(resolve))

function fakeHost(handlers) {
  const calls = []
  const ctx = {
    connection: {
      rpc: {
        async call(channel, path, payload) {
          calls.push({ channel, op: path.replace('mcp-skills/', ''), payload: plain(payload) })
          const handler = handlers[path.replace('mcp-skills/', '')]
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
  return { ctx, calls }
}

function hostError(code, message) {
  return Object.assign(new Error(message), { code })
}

describe('controller', () => {
  test('lists with the workspace cwd, and without cwd when project skills are hidden', async () => {
    const { createSkillsController, DICT, storage } = loadController()
    const t = key => DICT.en[key] ?? key
    const listing = { roots: ROOTS, skills: [skill('alpha')], complete: true }
    const { ctx, calls } = fakeHost({ 'skills-list': () => listing })
    const controller = createSkillsController(ctx, t)
    const store = controller.face.hooks.skills

    controller.face.activate()
    assert.equal(calls.length, 0, 'nothing loads before the page resolves its workspace')
    controller.face.setCwd('/home/me/proj')
    await flush()
    same(calls.map(c => [c.channel, c.op, c.payload]), [['/api', 'skills-list', { cwd: '/home/me/proj' }]])
    assert.equal(store.getSnapshot().list.status, 'ready')
    assert.equal(store.getSnapshot().list.value.skills[0].name, 'alpha')

    controller.face.setCwd('/home/me/proj')
    assert.equal(calls.length, 1, 'the same cwd does not reload')

    controller.face.pickWorkspace(':none')
    assert.equal(store.getSnapshot().workspacePref, null)
    assert.equal(storage.get('dsh-ms:skillsWorkspace'), 'null')
    controller.face.setCwd(null)
    await flush()
    same(calls[1].payload, {})

    controller.refresh()
    await flush()
    assert.equal(calls.length, 3, 'connection reset reloads once the page was opened')
    controller.dispose()
  })

  test('a failed listing keeps the error for the retry line', async () => {
    const { createSkillsController, DICT } = loadController()
    const { ctx } = fakeHost({ 'skills-list': () => { throw hostError('unavailable', 'no skills service') } })
    const controller = createSkillsController(ctx, key => DICT.en[key])
    controller.face.setCwd(null)
    await flush()
    const list = controller.face.hooks.skills.getSnapshot().list
    assert.equal(list.status, 'error')
    same(list.error, { code: 'unavailable', message: 'no skills service' })
    controller.dispose()
  })

  test('edit, discard confirmation, save, and delete', async () => {
    const { createSkillsController, DICT } = loadController()
    const item = skill('notes', { root: 'user-agents' })
    const listing = { roots: ROOTS, skills: [item], complete: true }
    const { ctx, calls } = fakeHost({
      'skills-list': () => listing,
      'skills-read': () => ({ item, body: 'Old body', files: ['ref.md'], filesTotal: 1 }),
      'skills-save': payload => ({ item: { ...item, description: payload.description } }),
      'skills-delete': () => ({ removed: item.dir }),
    })
    const controller = createSkillsController(ctx, key => DICT.en[key])
    const face = controller.face
    const snap = () => face.hooks.skills.getSnapshot()
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
    assert.equal(calls.filter(c => c.op === 'skills-save').length, 0)

    face.setDetailField('description', 'Better description ')
    await face.saveDetail()
    const save = calls.find(c => c.op === 'skills-save')
    same(save.payload, {
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
    same(calls.find(c => c.op === 'skills-delete').payload, { id: item.id, cwd: '/home/me/proj' })
    same(snap().view, { kind: 'list' })
    assert.equal(snap().detail, null)
    controller.dispose()
  })

  test('create: validation, exists from the Host, success opens the new skill', async () => {
    const { createSkillsController, DICT, storage } = loadController()
    const existing = skill('taken')
    const created = skill('fresh', { root: 'user-agents' })
    let firstSave = true
    const { ctx, calls } = fakeHost({
      'skills-list': () => ({ roots: ROOTS, skills: [existing], complete: true }),
      'skills-save': (payload) => {
        if (firstSave) { firstSave = false; throw hostError('exists', 'already there') }
        return { item: { ...created, description: payload.description } }
      },
      'skills-read': () => ({ item: created, body: 'Body', files: [], filesTotal: 0 }),
    })
    const controller = createSkillsController(ctx, key => DICT.en[key])
    const face = controller.face
    const snap = () => face.hooks.skills.getSnapshot()
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
    assert.equal(calls.filter(c => c.op === 'skills-save').length, 0)

    face.setCreateField('name', 'taken')
    face.setCreateField('description', 'Does things')
    await face.submitCreate()
    assert.equal(calls.filter(c => c.op === 'skills-save').length, 0, 'a same-root duplicate is caught before the Host')

    face.setCreateLocation('user-agents')
    assert.equal(storage.get('dsh-ms:skillsLocation'), '"user-agents"')
    face.setCreateField('name', 'fresh')
    await face.submitCreate()
    assert.equal(snap().create.error.code, 'exists')
    face.back()
    assert.equal(snap().discard, true, 'a dirty create draft asks before leaving')
    face.cancelDiscard()

    await face.submitCreate()
    const save = calls.filter(c => c.op === 'skills-save')[1]
    same(save.payload.target, { create: true, root: 'user-agents' })
    assert.equal(save.payload.cwd, undefined)
    same(snap().view, { kind: 'detail', id: created.id })
    assert.equal(snap().create, null)
    assert.equal(snap().detail.status, 'ready')
    await flush()
    controller.dispose()
  })

  test('import: scan, select, conflicts, install, result, and highlight', async () => {
    const { createSkillsController, DICT } = loadController()
    let listing = { roots: ROOTS, skills: [skill('pdf'), skill('docx', { root: 'user-agents' })], complete: true }
    const { ctx, calls } = fakeHost({
      'skills-list': () => listing,
      'skills-scan': () => ({
        scanId: 's1', label: 'anthropics/skills',
        candidates: [
          { key: 'skills/pdf', name: 'pdf', description: 'PDF', valid: true, fileCount: 3 },
          { key: 'skills/docx', name: 'docx', description: 'Word', valid: true, fileCount: 2 },
          { key: 'skills/bad', name: 'bad', description: '', valid: false, error: 'missing description', fileCount: 1 },
        ],
      }),
      'skills-install': () => {
        listing = { ...listing, skills: [...listing.skills, skill('docx')] }
        return { installed: ['docx'], skipped: ['pdf'], failed: [] }
      },
    })
    const controller = createSkillsController(ctx, key => DICT.en[key])
    const face = controller.face
    const snap = () => face.hooks.skills.getSnapshot()
    face.setCwd('/home/me/proj')
    await flush()

    face.openImport()
    face.setImportSource('  https://github.com/anthropics/skills ')
    await face.scan()
    same(calls.find(c => c.op === 'skills-scan').payload, { source: 'https://github.com/anthropics/skills' })
    assert.equal(snap().imp.status, 'ready')
    same(snap().imp.selected, { 'skills/pdf': true, 'skills/docx': true }, 'valid candidates start selected')

    face.toggleAllCandidates(false)
    same(snap().imp.selected, { 'skills/pdf': false, 'skills/docx': false })
    face.toggleAllCandidates(true)
    face.setImportLocation('project-dsh')
    face.setImportLocation('user-dsh')

    await face.install()
    const install = calls.find(c => c.op === 'skills-install')
    same(install.payload, {
      scanId: 's1', root: 'user-dsh', cwd: '/home/me/proj',
      items: [{ key: 'skills/pdf', overwrite: false }, { key: 'skills/docx', overwrite: false }],
    })
    same(snap().view, { kind: 'list' })
    assert.equal(snap().imp, null)
    same(snap().result.installed, ['docx'])
    same(snap().result.skipped, ['pdf'])
    same(snap().result.overrides, ['docx'], 'the installed docx outranks the shared copy')
    same(snap().result.overridden, [])
    same(snap().highlight.names, ['docx'])
    await flush()
    assert.equal(snap().highlight.armed, true, 'the highlight timer starts once the new list arrives')
    assert.ok(snap().list.value.skills.some(s => s.name === 'docx'))

    face.dismissResult()
    assert.equal(snap().result, null)
    controller.dispose()
  })

  test('scan errors keep their code for the localized message', async () => {
    const { createSkillsController, DICT } = loadController()
    const { ctx } = fakeHost({
      'skills-list': () => ({ roots: ROOTS, skills: [], complete: true }),
      'skills-scan': () => { throw hostError('git-failed', 'fatal: repository not found') },
    })
    const controller = createSkillsController(ctx, key => DICT.en[key])
    const face = controller.face
    face.setCwd(null)
    await flush()
    face.openImport()
    face.setImportSource('owner/missing')
    await face.scan()
    const imp = face.hooks.skills.getSnapshot().imp
    assert.equal(imp.status, 'error')
    same(imp.error, { code: 'git-failed', message: 'fatal: repository not found' })
    controller.dispose()
  })
})
