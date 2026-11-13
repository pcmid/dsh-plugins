// The teamwork switch of client.js, driven through stand-in browser services:
// visibility, the saved default, and the blank-session sync.
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
    async mutate() { return true },
  }
}

const BLANK = 'blank-1'

/** Apply client.js to stand-in services; returns the section's face and the recorded calls. */
function mount({ teams = true, team = form({ agentTeams: false }), sessions = {}, setResult = { ok: true, value: null } } = {}) {
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
      assert.deepEqual(names, ['remote.agentTeams'])
      if (teams) callback({ remote: { agentTeams }, effect: ctx.effect })
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
