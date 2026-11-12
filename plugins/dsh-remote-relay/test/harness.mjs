// Shared fixtures: a fake DSH Web GUI, a fake plugin context, and a polling helper.
import assert from 'node:assert/strict'
import http from 'node:http'
import { gzipSync } from 'node:zlib'

const { WebSocketServer } = await import(process.env.WS_MODULE ?? '/tmp/ocrelay/node_modules/ws/wrapper.mjs')

/** Index page whose script exercises fetch, a gzip asset, and the injected WebSocket transport. */
const FAKE_INDEX = `<!doctype html><html><head><base href="./"><script src="asset.js"></script></head><body>fake dsh<script>
(async () => {
  const results = { transport: typeof window.__DSH_TRANSPORT__ }
  try {
    const echo = await fetch('api/echo', { method: 'POST', body: 'from-frame' })
    results.echo = (await echo.json()).body
    results.asset = window.__assetLoaded === true
    const url = new URL('api/remote.mux', document.baseURI)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = window.__DSH_TRANSPORT__ ? window.__DSH_TRANSPORT__.createWebSocket(url.href) : new WebSocket(url.href)
    results.ws = await new Promise((resolve, reject) => {
      ws.addEventListener('open', () => ws.send('frame'), { once: true })
      ws.addEventListener('message', (event) => resolve(event.data), { once: true })
      ws.addEventListener('error', () => reject(new Error('ws error')), { once: true })
    })
    if (window.__DSH_FILE_UPLOAD__) {
      const upload = await window.__DSH_FILE_UPLOAD__.fetch('api/echo', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Blob(['upload-bytes']) })
      results.upload = upload.status + ':' + (await upload.json()).body
    }
  } catch (error) { results.error = String(error) }
  window.__probe = results
  document.title = 'probe:' + JSON.stringify(results)
})()
</script></body></html>`
export const TOKEN = 'launch-token'
export const COOKIE = 'dsh-auth-test=v1.signed'

/**
 * Fake DSH Web GUI: token exchange, cookie-gated routes, and a cookie-gated echo WebSocket.
 * Assign `rpc` on the result to answer `/api/pcmid/remote-relay/<endpoint>` like the plugin's own routes.
 */
export async function startFakeGui() {
  const seen = []
  const gui = { rpc: undefined }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    seen.push({ method: req.method, path: req.url, host: req.headers.host, cookie: req.headers.cookie, origin: req.headers.origin })
    if (req.headers.host !== `127.0.0.1:${server.address().port}` || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) {
      res.writeHead(403).end('forbidden')
      return
    }
    if (url.pathname === '/' && url.searchParams.get('token') === TOKEN) {
      res.writeHead(303, { location: './', 'set-cookie': `${COOKIE}; Path=/; HttpOnly; SameSite=Strict` }).end()
      return
    }
    if (req.headers.cookie !== COOKIE) {
      res.writeHead(401).end('unauthorized')
      return
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' }).end(FAKE_INDEX)
    } else if (url.pathname === '/api/echo') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'leak=1' }).end(JSON.stringify({ body: Buffer.concat(chunks).toString(), method: req.method }))
    } else if (url.pathname.startsWith('/api/pcmid/remote-relay/') && gui.rpc !== undefined) {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const envelope = JSON.parse(Buffer.concat(chunks).toString())
      const result = await gui.rpc(url.pathname.slice('/api/pcmid/remote-relay/'.length), envelope.payload)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ rpcId: envelope.rpcId, result }))
    } else if (url.pathname === '/asset.js') {
      const body = gzipSync(Buffer.from('window.__assetLoaded = true;' + '/* padding */'.repeat(2000)))
      res.writeHead(200, { 'content-type': 'text/javascript', 'content-encoding': 'gzip', 'content-length': body.length }).end(body)
    } else {
      res.writeHead(404).end('missing')
    }
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.cookie !== COOKIE || req.url !== '/api/remote.mux') {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data, isBinary) => { ws.send(isBinary ? data : `mux:${data}`) })
    })
  })
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return Object.assign(gui, { origin: `http://127.0.0.1:${server.address().port}`, seen, close: () => { wss.close(); server.closeAllConnections(); server.close() } })
}

export function fakeContext(origin, settings) {
  const records = new Map()
  const effects = []
  const listeners = new Map()
  const routes = new Map()
  const ctx = {
    connection: {
      authenticatedUrl: (base) => `${base}?token=${TOKEN}`,
      fetch: {
        register: (route) => {
          assert.ok(route.path.startsWith('/api/pcmid/remote-relay/'))
          routes.set(route.path.slice('/api/pcmid/remote-relay/'.length), route)
          return async () => {}
        },
      },
    },
    webServer: { getOrigin: () => origin },
    credentials: {
      readRecord: async (key) => records.get(key),
      modifyRecord: async (key, mutate) => {
        const next = await mutate(records.get(key))
        if (next !== undefined) records.set(key, structuredClone(next))
        return records.get(key)
      },
    },
    effect: (fn) => { const dispose = fn(); effects.push(dispose); return () => dispose?.() },
    on: (name, fn) => { listeners.set(name, fn) },
    inject: () => {},
    logger: { info() {}, debug() {}, warn: (line) => { console.warn(line) } },
    fiber: {},
  }
  const config = Object.fromEntries(Object.keys(settings).map((key) => [key, { get: () => settings[key] }]))
  return {
    ctx,
    config,
    records,
    call: async (endpoint, payload = {}) => {
      const request = new Request('http://dsh.invalid/api/pcmid/remote-relay/' + endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: endpoint, payload }),
      })
      const response = await routes.get(endpoint).fetch(request)
      const envelope = await response.json()
      assert.equal(envelope.rpcId, 'rpc-1')
      return envelope.result
    },
    volatileUpdate: () => listeners.get('loader/volatile-update')?.(),
    dispose: () => { for (const dispose of effects) dispose?.() },
  }
}

export async function until(fn, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => { setTimeout(resolve, 100) })
  }
}

