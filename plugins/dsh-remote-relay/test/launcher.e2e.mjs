// Browser test of the phone launcher against a running openchamber-relay, the Host plugin, and a fake
// Web GUI: pairs from the QR link, loads the embedded page through the service worker, and checks
// fetch, a gzip asset, and a WebSocket through the injected transport. A second host then checks the
// device menu bridge the DSH page's client plugin uses: the rows it gets, switching, and leaving.
// Usage: RELAY_URL=ws://127.0.0.1:18788/ws PLAYWRIGHT=/path/to/playwright-core/index.mjs \
//   node --import ./test/hooks.mjs test/launcher.e2e.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'
import { fakeContext, startFakeGui, until } from './harness.mjs'

const { chromium } = await import(process.env.PLAYWRIGHT ?? '/tmp/pw/node_modules/playwright-core/index.mjs')
const relayUrl = process.env.RELAY_URL ?? 'ws://127.0.0.1:18788/ws'
const launcherDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'launcher')
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }

function serveLauncher() {
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname
    const file = path.join(launcherDir, pathname === '/' ? 'index.html' : pathname)
    if (!file.startsWith(launcherDir)) { res.writeHead(403).end(); return }
    try {
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  })
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => { resolve(server) }) })
}

const gui = await startFakeGui()
const launcher = await serveLauncher()
const launcherUrl = `http://localhost:${launcher.address().port}/`
const settings = { enabled: true, relayUrl, launcherUrl, hostName: 'e2e-host', pairingMinutes: 5 }
const host = fakeContext(gui.origin, settings)
const second = fakeContext(gui.origin, { ...settings, hostName: 'e2e-second' })
const BRIDGE = { channel: 'dsh-remote-relay', v: 1 }

/** Say hello from the embedded page as the client plugin does, and return the launcher's context. */
function hello(frame) {
  return frame.evaluate((bridge) => new Promise((resolve) => {
    addEventListener('message', (event) => { if (event.data?.channel === bridge.channel && event.data.type === 'context') resolve(event.data) })
    parent.postMessage({ ...bridge, type: 'hello' }, '*')
  }), BRIDGE)
}

async function probedFrame(page, label, except) {
  const frame = await until(() => page.frames().find((candidate) => candidate !== except && candidate.url().includes('/app/')), label)
  await frame.waitForFunction(() => window.__probe !== undefined, null, { timeout: 20_000 })
  return frame
}
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
try {
  apply(host.ctx, host.config)
  apply(second.ctx, second.config)
  await until(async () => (await host.call('status')).value.control.state === 'online', 'relay online')
  await until(async () => (await second.call('status')).value.control.state === 'online', 'second relay online')
  const { link } = (await host.call('pair')).value.pairing
  const page = await browser.newPage()
  page.on('console', (message) => { if (message.type() === 'error') console.log('[page]', message.text()) })
  await page.goto(link)
  await page.waitForSelector('#pair-card:not([hidden])')
  await page.fill('#device-name', 'e2e phone')
  await page.click('#pair-confirm')
  await page.waitForSelector('#session:not([hidden]) iframe')
  const frame = await until(() => page.frames().find((candidate) => candidate.url().includes('/app/')), 'iframe')
  await frame.waitForFunction(() => window.__probe !== undefined, null, { timeout: 20_000 })
  const probe = await frame.evaluate(() => window.__probe)
  assert.deepEqual(probe, { transport: 'object', echo: 'from-frame', asset: true, ws: 'mux:frame', upload: '200:upload-bytes' })
  const status = (await host.call('status')).value
  assert.deepEqual(status.devices.map((device) => [device.name, device.connections]), [['e2e phone', 1]])

  // Reloading the launcher reopens the last host without pairing again.
  await page.goto(launcherUrl)
  const reopened = await until(() => page.frames().find((candidate) => candidate.url().includes('/app/')), 'reopened iframe')
  await reopened.waitForFunction(() => window.__probe !== undefined, null, { timeout: 20_000 })
  assert.equal((await reopened.evaluate(() => window.__probe)).ws, 'mux:frame')

  // The device menu: pair a second host, then switch back from its page.
  await page.goto((await second.call('pair')).value.pairing.link)
  await page.waitForSelector('#pair-card:not([hidden])')
  await page.fill('#device-name', 'e2e phone 2')
  await page.click('#pair-confirm')
  const onSecond = await probedFrame(page, 'second host frame')
  const context = await hello(onSecond)
  const hostId = (await host.call('status')).value.serverId
  const secondId = (await second.call('status')).value.serverId
  assert.equal(context.id, secondId)
  assert.equal(context.state, 'connected')
  assert.equal(context.rows.local, null)
  assert.deepEqual(context.rows.remotes.map((row) => [row.id, row.current, row.action]).sort(), [[hostId, false, 'switch'], [secondId, true, 'switch']].sort())
  assert.equal(context.rows.relays, true)
  // The launcher measures the open DSH's relays for the page's device menu.
  const measured = await onSecond.evaluate(([bridge, id]) => new Promise((resolve) => {
    addEventListener('message', (event) => { if (event.data?.channel === bridge.channel && event.data.type === 'relays-result') resolve(event.data) })
    parent.postMessage({ ...bridge, type: 'relays', id }, '*')
  }), [BRIDGE, secondId])
  assert.equal(measured.id, secondId)
  assert.deepEqual(measured.results.map((result) => [result.host, result.current, typeof result.ms]), [[new URL(relayUrl).host, true, 'number']])
  await page.waitForSelector('#chip', { state: 'hidden' })
  await onSecond.evaluate(([bridge, id]) => { parent.postMessage({ ...bridge, type: 'row', id, action: 'switch' }, '*') }, [BRIDGE, hostId])
  const backOnFirst = await probedFrame(page, 'switched frame', onSecond)
  assert.equal(await page.evaluate(() => localStorage.getItem('dsh-remote:last')), hostId)
  await until(async () => (await host.call('status')).value.devices[0].connections === 1, 'first host connection')
  assert.equal((await hello(backOnFirst)).id, hostId)
  await backOnFirst.evaluate((bridge) => { parent.postMessage({ ...bridge, type: 'local' }, '*') }, BRIDGE)
  await page.waitForSelector('#home:not([hidden])')
  await page.locator('#hosts .row', { hasText: 'e2e-host' }).locator('button.primary').click()
  await probedFrame(page, 'reopened from the list')

  // Removing the device ends access.
  await host.call('revoke', { id: status.devices[0].id })
  await page.waitForSelector('#chip[data-state="rejected"]', { timeout: 20_000 })
  console.log('launcher e2e: ok')
} finally {
  await browser.close()
  host.dispose()
  second.dispose()
  gui.close()
  launcher.close()
}
