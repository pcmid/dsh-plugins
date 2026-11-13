/**
 * The defaults plugin's host-plane behaviors: a composer switch must not
 * overwrite the conversation default, unloading must restore Harness, and the
 * volatile teamwork switch turns agent teamwork on for new root sessions.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, Config, keepDefaultFromSessionSwitches, name, startWithTeams } from '../index.js'

/**
 * A stand-in for the `agentDefaultModel` service that records what it saves.
 * Like the real service, `saveSelection` is a prototype method, so the
 * override's `delete` restores it instead of removing the name.
 */
class Service {
  constructor(current) {
    this.current = current
    this.saved = []
  }

  currentSelection() {
    return this.current
  }

  async saveSelection(next) {
    this.saved.push(next)
  }
}

function service(current) {
  return new Service(current)
}

const SEEDED = { provider: 'ccmax', model: 'claude-opus-5-5', reasoningEffort: 'xhigh' }
const PICKED = { provider: 'ccmax', model: 'claude-sonnet-5-5' }

test('the plugin declares one volatile teamwork switch, off by default', () => {
  assert.equal(name, 'model-defaults')
  assert.equal(typeof apply, 'function')
  const resolved = Config({})
  assert.equal(typeof resolved.agentTeams.get, 'function', 'the switch is volatile')
  assert.equal(resolved.agentTeams.get(), false)
  assert.equal(Config({ agentTeams: true }).agentTeams.get(), true)
})

test('a saved default is kept when the composer picks another model', async () => {
  const defaults = service(SEEDED)
  const dispose = keepDefaultFromSessionSwitches(defaults, () => {})
  await defaults.saveSelection(PICKED)
  assert.deepEqual(defaults.saved, [])
  dispose()
})

test('the first selection still saves while no default exists', async () => {
  const defaults = service(undefined)
  const dispose = keepDefaultFromSessionSwitches(defaults, () => {})
  await defaults.saveSelection(SEEDED)
  assert.deepEqual(defaults.saved, [SEEDED])
  dispose()
})

test('unloading restores the Harness method', async () => {
  const defaults = service(SEEDED)
  const original = defaults.saveSelection
  const dispose = keepDefaultFromSessionSwitches(defaults, () => {})
  assert.notEqual(defaults.saveSelection, original)
  dispose()
  assert.equal(defaults.saveSelection, original)
  assert.equal(Object.hasOwn(defaults, 'saveSelection'), false)
})

test('a Harness without the method warns instead of failing', async () => {
  const warnings = []
  const service = { currentSelection: () => SEEDED }
  const dispose = keepDefaultFromSessionSwitches(service, message => { warnings.push(message) })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /saveSelection is missing/)
  dispose()
})

/** A stand-in for the `agentTeams` service that records each selection. */
function teams({ enabled = [], fail } = {}) {
  const on = new Set(enabled)
  const calls = []
  return {
    calls,
    isEnabled: agent => on.has(agent.id),
    async setEnabled(agent, value, signal) {
      calls.push({ id: agent.id, value, signal })
      if (fail !== undefined) throw fail
      if (value) on.add(agent.id)
    },
  }
}

function agent(id, origin) {
  return { id, session: { header: origin === undefined ? { id } : { id, origin } } }
}

test('a new root session starts with teamwork while the switch is on', async () => {
  const service = teams()
  const signal = new AbortController().signal
  await startWithTeams(service, () => true, () => {})({ agent: agent('s1'), source: 'startup', signal })
  assert.deepEqual(service.calls, [{ id: 's1', value: true, signal }])
})

test('the switch is read at every creation', async () => {
  const service = teams()
  let on = false
  const created = startWithTeams(service, () => on, () => {})
  await created({ agent: agent('s1'), source: 'startup' })
  on = true
  await created({ agent: agent('s2'), source: 'startup' })
  assert.deepEqual(service.calls.map(call => call.id), ['s2'])
})

test('resumed sessions, subagents, and sessions already on are left alone', async () => {
  const service = teams({ enabled: ['s3'] })
  const created = startWithTeams(service, () => true, () => {})
  for (const source of ['resume', 'clear', 'compact']) await created({ agent: agent('s1'), source })
  await created({ agent: agent('s2', 'subagent'), source: 'startup' })
  await created({ agent: agent('s3'), source: 'startup' })
  assert.deepEqual(service.calls, [])
})

test('a failed selection is logged and the session still opens', async () => {
  const warnings = []
  const service = teams({ fail: new Error('flush failed') })
  await startWithTeams(service, () => true, message => { warnings.push(message) })({ agent: agent('s1'), source: 'startup' })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /session s1: flush failed/)
})

test('an aborted creation is not reported as a failure', async () => {
  const warnings = []
  const controller = new AbortController()
  controller.abort()
  const service = teams({ fail: new Error('aborted') })
  await startWithTeams(service, () => true, message => { warnings.push(message) })({ agent: agent('s1'), source: 'startup', signal: controller.signal })
  assert.deepEqual(warnings, [])
})

test('apply hangs both behaviors on optional service injections', async () => {
  const defaults = service(SEEDED)
  const service2 = teams()
  const effects = []
  const listeners = []
  const injected = []
  const child = names => ({
    agentDefaultModel: defaults,
    agentTeams: service2,
    effect: (install) => { effects.push(install()) },
    on: (event, listener) => { listeners.push({ names, event, listener }) },
    logger: { warn: () => {} },
  })
  const ctx = {
    inject(names, callback) {
      injected.push(names)
      callback(child(names))
    },
  }
  apply(ctx, Config({ agentTeams: true }))
  assert.deepEqual(injected, [['agentDefaultModel'], ['agentTeams']])
  assert.equal(effects.length, 1)
  assert.equal(Object.hasOwn(defaults, 'saveSelection'), true)
  assert.deepEqual(listeners.map(({ names, event }) => [names, event]), [[['agentTeams'], 'agent/created']])
  await listeners[0].listener({ agent: agent('s1'), source: 'startup' })
  assert.deepEqual(service2.calls.map(call => [call.id, call.value]), [['s1', true]])
  for (const dispose of effects) dispose()
  assert.equal(Object.hasOwn(defaults, 'saveSelection'), false)
})

test('apply leaves new sessions alone while the switch is off', async () => {
  const service2 = teams()
  const listeners = []
  const ctx = {
    inject(names, callback) {
      callback({ agentDefaultModel: service(SEEDED), agentTeams: service2, effect: () => {}, on: (_event, listener) => { listeners.push(listener) }, logger: { warn: () => {} } })
    },
  }
  apply(ctx, Config({}))
  await listeners[0]({ agent: agent('s1'), source: 'startup' })
  assert.deepEqual(service2.calls, [])
})
