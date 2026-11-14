// Host half test: the browse backend takes `directoryPicker` as soon as it is free, also when the
// system-dialog backend still holds it because DSH disables that row and starts this one at the same
// time (a live install or enable). Uses Cordis and the browse backend from devDependencies (`npm install`).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import BrowseDirectoryPicker from '@deepseek-ai/dsh-host-directory-picker-browse'
import * as plugin from '../index.js'

/** Stand-in for DSH's system-dialog backend. */
class NativePicker extends Service {
  constructor(ctx) {
    super(ctx, 'directoryPicker')
  }

  capability() {
    return { kind: 'native', pick: async () => null }
  }
}

/**
 * Stand-in for DSH's `directoryPicker` Remote controller: needs the service and records the capability
 * of each activation. Its teardown waits for `gate`, which keeps the old provider registered meanwhile.
 */
function consumer(kinds, gate) {
  return {
    name: 'consumer',
    inject: ['directoryPicker'],
    apply(ctx) {
      kinds.push(ctx.directoryPicker.capability().kind)
      ctx.effect(() => () => gate?.promise)
    },
  }
}

/** Kind of the active `directoryPicker`, if any. */
const kindOf = root => root.get('directoryPicker')?.capability().kind

async function until(predicate, what) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`timed out waiting for ${what}`)
}

const temp = mkdtempSync(join(tmpdir(), 'dsh-folder-browser-'))
after(() => rmSync(temp, { recursive: true, force: true }))

describe('host half', () => {
  it('mounts the browse backend with its own config when directoryPicker is free', async () => {
    mkdirSync(join(temp, 'a'))
    mkdirSync(join(temp, 'b'))
    const root = new Context()
    const fiber = root.plugin(plugin, { maxEntries: 1 })
    await fiber
    assert.equal(kindOf(root), 'browse')
    const listing = await root.get('directoryPicker').capability().list(temp)
    assert.deepEqual(listing.entries.map(entry => entry.name), ['a'])
    assert.equal(listing.truncated, true)
    await fiber.dispose()
    assert.equal(root.get('directoryPicker', false), undefined)
  })

  it('waits while another backend holds directoryPicker, then takes over', async () => {
    const root = new Context()
    const kinds = []
    root.plugin(consumer(kinds))
    const native = root.plugin(NativePicker)
    await native
    await until(() => kinds.length === 1, 'the consumer on the native backend')
    const fiber = root.plugin(plugin)
    await fiber
    assert.equal(kindOf(root), 'native')
    await native.dispose()
    await until(() => kindOf(root) === 'browse', 'the browse backend')
    await until(() => kinds.length === 2, 'the consumer on the browse backend')
    assert.deepEqual(kinds, ['native', 'browse'])
    await fiber.dispose()
  })

  it('starts while the old backend is still unloading, as in a live enable', async () => {
    const root = new Context()
    const kinds = []
    const gate = Promise.withResolvers()
    root.plugin(consumer(kinds, gate))
    const native = root.plugin(NativePicker)
    await native
    await until(() => kinds.length === 1, 'the consumer on the native backend')
    // DSH disables the old row and starts the new rows at the same time.
    const unloading = native.dispose()
    assert.equal(root.get('directoryPicker'), undefined)
    assert.notEqual(root.get('directoryPicker', false), undefined)
    // What 0.1.0 did: a backend row of its own fails here and never recovers.
    const direct = root.plugin(BrowseDirectoryPicker)
    await assert.rejects(Promise.resolve(direct), /service "directoryPicker" has been registered/)
    await direct.dispose()
    const fiber = root.plugin(plugin)
    await fiber
    gate.resolve()
    await unloading
    await until(() => kindOf(root) === 'browse', 'the browse backend')
    await until(() => kinds.length === 2, 'the consumer on the browse backend')
    assert.deepEqual(kinds, ['native', 'browse'])
    await fiber.dispose()
    assert.equal(root.get('directoryPicker', false), undefined)
  })

  it('mounts nothing after it unloads while waiting', async () => {
    const root = new Context()
    const native = root.plugin(NativePicker)
    await native
    const fiber = root.plugin(plugin)
    await fiber
    await fiber.dispose()
    await native.dispose()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(root.get('directoryPicker', false), undefined)
  })
})
