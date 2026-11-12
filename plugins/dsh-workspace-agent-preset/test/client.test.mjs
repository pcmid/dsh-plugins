// The workspace menu contribution of client.js, driven through stand-in
// browser services: rows, checks, writes, and the blank-session sync.
import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

let definition

before(async () => {
  globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value } } }
  globalThis.document = {
    head: { append() {} },
    createElement: () => ({ dataset: {}, remove() {} }),
  }
  await import('../client.js')
})

function observable(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next) { snapshot = next; for (const listener of listeners) listener() },
  }
}

const ROSTER = [
  { id: 'standard', isDefault: true },
  { id: 'ptc', isDefault: false },
  { id: 'minimal', isDefault: false },
  { id: 'reviewer', name: 'Reviewer', isDefault: false },
  { id: 'broken', name: 'Broken', isDefault: false, broken: 'activation failed' },
]

/** Apply client.js to stand-in services; returns the registered contribution and the recorded effects. */
async function mount({ workspaces = {}, writable = true, tools = false, sessions = {}, selectResult = { ok: true, value: 'x' }, mutateResult = true } = {}) {
  const writes = []
  const selects = []
  const notices = []
  const contributions = []
  const icons = []
  const form = observable({ status: 'ready', writable, value: { workspaces } })
  form.mutate = async (ops) => {
    writes.push(ops)
    return mutateResult
  }
  const dictionaries = {}
  const ctx = {
    locale: {
      register: (ns, dicts) => { dictionaries[ns] = dicts.en; return () => {} },
      bind: ns => key => dictionaries[ns]?.[key] ?? (ns === 'settings.agentPreset' && key === 'presetStandardName' ? 'Standard mode' : key),
    },
    effect: (callback) => { callback() },
    on: () => () => {},
    configForms: {
      get: () => form,
      developerTools: { enabled: observable(tools) },
      whileServed: (_namespaces, register) => register(new Set(['workspace-agent-preset'])),
    },
    contextMenus: {
      register: (contribution) => { contributions.push(contribution); return () => {} },
      notify: (text, success) => { notices.push({ text, success }) },
    },
    slots: {
      inject: (_name, callback) => { for (const registration of callback()) icons.push(registration) },
      register: (options) => options.key,
    },
    remote: {
      $on: () => () => {},
      agentPresets: {
        list: async () => ({ ok: true, value: { presets: ROSTER } }),
        select: async (sessionId, preset) => { selects.push({ sessionId, preset }); return selectResult },
      },
    },
    sessions: { list: observable({ byId: sessions }) },
  }
  const plugin = definition.factory(name => name === 'react' ? { createElement: (...args) => args } : undefined)
  plugin.apply(ctx)
  await new Promise(resolve => setImmediate(resolve))
  return { contribution: contributions[0], icons, writes, selects, notices, form }
}

const TARGET = { workspaceId: 'w1', path: '/projects/alpha', displayTitle: 'alpha' }

async function open(contribution, target = TARGET) {
  const [action] = await contribution.resolve(target, new AbortController().signal)
  return action
}

const checked = rows => rows.filter(row => row.icon?.key === 'workspace-agent-preset.checked').map(row => row.id)

describe('workspace menu', () => {
  it('registers one workspace contribution, between Finder and Delete, with its glyphs', async () => {
    const { contribution, icons } = await mount()
    assert.equal(contribution.target, 'workspace')
    assert.equal(contribution.order, 250)
    assert.deepEqual(icons, ['workspace-agent-preset.agent', 'workspace-agent-preset.checked', 'workspace-agent-preset.unchecked'])
  })

  it('lists usable presets under "Agent preset" and checks the global default when unset', async () => {
    const { contribution } = await mount()
    const action = await open(contribution)
    assert.equal(action.label, 'Agent preset')
    assert.deepEqual(action.children.map(row => [row.id, row.label]), [
      ['default', 'Global default (Standard mode)'],
      ['preset.standard', 'Standard mode'],
      ['preset.reviewer', 'Reviewer'],
    ])
    assert.deepEqual(checked(action.children), ['default'])
    assert.ok(action.children.every(row => row.icon !== undefined))
    assert.equal(action.children[1].separatorBefore, true)
  })

  it('checks the workspace choice, even a coding-tools preset hidden by Developer tools', async () => {
    const { contribution } = await mount({ workspaces: { '/projects/alpha/': 'ptc' } })
    const action = await open(contribution)
    assert.deepEqual(action.children.map(row => row.id), ['default', 'preset.standard', 'preset.ptc', 'preset.reviewer'])
    assert.deepEqual(checked(action.children), ['preset.ptc'])
  })

  it('shows every shipped preset with Developer tools on', async () => {
    const { contribution } = await mount({ tools: true })
    const action = await open(contribution)
    assert.deepEqual(action.children.map(row => row.id), ['default', 'preset.standard', 'preset.ptc', 'preset.minimal', 'preset.reviewer'])
  })

  it('marks a choice that no longer composes as unavailable', async () => {
    const { contribution } = await mount({ workspaces: { '/projects/alpha': 'broken' } })
    const action = await open(contribution)
    const last = action.children.at(-1)
    assert.deepEqual([last.id, last.label, last.disabled], ['unavailable', 'Broken (unavailable)', true])
    assert.deepEqual(checked(action.children), ['unavailable'])
  })

  it('disables the choices when settings are read-only', async () => {
    const { contribution } = await mount({ writable: false })
    const action = await open(contribution)
    assert.ok(action.children.every(row => row.disabled))
  })

  it('stores a choice under the workspace directory and reports it', async () => {
    const { contribution, writes, notices, selects } = await mount()
    const action = await open(contribution)
    await action.children.find(row => row.id === 'preset.reviewer').run()
    assert.deepEqual(writes, [[{ op: 'set', path: ['workspaces', '/projects/alpha'], value: 'reviewer' }]])
    assert.deepEqual(selects, [])
    assert.deepEqual(notices, [{ text: 'New sessions in alpha will use Reviewer', success: true }])
  })

  it('clears a choice, including one stored under another spelling of the directory', async () => {
    const { contribution, writes, notices } = await mount({ workspaces: { '/projects/alpha/': 'ptc' } })
    const action = await open(contribution)
    await action.children.find(row => row.id === 'default').run()
    assert.deepEqual(writes, [[{ op: 'unset', path: ['workspaces', '/projects/alpha/'] }]])
    assert.deepEqual(notices, [{ text: 'New sessions in alpha will use the global default', success: true }])
  })

  it('rejects with the save failure when the Host refuses the write', async () => {
    const { contribution, notices } = await mount({ mutateResult: false })
    const action = await open(contribution)
    await assert.rejects(action.children.find(row => row.id === 'preset.reviewer').run(), /Could not save the workspace agent preset/)
    assert.deepEqual(notices, [])
  })

  it('switches the blank session shown for this workspace', async () => {
    const sessions = {
      blank: { id: 'blank', blank: true, cwd: '/projects/alpha', retainedBy: { mainView: 1 }, projectionValues: { agentPreset: 'standard' } },
      other: { id: 'other', blank: true, cwd: '/projects/beta', retainedBy: { mainView: 1 }, projectionValues: { agentPreset: 'standard' } },
      hidden: { id: 'hidden', blank: true, cwd: '/projects/alpha', retainedBy: {}, projectionValues: { agentPreset: 'standard' } },
    }
    const { contribution, selects, notices } = await mount({ sessions })
    const action = await open(contribution)
    await action.children.find(row => row.id === 'preset.reviewer').run()
    assert.deepEqual(selects, [{ sessionId: 'blank', preset: 'reviewer' }])
    assert.equal(notices[0].success, true)
  })

  it('reports a blank session the Host would not switch', async () => {
    const sessions = { blank: { id: 'blank', blank: true, cwd: '/projects/alpha', retainedBy: { mainView: 1 }, projectionValues: { agentPreset: 'standard' } } }
    const { contribution, notices } = await mount({ sessions, selectResult: { ok: false, error: { message: 'locked', details: { reason: 'This session has already started' } } } })
    const action = await open(contribution)
    await action.children.find(row => row.id === 'preset.reviewer').run()
    assert.deepEqual(notices, [{ text: 'Saved, but the current new session did not switch: This session has already started', success: false }])
  })
})
