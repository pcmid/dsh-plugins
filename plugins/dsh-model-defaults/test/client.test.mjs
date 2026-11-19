// Browser-facing behavior exercised through the same services as the composer.
import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

let definition

before(async () => {
  globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value } } }
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

/** A settings form stand-in that records `set` calls and answers with `result`. */
function form(value, { writable = true, result = true } = {}) {
  const store = observable({ status: 'ready', writable, value })
  const writes = []
  return {
    writes,
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    async set(field, next) {
      writes.push([field, next])
      if (result) store.set({ ...store.getSnapshot(), value: { ...store.getSnapshot().value, [field]: next } })
      return result
    },
    async mutate(ops) {
      writes.push(ops)
      if (!result) return false
      const value = structuredClone(store.getSnapshot().value)
      for (const { op, path, value: next } of ops) {
        const target = path.slice(0, -1).reduce((obj, key) => obj[key] ??= {}, value)
        if (op === 'set') target[path.at(-1)] = next
        else { assert.equal(op, 'unset'); delete target[path.at(-1)] }
      }
      store.set({ ...store.getSnapshot(), value })
      return true
    },
  }
}

const BLANK = 'blank-1'

/** Apply client.js to stand-in services; returns the section's face and the recorded calls. */
function mount({ teams = true, team = form({ agentTeams: false }), sessions = {}, modelServices, setResult = { ok: true, value: null } } = {}) {
  const switched = []
  const disposers = []
  let registration
  const forms = {
    'agent-default-model': form({}),
    permission: form({}),
    'agent-preset-registry': form({}),
    'model-defaults': team,
  }
  const agentTeams = {
    setEnabled: async (sessionId, enabled) => { switched.push([sessionId, enabled]); return setResult },
  }
  const ctx = {
    locale: { register: () => () => {}, bind: () => key => key },
    effect: (install) => { const dispose = install(); if (typeof dispose === 'function') disposers.push(dispose) },
    on: () => () => {},
    inject: (names, callback) => {
      if (names.includes('remote.agentTeams')) {
        if (teams) callback({ ...ctx, remote: { agentTeams } })
      } else {
        assert.deepEqual(names, ['modelDirectories', 'contextMenus'])
        if (modelServices) callback(ctx)
      }
    },
    configForms: {
      get: ns => forms[ns],
      developerTools: { enabled: observable(false) },
      whileServed: (_names, register) => register(new Set(Object.keys(forms))),
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options) => { registration = options; return () => {} },
    },
    remote: { $on: () => () => {} },
    sessions: { list: observable({ byId: sessions }) },
    ...modelServices,
  }
  const plugin = definition.factory(name => name === 'react' ? { createElement: (...args) => args } : undefined)
  plugin.apply(ctx)
  const face = registration.inject()
  return {
    face,
    state: () => face.hooks.modelDefaults.getSnapshot().team,
    switched,
    dispose: () => { for (const dispose of disposers.reverse()) dispose() },
  }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

function blankSession(enabled) {
  return { [BLANK]: { id: BLANK, blank: true, retainedBy: { mainView: 1 }, projectionValues: { agentTeam: { enabled, tasks: [] } } } }
}

describe('teamwork switch', () => {
  it('shows the saved default while the Host serves agent teamwork', () => {
    const mounted = mount({ team: form({ agentTeams: true }) })
    assert.deepEqual(
      [mounted.state().visible, mounted.state().checked, mounted.state().enabled],
      [true, true, true],
    )
    mounted.dispose()
  })

  it('stays hidden without agent teamwork on the Host', () => {
    const mounted = mount({ teams: false })
    assert.equal(mounted.state().visible, false)
    mounted.dispose()
  })

  it('is disabled while settings are read-only', () => {
    const mounted = mount({ team: form({ agentTeams: false }, { writable: false }) })
    assert.equal(mounted.state().enabled, false)
    mounted.dispose()
  })

  it('saves the default and switches the blank session on screen', async () => {
    const team = form({ agentTeams: false })
    const mounted = mount({ team, sessions: blankSession(false) })
    mounted.face.pickTeam(true)
    await settle()
    assert.deepEqual(team.writes, [['agentTeams', true]])
    assert.deepEqual(mounted.switched, [[BLANK, true]])
    assert.deepEqual([mounted.state().checked, mounted.state().saved], [true, true])
    mounted.dispose()
  })

  it('leaves a blank session that already matches, and works without one', async () => {
    const matching = mount({ sessions: blankSession(true) })
    matching.face.pickTeam(true)
    const none = mount()
    none.face.pickTeam(true)
    await settle()
    assert.deepEqual([matching.switched, none.switched], [[], []])
    assert.deepEqual([matching.state().saved, none.state().saved], [true, true])
    matching.dispose()
    none.dispose()
  })

  it('reports a failed save and leaves the blank session alone', async () => {
    const team = form({ agentTeams: false }, { result: false })
    const mounted = mount({ team, sessions: blankSession(false) })
    mounted.face.pickTeam(true)
    await settle()
    assert.deepEqual(mounted.switched, [])
    assert.deepEqual([mounted.state().failed, mounted.state().checked], [true, false])
    mounted.dispose()
  })

  it('reports why the blank session did not switch', async () => {
    const mounted = mount({ sessions: blankSession(false), setResult: { ok: false, error: { message: 'locked' } } })
    mounted.face.pickTeam(true)
    await settle()
    assert.deepEqual([mounted.state().notice, mounted.state().failed], ['locked', false])
    mounted.dispose()
  })
})

const A = { provider: 'one', model: 'shared' }
const B = { provider: 'two', model: 'shared' }
const KEY_A = JSON.stringify([A.provider, A.model])
const KEY_B = JSON.stringify([B.provider, B.model])
const GROUPS = [A, B].map(({ provider, model }) => ({
  id: provider, models: [{ id: model, reasoning: {
    efforts: ['low', 'high'].map(id => ({ id, name: id })),
    ...(provider === A.provider ? { defaultEffort: 'low' } : {}),
  } }],
}))

class Directory {
  constructor(current) {
    this.store = observable({ status: 'ready', current, groups: GROUPS })
    this.calls = []
    this.result = { ok: true, value: undefined }
  }
  async select(selection) {
    this.calls.push(selection)
    if (this.result.ok) this.store.set({ ...this.store.getSnapshot(), current: selection })
    return this.result
  }
}

/** Start with an already-mounted blank composer; another Session can bind after plugin installation. */
function effortFixture(initial = {}, formOptions) {
  const prefs = form({ agentTeams: false, effortByModel: initial }, formOptions)
  const list = observable({ ids: [], byId: {} })
  const rooms = new Map()
  function bind(id, current, blank) {
    const effects = new Set()
    const ctx = {
      effect(setup) {
        const cleanup = setup()
        const stop = () => { if (effects.delete(stop)) cleanup() }
        effects.add(stop)
        return stop
      },
    }
    const dir = new Directory(current)
    rooms.set(id, { dir, ctx, close: () => { for (const stop of effects) stop() } })
    const row = { id, blank, retainedBy: { mainView: 1 } }
    const { ids, byId } = list.getSnapshot()
    list.set({ ids: [...ids, id], byId: { ...byId, [id]: row } })
    return dir
  }
  const bound = bind('blank', { ...A, reasoningEffort: 'low' }, true)
  const resolver = new class { directoryFor(id) { return rooms.get(id).dir } }()
  const originalResolve = resolver.directoryFor
  const notices = []
  const mounted = mount({
    team: prefs,
    modelServices: {
      modelDirectories: resolver, contextMenus: { notify: message => notices.push(message) },
      sessions: { list, binding: id => rooms.get(id), scope: id => rooms.get(id)?.ctx, subagentAddress: () => undefined },
    },
  })
  return { prefs, bound, bind, resolver, notices, originalResolve, close: id => rooms.get(id).close(), dispose: mounted.dispose }
}

describe('remember composer reasoning effort', () => {
  it('records an explicit change from an already-bound blank session and restores only its exact route elsewhere', async () => {
    const f = effortFixture()
    const high = { ...A, reasoningEffort: 'high' }
    await f.bound.select(high)
    await settle()
    assert.deepEqual(f.prefs.writes, [[{ op: 'set', path: ['effortByModel', KEY_A], value: 'high' }]])
    f.bind('sent', B, false)
    const sent = f.resolver.directoryFor('sent')
    await sent.select({ ...A, reasoningEffort: 'low' })
    await sent.select(B)
    assert.deepEqual(sent.calls, [high, B])
    assert.equal(f.prefs.writes.length, 1, 'route switches do not write preferences')
    f.dispose()
  })

  it('keeps provider defaults when the saved effort is no longer offered, and forgets an explicit reset', async () => {
    const f = effortFixture({ [KEY_A]: 'retired', [KEY_B]: 'high' })
    await f.bound.select(B)
    assert.deepEqual(f.bound.calls.at(-1), { ...B, reasoningEffort: 'high' })
    await f.bound.select(B)
    await settle()
    assert.deepEqual(f.prefs.writes, [[{ op: 'unset', path: ['effortByModel', KEY_B] }]])
    const aDefault = { ...A, reasoningEffort: 'low' }
    await f.bound.select(aDefault)
    await f.bound.select(B)
    assert.deepEqual(f.bound.calls.slice(-2), [aDefault, B])
    f.dispose()
  })

  it('does not save on a rejected model selection or a same-effort /model selection', async () => {
    const f = effortFixture()
    await f.bound.select({ ...A, reasoningEffort: 'low' })
    f.bound.result = { ok: false, error: { code: 'session/writer-held' } }
    assert.equal(await f.bound.select({ ...A, reasoningEffort: 'high' }), f.bound.result)
    await settle()
    assert.deepEqual(f.prefs.writes, [])
    f.dispose()
  })

  it('keeps the accepted selection and reports a failed preference save', async () => {
    const f = effortFixture({}, { result: false })
    const high = { ...A, reasoningEffort: 'high' }
    assert.equal(await f.bound.select(high), f.bound.result)
    await settle()
    assert.deepEqual(f.bound.calls, [high])
    assert.deepEqual(f.prefs.getSnapshot().value.effortByModel, {})
    assert.equal(f.notices.length, 1)
    f.dispose()
  })

  it('restores both choices on a round trip, even when a settings write is still pending', async () => {
    const f = effortFixture()
    const high = { ...A, reasoningEffort: 'high' }
    const low = { ...B, reasoningEffort: 'low' }
    await f.bound.select(high)
    await f.bound.select(B)
    const gate = Promise.withResolvers()
    const mutate = f.prefs.mutate
    f.prefs.mutate = async ops => { await gate.promise; return mutate(ops) }
    const saving = f.bound.select(low)
    await settle()
    const returning = f.bound.select({ ...A, reasoningEffort: 'low' })
    gate.resolve()
    await Promise.all([saving, returning])
    await f.bound.select(B)
    assert.deepEqual(f.bound.calls, [high, B, low, high, low])
    assert.equal(f.prefs.writes.length, 2)
    f.dispose()
  })

  it('does not write or notify for a selection that settles after unload', async () => {
    const f = effortFixture()
    const rpc = Promise.withResolvers()
    f.bound.result = rpc.promise
    const selecting = f.bound.select({ ...A, reasoningEffort: 'high' })
    f.dispose()
    rpc.resolve({ ok: true })
    assert.deepEqual(await selecting, { ok: true })
    assert.deepEqual([f.prefs.writes, f.notices], [[], []])
  })

  it('restores the original methods on session release and plugin unload', () => {
    const f = effortFixture()
    f.bind('sent', B, false)
    const sent = f.resolver.directoryFor('sent')
    f.close('sent')
    assert.equal(sent.select, Directory.prototype.select)
    f.dispose()
    assert.equal(f.bound.select, Directory.prototype.select)
    assert.equal(f.resolver.directoryFor, f.originalResolve)
  })
})
