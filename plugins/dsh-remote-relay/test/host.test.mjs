// Host plugin test: enabling remote access, pairing another DSH as a device, and forwarding its HTTP
// and WebSocket traffic to the Web GUI, against a running openchamber-relay and a fake Web GUI.
// Usage: RELAY_URL=ws://127.0.0.1:18788/ws WS_MODULE=/path/to/ws/wrapper.mjs \
//   node --import ./test/hooks.mjs --test test/host.test.mjs
import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { apply } from '../index.js'
import { COOKIE, fakeContext, startFakeGui, until } from './harness.mjs'

const relayUrl = process.env.RELAY_URL ?? 'ws://127.0.0.1:18788/ws'
const { WebSocket: WsClient } = await import(process.env.WS_MODULE ?? '/tmp/ocrelay/node_modules/ws/wrapper.mjs')

/** Request a device view on the viewer's loopback listener, as a page of that view would. */
function viewRequest(origin, { method = 'GET', path = '/', body, headers = {} } = {}) {
  const url = new URL(origin)
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: Number(url.port), method, path, headers: { host: url.host, ...headers } }, (res) => {
      const chunks = []
      res.on('data', (chunk) => { chunks.push(chunk) })
      res.on('end', () => { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }) })
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('host plugin pairs another DSH and proxies its HTTP and WebSocket traffic', async () => {
  const gui = await startFakeGui()
  const settings = { enabled: false, relayUrl, launcherUrl: 'https://launcher.example/', hostName: 'test-host', pairingMinutes: 5 }
  const host = fakeContext(gui.origin, settings)
  const viewer = fakeContext('http://127.0.0.1:1', { enabled: false, relayUrl: '', launcherUrl: '', hostName: 'viewer', pairingMinutes: 5 })
  try {
    apply(host.ctx, host.config)
    apply(viewer.ctx, viewer.config)
    let status = (await host.call('status')).value
    assert.equal(status.control.state, 'disabled')
    assert.match(status.serverId, /^[A-Za-z0-9_-]{43}$/)
    assert.equal((await host.call('pair')).error.code, 'remote-relay/disabled')

    settings.enabled = true
    host.volatileUpdate()
    status = await until(async () => { const s = (await host.call('status')).value; return s.control.state === 'online' && s }, 'relay online')

    const paired = (await host.call('pair')).value.pairing
    assert.ok(paired.link.startsWith('https://launcher.example/#'))
    // The viewer never enabled its own remote access: switching to other devices does not need it.
    const added = (await viewer.call('remote-add', { code: paired.link, name: 'laptop' })).value
    status = (await host.call('status')).value
    assert.equal(status.pairing, null)
    assert.deepEqual(status.devices.map((device) => device.name), ['laptop'])
    assert.ok(host.records.has('remote-relay/devices'))

    const { origin } = (await viewer.call('remote-open', { id: added.added })).value
    await until(async () => (await viewer.call('remotes')).value.remotes[0].state === 'connected', 'tunnel connected')

    const index = await viewRequest(origin, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } })
    assert.equal(index.status, 200)
    assert.match(index.body.toString(), /fake dsh/)
    assert.equal(gui.seen.findLast((entry) => entry.path === '/').cookie, COOKIE)

    const echo = await viewRequest(origin, { method: 'POST', path: '/api/echo', body: 'x'.repeat(300_000), headers: { origin, 'content-type': 'text/plain' } })
    assert.equal(echo.headers['set-cookie'], undefined)
    const echoed = JSON.parse(echo.body.toString())
    assert.equal(echoed.body.length, 300_000)
    assert.equal(echoed.method, 'POST')

    const asset = await viewRequest(origin, { path: '/asset.js', headers: { 'sec-fetch-site': 'same-origin' } })
    assert.equal(asset.headers['content-encoding'], 'gzip')
    assert.ok(asset.body.length > 0)

    const ws = new WsClient(`ws://127.0.0.1:${new URL(origin).port}/api/remote.mux`, { headers: { host: new URL(origin).host, origin } })
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
    const replies = []
    ws.on('message', (data) => { replies.push(String(data)) })
    ws.send('ping')
    ws.send('y'.repeat(200_000))
    await until(() => replies.length === 2, 'websocket echo')
    assert.equal(replies[0], 'mux:ping')
    assert.equal(replies[1].length, 200_004)

    status = (await host.call('status')).value
    assert.equal(status.devices[0].connections, 1)
    const revoked = await host.call('revoke', { id: status.devices[0].id })
    assert.equal(revoked.value.devices.length, 0)
    await new Promise((resolve) => { if (ws.readyState === ws.CLOSED) resolve(); else ws.on('close', resolve) })
    await until(async () => (await viewer.call('remotes')).value.remotes[0].state === 'rejected', 'viewer refused')
  } finally {
    viewer.dispose()
    host.dispose()
    gui.close()
  }
})

test('the Host keeps the session last opened in any window', async () => {
  const gui = await startFakeGui()
  const host = fakeContext(gui.origin, { enabled: false, relayUrl: '', launcherUrl: '', hostName: 'memo', pairingMinutes: 5 })
  try {
    apply(host.ctx, host.config)
    assert.deepEqual((await host.call('last-session')).value, { id: null })
    assert.equal((await host.call('session-opened', { id: 'session-a' })).value.id, 'session-a')
    assert.equal((await host.call('session-opened', { id: 'session-b' })).value.id, 'session-b')
    assert.deepEqual((await host.call('last-session')).value, { id: 'session-b' })
    assert.equal((await host.call('session-opened', { id: '../x' })).error.code, 'remote-relay/invalid')
    // Writes are coalesced, and a disposed plugin flushes the pending one.
    host.dispose()
    await until(() => host.records.get('remote-relay/last-session')?.payload?.id === 'session-b', 'saved record')
    const reloaded = fakeContext(gui.origin, { enabled: false, relayUrl: '', launcherUrl: '', hostName: 'memo', pairingMinutes: 5 })
    for (const [key, value] of host.records) reloaded.records.set(key, value)
    apply(reloaded.ctx, reloaded.config)
    assert.deepEqual((await reloaded.call('last-session')).value, { id: 'session-b' })
    reloaded.dispose()
  } finally {
    gui.close()
  }
})
