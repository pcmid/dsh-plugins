// End-to-end protocol test against a running openchamber-relay.
// Usage: RELAY_URL=ws://127.0.0.1:18788/ws node --test test/protocol.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  RemoteHost, acceptHost, createIdentity, decodePairing, encodePairing, fromBase64Url, hostSocketUrl,
  normalizeRelayUrl, openSocket, pairDevice, randomToken, Mux, TunnelError,
} from '../launcher/tunnel.js'

const relayUrl = normalizeRelayUrl(process.env.RELAY_URL ?? 'ws://127.0.0.1:18788/ws')

/** Minimal host: one control socket, a data socket per client, echo handlers. */
async function startFakeHost() {
  const identity = await createIdentity({ extractable: false })
  const devices = new Map()
  const pairings = new Map()
  const sockets = new Set()
  const control = await openSocket(await hostSocketUrl(relayUrl, identity, 'host-control'))
  sockets.add(control)
  const attach = async (connectionId) => {
    const ws = await openSocket(await hostSocketUrl(relayUrl, identity, 'host-data', connectionId))
    sockets.add(ws)
    try {
      const { channel } = await acceptHost(ws, {
        identity,
        hostName: 'fake-host',
        pairingSecret: (id) => { const p = pairings.get(id); return p ? fromBase64Url(p.secret) : undefined },
        authorize: async ({ mode, pairingId, deviceId, deviceKey, deviceName }) => {
          if (mode === 'pair') {
            pairings.delete(pairingId)
            devices.set(deviceId, { name: deviceName, deviceKey })
            return { ok: true, device: { id: deviceId, name: deviceName } }
          }
          const known = devices.get(deviceId)
          return known ? { ok: true, device: { id: deviceId, name: known.name } } : { ok: false, code: 'unknown-device', reason: 'not paired' }
        },
      })
      new Mux(channel, {
        request: async (exchange) => {
          const chunks = []
          for await (const chunk of exchange.body) chunks.push(...chunk)
          const body = new Uint8Array(chunks)
          if (exchange.path === '/big') {
            exchange.respond(200, 'OK', [['content-type', 'application/octet-stream']])
            const block = new Uint8Array(1024 * 1024).fill(7)
            for (let i = 0; i < 3; i += 1) await exchange.write(block)
            exchange.end()
            return
          }
          exchange.respond(200, 'OK', [['content-type', 'application/json']])
          await exchange.write(new TextEncoder().encode(JSON.stringify({ method: exchange.method, path: exchange.path, size: body.length, headers: exchange.headers })))
          exchange.end()
        },
        websocket: (session) => {
          session.onmessage = (data, isText) => { isText ? session.sendText(`echo:${data}`) : session.sendBinary(data) }
          session.onclose = () => {}
          session.accept(session.protocols[0] ?? '')
        },
      })
    } catch (error) {
      if (!(error instanceof TunnelError)) throw error
    }
  }
  control.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const ids = message.type === 'sync' ? message.connectionIds : message.type === 'connected' ? [message.connectionId] : []
    for (const id of ids) void attach(id)
  })
  return {
    identity,
    offer() {
      const pairingId = randomToken(8)
      const secret = randomToken(16)
      pairings.set(pairingId, { secret })
      return encodePairing({ relayUrl, serverId: identity.id, pairingId, secret, hostName: 'fake-host', expiresAt: Date.now() + 60_000 })
    },
    revokeAll() { devices.clear() },
    close() { for (const ws of sockets) ws.close() },
  }
}

test('pair, request, stream, websocket, revoke', async () => {
  const host = await startFakeHost()
  try {
    const code = host.offer()
    const pairing = decodePairing(`https://launcher.example/#${code}`)
    assert.equal(pairing.serverId, host.identity.id)
    const device = await createIdentity({ extractable: true })
    const paired = await pairDevice({ pairing, device, deviceName: 'test-device' })
    assert.equal(paired.hostName, 'fake-host')
    await assert.rejects(pairDevice({ pairing, device, deviceName: 'again' }), (error) => error.code === 'pairing-invalid')

    const statuses = []
    const remote = new RemoteHost({ relayUrl, serverId: pairing.serverId, device, deviceName: 'test-device', onstatus: (s) => statuses.push(s.state) })
    remote.start()
    const response = await remote.request({ method: 'POST', path: '/echo?x=1', headers: [['content-type', 'text/plain']], body: new Uint8Array(200_000).fill(1) })
    assert.equal(response.status, 200)
    const json = await new Response(response.body).json()
    assert.deepEqual([json.method, json.path, json.size], ['POST', '/echo?x=1', 200_000])

    const big = await remote.request({ method: 'GET', path: '/big' })
    const bytes = new Uint8Array(await new Response(big.body).arrayBuffer())
    assert.equal(bytes.length, 3 * 1024 * 1024)
    assert.ok(bytes.every((b) => b === 7))

    const socket = remote.openWebSocket('ws://x/api/remote.mux', '/api/remote.mux', { protocols: ['p1'] })
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
    assert.equal(socket.protocol, 'p1')
    const long = 'x'.repeat(150_000)
    const replies = []
    socket.onmessage = (event) => { replies.push(event.data) }
    socket.send('hello')
    socket.send(long)
    await new Promise((resolve) => { const t = setInterval(() => { if (replies.length === 2) { clearInterval(t); resolve() } }, 10) })
    assert.deepEqual(replies, ['echo:hello', `echo:${long}`])
    const closed = new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }))
    socket.close(1000, 'bye')
    const closeEvent = await closed
    assert.equal(closeEvent.code, 1000)
    assert.ok(statuses.includes('connected'))
    remote.stop()

    host.revokeAll()
    const rejected = new RemoteHost({ relayUrl, serverId: pairing.serverId, device, deviceName: 'test-device' })
    const outcome = new Promise((resolve) => { rejected.options.onstatus = (s) => { if (s.state === 'rejected') resolve(s) } })
    rejected.start()
    const status = await outcome
    assert.equal(status.code, 'unknown-device')
  } finally {
    host.close()
  }
})

test('client refuses a host whose key does not match the serverId', async () => {
  const host = await startFakeHost()
  const impostor = await createIdentity({ extractable: false })
  try {
    const device = await createIdentity({ extractable: false })
    const remote = new RemoteHost({ relayUrl, serverId: impostor.id, device, deviceName: 'x' })
    // Nobody serves impostor.id, so the client must never reach `host`.
    remote.start()
    setTimeout(() => { remote.stop() }, 1500)
    await assert.rejects(remote.request({ method: 'GET', path: '/' }), (error) => error.code === 'stopped')
  } finally {
    host.close()
  }
})
