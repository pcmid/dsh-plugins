import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createMcpHost, fakeManager } from './mcp-support.mjs'

const NOW = 1_000_000

const connected = () => ({ state: 'connected', toolCount: 2, connectedAt: Date.now() })
const lost = (lastError = 'connection closed') => ({ state: 'failed', reason: 'reconnect-disabled', lastError })

/** A host with a fake manager and mocked `setTimeout`/`Date`. */
function setup(t, { config, names = ['srv'] } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW })
  const manager = fakeManager(names)
  const host = createMcpHost({ services: { mcpManager: manager }, config })
  t.after(() => host.dispose())
  const status = (name, value) => {
    manager.servers.set(name, value)
    host.emit('mcp-manager/status', name, value)
  }
  return { manager, host, status }
}

async function state(host, name = 'srv') {
  return (await host.value('mcp-state', {})).servers[name]
}

/** Let the restart promise chain settle after a timer fired. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('reconnect supervisor', () => {
  it('does not retry a first connection failure', async (t) => {
    const { manager, host, status } = setup(t)
    status('srv', lost('connect ECONNREFUSED'))
    t.mock.timers.tick(60_000)
    await settle()
    assert.deepEqual(manager.restarts, [])
    assert.equal(await state(host), undefined)
  })

  it('reconnects a server that connected before, with 1 s doubling backoff up to 30 s', async (t) => {
    const { manager, host, status } = setup(t, { config: { reconnectMaxAttempts: 8 } })
    status('srv', connected())
    assert.deepEqual(await state(host), { armed: true })
    const delays = [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]
    for (const [index, delay] of delays.entries()) {
      status('srv', lost())
      assert.deepEqual((await state(host)).retry, { attempt: index + 1, max: 8, nextAt: Date.now() + delay, lastError: 'connection closed' })
      t.mock.timers.tick(delay - 1)
      await settle()
      assert.equal(manager.restarts.length, index, `no restart before ${delay} ms`)
      t.mock.timers.tick(1)
      await settle()
      assert.equal(manager.restarts.length, index + 1)
      status('srv', { state: 'connecting', attempt: 0 })
    }
    status('srv', lost('still down'))
    const gaveUp = await state(host)
    assert.deepEqual(gaveUp, { armed: false, gaveUp: { attempts: 8, lastError: 'still down', at: Date.now() } })
    t.mock.timers.tick(120_000)
    await settle()
    assert.equal(manager.restarts.length, 8)
    status('srv', lost())
    assert.equal((await state(host)).retry, undefined, 'a disarmed server is not retried')
  })

  it('re-arms on connected and starts the attempt count over', async (t) => {
    const { manager, host, status } = setup(t)
    status('srv', connected())
    status('srv', lost())
    t.mock.timers.tick(1000)
    await settle()
    status('srv', connected())
    assert.deepEqual(await state(host), { armed: true })
    status('srv', lost())
    assert.equal((await state(host)).retry.attempt, 1)
    assert.equal(manager.restarts.length, 1)
  })

  it('does not retry authorization failures', async (t) => {
    const { manager, host, status } = setup(t)
    status('srv', connected())
    status('srv', lost('Error POSTing to endpoint (HTTP 401): Unauthorized'))
    const value = await state(host)
    assert.equal(value.retry, undefined)
    assert.deepEqual(value.authFailure, { lastError: 'Error POSTing to endpoint (HTTP 401): Unauthorized', at: NOW })
    t.mock.timers.tick(60_000)
    await settle()
    assert.deepEqual(manager.restarts, [])
    status('srv', lost())
    assert.equal((await state(host)).authFailure, undefined, 'a later non-authorization failure replaces it')
  })

  it('leaves automatic reconnects off when reconnectAfterConnected is false', async (t) => {
    const { manager, host, status } = setup(t, { config: { reconnectAfterConnected: false, reconnectMaxAttempts: 10 } })
    status('srv', connected())
    status('srv', lost())
    t.mock.timers.tick(60_000)
    await settle()
    assert.deepEqual(manager.restarts, [])
    assert.deepEqual(await state(host), { armed: true })
  })

  it('ignores failures that DSH retries itself and cancels a pending restart when another one starts', async (t) => {
    const { manager, host, status } = setup(t)
    status('srv', connected())
    status('srv', { state: 'failed', reason: 'gave-up', lastError: 'x' })
    status('srv', { state: 'reconnecting', attempt: 1, maxAttempts: 10, nextRetryAtMs: NOW + 1000, lastError: 'x' })
    assert.deepEqual(await state(host), { armed: true })
    status('srv', lost())
    status('srv', { state: 'connecting', attempt: 0 })
    t.mock.timers.tick(60_000)
    await settle()
    assert.deepEqual(manager.restarts, [])
  })

  it('forgets disabled and removed servers, and arms servers already connected at start', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW })
    const manager = fakeManager(['a', 'b'])
    manager.servers.set('a', connected())
    const host = createMcpHost({ services: { mcpManager: manager } })
    t.after(() => host.dispose())
    assert.deepEqual((await host.value('mcp-state', {})).servers, { a: { armed: true } })
    host.emit('mcp-manager/status', 'b', connected())
    host.emit('mcp-manager/status', 'a', { state: 'disabled' })
    assert.deepEqual((await host.value('mcp-state', {})).servers, { b: { armed: true } })
    host.emit('mcp-manager/status', 'b', lost())
    manager.servers.delete('b')
    assert.deepEqual((await host.value('mcp-state', {})).servers, {})
    t.mock.timers.tick(60_000)
    await settle()
    assert.deepEqual(manager.restarts, [])
  })

  it('counts a failed restart as a failed attempt', async (t) => {
    const { manager, host, status } = setup(t)
    status('srv', connected())
    status('srv', lost())
    manager.failRestart = 'cleanup incomplete'
    t.mock.timers.tick(1000)
    await settle()
    const value = await state(host)
    assert.equal(value.retry.attempt, 2)
    assert.equal(value.retry.lastError, 'Restart failed: cleanup incomplete')
  })
})

describe('mcp-retry', () => {
  it('cancels the pending reconnect, disarms, clears gaveUp, and restarts now', async (t) => {
    const { manager, host, status } = setup(t, { config: { reconnectMaxAttempts: 1 } })
    status('srv', connected())
    status('srv', lost())
    t.mock.timers.tick(1000)
    await settle()
    status('srv', lost())
    assert.ok((await state(host)).gaveUp)
    assert.deepEqual(await host.value('mcp-retry', { server: 'srv' }), { ok: true })
    assert.deepEqual(manager.restarts, ['srv', 'srv'])
    assert.equal(await state(host), undefined)
    status('srv', lost())
    t.mock.timers.tick(60_000)
    await settle()
    assert.equal(manager.restarts.length, 2, 'a failed manual retry is not retried automatically')

    status('srv', connected())
    status('srv', lost())
    assert.equal((await state(host)).retry.attempt, 1)
    await host.value('mcp-retry', { server: 'srv' })
    t.mock.timers.tick(60_000)
    await settle()
    assert.equal(manager.restarts.length, 3, 'the pending automatic restart was cancelled')
  })

  it('validates the server and needs the MCP manager', async (t) => {
    const { host } = setup(t)
    assert.equal((await host.error('mcp-retry', { server: 'missing' })).code, 'not-found')
    assert.equal((await host.error('mcp-retry', { server: 'bad name' })).code, 'bad-request')
    const bare = createMcpHost()
    t.after(() => bare.dispose())
    assert.equal((await bare.error('mcp-retry', { server: 'srv' })).code, 'unavailable')
  })
})

describe('mcp-state', () => {
  it('answers at once without since, and when since is stale', async (t) => {
    const { host } = setup(t)
    const first = await host.value('mcp-state', {})
    assert.deepEqual(first, { version: first.version, servers: {} })
    assert.deepEqual(await host.value('mcp-state', { since: first.version - 1 }), first)
    assert.equal((await host.error('mcp-state', { since: 'x' })).code, 'bad-request')
  })

  it('waits for a change while since is current', async (t) => {
    const { host, status } = setup(t)
    const { version } = await host.value('mcp-state', {})
    let settled = false
    const pending = host.value('mcp-state', { since: version }).then((value) => {
      settled = true
      return value
    })
    await settle()
    assert.equal(settled, false)
    status('srv', connected())
    const value = await pending
    assert.ok(value.version > version)
    assert.deepEqual(value.servers, { srv: { armed: true } })
  })

  it('times out after 20 seconds with the same version, and ends when the request closes', async (t) => {
    const { host } = setup(t)
    const { version } = await host.value('mcp-state', {})
    let settled = false
    const pending = host.value('mcp-state', { since: version }).finally(() => { settled = true })
    await settle()
    t.mock.timers.tick(19_999)
    await settle()
    assert.equal(settled, false)
    t.mock.timers.tick(1)
    assert.deepEqual(await pending, { version, servers: {} })

    const controller = new AbortController()
    const aborted = host.call('mcp-state', { since: version }, { signal: controller.signal })
    await settle()
    controller.abort()
    assert.deepEqual((await aborted).value, { version, servers: {} })
  })

  it('wakes on supervisor changes only when the visible state changed', async (t) => {
    const { host, status } = setup(t)
    status('srv', connected())
    const { version } = await host.value('mcp-state', {})
    status('srv', connected())
    status('srv', { state: 'connecting', attempt: 0 })
    assert.equal((await host.value('mcp-state', {})).version, version)
  })
})
