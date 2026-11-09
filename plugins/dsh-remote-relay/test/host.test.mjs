// Host plugin + computer connector test against a running openchamber-relay and a fake Web GUI.
// Usage: RELAY_URL=ws://127.0.0.1:18788/ws WS_MODULE=/path/to/ws/wrapper.mjs \
//   node --import ./test/hooks.mjs --test test/host.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'
import { COOKIE, fakeContext, startFakeGui, until } from './harness.mjs'

const relayUrl = process.env.RELAY_URL ?? 'ws://127.0.0.1:18788/ws'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
function run(args, env) {
  const child = spawn(process.execPath, [process.env.CONNECTOR ?? path.join(root, 'bin/dsh-remote.mjs'), ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = { text: '' }
  child.stdout.on('data', (chunk) => { output.text += chunk })
  child.stderr.on('data', (chunk) => { output.text += chunk })
  const exited = new Promise((resolve) => { child.on('exit', (code) => { resolve(code) }) })
  return { child, output, exited }
}

test('host plugin pairs the connector and proxies HTTP and WebSocket traffic', async () => {
  const gui = await startFakeGui()
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-remote-test-'))
  const settings = { enabled: false, relayUrl, launcherUrl: 'https://launcher.example/', hostName: 'test-host', pairingMinutes: 5 }
  const host = fakeContext(gui.origin, settings)
  let connector
  try {
    apply(host.ctx, host.config)
    let status = (await host.call('status')).value
    assert.equal(status.control.state, 'disabled')
    assert.match(status.serverId, /^[A-Za-z0-9_-]{43}$/)
    assert.equal((await host.call('pair')).error.code, 'remote-relay/disabled')

    settings.enabled = true
    host.volatileUpdate()
    status = await until(async () => { const s = (await host.call('status')).value; return s.control.state === 'online' && s }, 'relay online')

    const paired = (await host.call('pair')).value.pairing
    assert.ok(paired.link.startsWith('https://launcher.example/#'))
    const pairRun = run(['pair', paired.link, '--name', 'laptop'], { DSH_REMOTE_HOME: home })
    assert.equal(await pairRun.exited, 0, pairRun.output.text)
    status = (await host.call('status')).value
    assert.equal(status.pairing, null)
    assert.deepEqual(status.devices.map((device) => device.name), ['laptop'])
    assert.ok(host.records.has('remote-relay/devices'))

    const port = 20000 + Math.floor(Math.random() * 20000)
    connector = run(['connect', '--port', String(port)], { DSH_REMOTE_HOME: home })
    const url = await until(() => connector.output.text.match(/(http:\/\/127\.0\.0\.1:\d+\/\?dsh-remote-token=\S+)/)?.[1], 'connector url')
    await until(() => connector.output.text.includes('connected to'), 'connector connected')

    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 401)
    const foreignHost = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/', headers: { host: `evil.example:${port}` } }, (res) => { res.resume(); resolve(res.statusCode) }).on('error', reject)
    })
    assert.equal(foreignHost, 403)
    assert.equal((await fetch(`http://127.0.0.1:${port}/`, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
    const login = await fetch(url, { redirect: 'manual' })
    assert.equal(login.status, 303)
    const cookie = login.headers.get('set-cookie').split(';')[0]

    const index = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie } })
    assert.equal(index.status, 200)
    assert.match(await index.text(), /fake dsh/)
    const forwardedIndex = gui.seen.findLast((entry) => entry.path === '/')
    assert.equal(forwardedIndex.cookie, COOKIE)

    const echo = await fetch(`http://127.0.0.1:${port}/api/echo`, { method: 'POST', headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'text/plain' }, body: 'x'.repeat(300_000) })
    assert.equal(echo.headers.get('set-cookie'), null)
    const echoed = await echo.json()
    assert.equal(echoed.body.length, 300_000)
    assert.equal(echoed.method, 'POST')

    const asset = await fetch(`http://127.0.0.1:${port}/asset.js`, { headers: { cookie } })
    assert.match(await asset.text(), /__assetLoaded/)

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/remote.mux`, { headers: { cookie } })
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    const replies = []
    ws.onmessage = (event) => { replies.push(event.data) }
    ws.send('ping')
    ws.send('y'.repeat(200_000))
    await until(() => replies.length === 2, 'websocket echo')
    assert.equal(replies[0], 'mux:ping')
    assert.equal(replies[1].length, 200_004)
    ws.close()

    status = (await host.call('status')).value
    assert.equal(status.devices[0].connections, 1)
    const revoked = await host.call('revoke', { id: status.devices[0].id })
    assert.equal(revoked.value.devices.length, 0)
    assert.equal(await connector.exited, 2, connector.output.text)
    connector = undefined
  } finally {
    connector?.child.kill()
    host.dispose()
    gui.close()
    await rm(home, { recursive: true, force: true })
  }
})
