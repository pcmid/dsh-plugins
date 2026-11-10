// Device switcher test: one Host plugin pairs as a device of another and serves it on a
// `<label>.localhost` loopback origin, against a running openchamber-relay and a fake Web GUI.
// Usage: RELAY_URL=ws://127.0.0.1:18788/ws WS_MODULE=/path/to/ws/wrapper.mjs \
//   node --import ./test/hooks.mjs --test test/switcher.test.mjs
import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { apply } from '../index.js'
import { COOKIE, fakeContext, startFakeGui, until } from './harness.mjs'

const relayUrl = process.env.RELAY_URL ?? 'ws://127.0.0.1:18788/ws'
const { WebSocket: WsClient } = await import(process.env.WS_MODULE ?? '/tmp/ocrelay/node_modules/ws/wrapper.mjs')

/** HTTP request to the loopback listener with an explicit Host header. */
function request(port, { host, method = 'GET', path = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host, ...headers } }, (res) => {
      const chunks = []
      res.on('data', (chunk) => { chunks.push(chunk) })
      res.on('end', () => { resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }) })
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('a paired DSH is served on its own loopback origin and refused elsewhere', async () => {
  const gui = await startFakeGui()
  const hostSettings = { enabled: true, relayUrl, launcherUrl: '', hostName: 'studio', pairingMinutes: 5 }
  const viewerSettings = { enabled: true, relayUrl, launcherUrl: '', hostName: 'laptop', pairingMinutes: 5 }
  const host = fakeContext(gui.origin, hostSettings)
  const viewer = fakeContext('http://127.0.0.1:1', viewerSettings)
  try {
    apply(host.ctx, host.config)
    apply(viewer.ctx, viewer.config)
    await until(async () => (await host.call('status')).value.control.state === 'online', 'host online')
    await until(async () => (await viewer.call('status')).value.control.state === 'online', 'viewer online')

    const own = (await viewer.call('pair')).value.pairing.code
    assert.equal((await viewer.call('remote-add', { code: own })).error.code, 'remote-relay/self')

    const code = (await host.call('pair')).value.pairing.code
    const added = (await viewer.call('remote-add', { code: `dsh-remote://pair#${code}` })).value
    assert.deepEqual(added.remotes.map((remote) => [remote.name, remote.deviceName]), [['studio', 'laptop']])
    assert.deepEqual((await host.call('status')).value.devices.map((device) => device.name), ['laptop'])
    assert.equal((await viewer.call('remote-add', { code })).error.code, 'remote-relay/pairing-invalid')

    // Adding the same DSH again replaces this DSH's entry over there instead of listing it twice.
    const again = (await host.call('pair')).value.pairing.code
    const readded = (await viewer.call('remote-add', { code: again, name: 'laptop 2' })).value
    assert.equal(readded.added, added.added)
    assert.equal(readded.remotes.length, 1)
    assert.deepEqual((await host.call('status')).value.devices.map((device) => device.name), ['laptop 2'])

    const { origin } = (await viewer.call('remote-open', { id: added.added })).value
    const url = new URL(origin)
    const port = Number(url.port)
    assert.match(url.hostname, /^[a-z2-7]{26}\.localhost$/)
    await until(async () => (await viewer.call('remotes')).value.remotes[0].state === 'connected', 'tunnel connected')

    const index = await request(port, { host: url.host, headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } })
    assert.equal(index.status, 200)
    assert.match(index.text, /fake dsh/)
    assert.equal(index.headers['x-frame-options'], undefined)
    assert.equal(gui.seen.findLast((entry) => entry.path === '/').cookie, COOKIE)

    assert.equal((await request(port, { host: `${'a'.repeat(26)}.localhost:${port}` })).status, 404)
    assert.equal((await request(port, { host: `127.0.0.1:${port}` })).status, 404)
    assert.equal((await request(port, { host: url.host, headers: { origin: 'http://evil.example' } })).status, 403)
    assert.equal((await request(port, { host: url.host, path: '/asset.js', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' } })).status, 403)

    const echo = await request(port, { host: url.host, method: 'POST', path: '/api/echo', headers: { origin, 'content-type': 'text/plain', cookie: 'mine=1' }, body: 'x'.repeat(100_000) })
    assert.equal(echo.status, 200)
    assert.equal(echo.headers['set-cookie'], undefined)
    assert.equal(JSON.parse(echo.text).body.length, 100_000)
    assert.notEqual(gui.seen.findLast((entry) => entry.path === '/api/echo').cookie, 'mine=1')

    const ws = new WsClient(`ws://127.0.0.1:${port}/api/remote.mux`, { headers: { host: url.host, origin } })
    const reply = await new Promise((resolve, reject) => {
      ws.on('open', () => { ws.send('ping') })
      ws.on('message', (data) => { resolve(String(data)) })
      ws.on('error', reject)
    })
    assert.equal(reply, 'mux:ping')
    ws.close()

    const refused = new WsClient(`ws://127.0.0.1:${port}/api/remote.mux`, { headers: { host: url.host, origin: 'http://evil.example' } })
    await new Promise((resolve) => { refused.on('error', resolve); refused.on('unexpected-response', resolve) })

    const device = (await host.call('status')).value.devices[0]
    await host.call('revoke', { id: device.id })
    await until(async () => (await viewer.call('remotes')).value.remotes[0].state === 'rejected', 'viewer rejected')

    // Removing a host that already refused this DSH needs no answer from it.
    const removed = (await viewer.call('remote-remove', { id: added.added })).value
    assert.equal(removed.forgotten, true)
    assert.deepEqual(removed.remotes, [])
    assert.equal((await request(port, { host: url.host })).status, 404)
    assert.ok(viewer.records.has('remote-relay/remotes'))

    // Removing a reachable host also removes this DSH from that host's device list.
    gui.rpc = (endpoint, payload) => host.call(endpoint, payload)
    const third = (await host.call('pair')).value.pairing.code
    const back = (await viewer.call('remote-add', { code: third })).value
    assert.equal((await host.call('status')).value.devices.length, 1)
    assert.equal((await viewer.call('remote-remove', { id: back.added })).value.forgotten, true)
    assert.deepEqual((await host.call('status')).value.devices, [])

    // An unreachable host cannot confirm; the entry is removed here all the same.
    const fourth = (await host.call('pair')).value.pairing.code
    const last = (await viewer.call('remote-add', { code: fourth })).value
    hostSettings.enabled = false
    host.volatileUpdate()
    await until(async () => (await host.call('status')).value.control.state === 'disabled', 'host offline')
    const unconfirmed = (await viewer.call('remote-remove', { id: last.added })).value
    assert.equal(unconfirmed.forgotten, false)
    assert.deepEqual(unconfirmed.remotes, [])
  } finally {
    viewer.dispose()
    host.dispose()
    gui.close()
  }
})
