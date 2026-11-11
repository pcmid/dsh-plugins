/**
 * The defaults plugin's one host-plane behavior: a composer switch must not
 * overwrite the conversation default, and unloading must restore Harness.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, keepDefaultFromSessionSwitches, name } from '../index.js'

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

test('the plugin declares no configuration of its own', async () => {
  const module = await import('../index.js')
  assert.equal(name, 'model-defaults')
  assert.equal('Config' in module, false)
  assert.equal(typeof apply, 'function')
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

test('apply installs the override through an optional service injection', () => {
  const defaults = service(SEEDED)
  const effects = []
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ['agentDefaultModel'])
      callback({ agentDefaultModel: defaults, effect: (install) => { effects.push(install()) }, logger: { warn: () => {} } })
    },
  }
  apply(ctx)
  assert.equal(effects.length, 1)
  assert.equal(Object.hasOwn(defaults, 'saveSelection'), true)
  for (const dispose of effects) dispose()
  assert.equal(Object.hasOwn(defaults, 'saveSelection'), false)
})
