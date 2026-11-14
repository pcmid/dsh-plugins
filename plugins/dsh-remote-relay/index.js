/**
 * Host half of the DSH remote relay bundle.
 *
 * While enabled, the plugin keeps one signed `host-control` socket on each configured self-hosted
 * openchamber-relay; the relay list is ordered by priority, and pairing codes and handshakes hand
 * that order to devices, which try the relays in turn. For each device that dials the relay it opens a `host-data` socket, completes
 * the end-to-end encrypted handshake from `launcher/tunnel.js`, admits only paired devices, and
 * then forwards the device's HTTP requests and WebSockets to this process's own Web GUI on
 * loopback. The plugin signs in to the Web GUI with its own browser cookie, so the device never
 * receives a DSH credential and the Web GUI keeps listening on loopback only. A paired device
 * therefore acts with the owner's full authority.
 *
 * The identity key and the paired-device list live in `ctx.credentials` records. Pairing offers
 * are one-time, short-lived, and kept in memory only. The Client half manages everything through
 * exact `/api/pcmid/remote-relay/*` Connection routes and the row's volatile Config fields.
 *
 * @module @pcmid/dsh-remote-relay
 */

import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import z from '@deepseek-ai/schemastery'
import {
  MAX_RELAYS, TunnelError, Mux, acceptHost, createIdentity, encodePairing, fromBase64Url, hostSocketUrl, importIdentity,
  normalizeRelayUrl, openSocket, randomToken, relayHealthUrl,
} from './launcher/tunnel.js'
import { RemoteDevices } from './remotes.js'

/** Cordis plugin name; the patch row id `remote-relay` is the settings namespace. */
export const name = 'remote-relay'
export const inject = ['connection', 'webServer', 'credentials']

export const Config = z.object({
  enabled: z.boolean().default(false).volatile()
    .description('Keep a connection to the relay so paired devices can reach this DSH.'),
  relays: z.array(z.string()).default([]).volatile()
    .description('Relay WebSocket endpoints in priority order, for example wss://relay.example.com/ws.'),
  relayUrl: z.string().default('').volatile()
    .description('Single relay endpoint of earlier versions; used only while the relay list is empty.'),
  launcherUrl: z.string().default('').volatile()
    .description('HTTPS address of the deployed launcher page; pairing QR codes open it.'),
  hostName: z.string().default('').volatile()
    .description('Name paired devices show for this DSH; empty uses the computer name.'),
  pairingMinutes: z.number().min(1).max(1440).default(10).volatile()
    .description('Minutes a pairing code stays valid.'),
})

/** Exact `/api` routes this plugin answers; only owner Peers reach exact routes. */
const API_PREFIX = '/api/pcmid/remote-relay'
const OPERATIONS = [
  'status', 'pair', 'cancel-pairing', 'revoke', 'rename', 'remotes', 'remote-add', 'remote-remove', 'remote-open', 'remote-close', 'remote-probe', 'remote-relay-pin',
  'last-session', 'session-opened',
]
const OWNER = { principal: { kind: 'owner' } }
const IDENTITY_KEY = 'remote-relay/identity'
const DEVICES_KEY = 'remote-relay/devices'
/** The Session last opened in any window of this DSH, so each window reopens it. */
const LAST_SESSION_KEY = 'remote-relay/last-session'
const SESSION_ID = /^[\w.:-]{1,200}$/
const LAST_SESSION_FLUSH_MS = 1000
const RECORD_VERSION = 1
const CONTROL_PING_MS = 30_000
const REPLACED_RETRY_MS = 60_000
const LAST_SEEN_FLUSH_MS = 60_000
/** How long a relay's measured latency is shown before the next status read measures it again. */
const LATENCY_MAX_AGE_MS = 60_000

const DROP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'cookie', 'origin', 'referer', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'x-real-ip', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol',
  'sec-websocket-accept',
])
const DROP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'trailer', 'upgrade', 'set-cookie',
  'strict-transport-security', 'alt-svc',
])

function defaultHostName() {
  return os.hostname().replace(/\.local$/i, '') || 'DSH'
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function ok(value) {
  return { ok: true, value }
}

function failure(code, message) {
  return { ok: false, error: { code: `remote-relay/${code}`, message, details: {} } }
}

function relayHost(relayUrl) {
  try {
    return new URL(relayUrl).host
  } catch (_invalid) {
    return relayUrl
  }
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/** One remote device session: a host-data socket, its channel, and its multiplexer. */
class DeviceSession {
  constructor(runner, connectionId) {
    this.runner = runner
    this.connectionId = connectionId
    this.since = Date.now()
    this.device = undefined
    this.ws = undefined
    this.mux = undefined
    this.closed = false
  }

  close(code, reason) {
    this.closed = true
    if (this.mux !== undefined) this.mux.channel.close(code, reason)
    else if (this.ws !== undefined) {
      try { this.ws.close(code, reason) } catch (_closing) { /* already closing */ }
    }
  }
}

/** Relay connection, device admission, and loopback proxy for one plugin activation. */
class RemoteRelayHost {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.identity = undefined
    this.devices = []
    this.sessions = new Map()
    this.pairing = undefined
    /** One control connection per relay, keyed by normalized relay URL. */
    this.runners = new Map()
    this.control = { state: 'starting', error: null, since: Date.now() }
    this.cookie = undefined
    this.disposed = false
    this.loadFailure = undefined
    this.lastSeenTimer = undefined
    this.lastSession = undefined
    this.lastSessionTimer = undefined
    this.ready = this.load()
    this.remotes = new RemoteDevices(ctx, {
      log: (level, message) => { this.log(level, message) },
      localServerId: () => this.identity?.id,
      localName: () => this.settings().hostName,
    })
  }

  log(level, message) {
    try {
      this.ctx.logger?.[level]?.(`remote-relay: ${message}`)
    } catch (_loggerUnavailable) {
      // Logging must never break the relay connection.
    }
  }

  settings() {
    const read = (field, fallback) => {
      const reference = this.config[field]
      const value = typeof reference?.get === 'function' ? reference.get() : reference
      return value === undefined || value === null ? fallback : value
    }
    const listed = read('relays', [])
    const texts = (Array.isArray(listed) && listed.length > 0 ? listed : [read('relayUrl', '')])
      .map((value) => String(value ?? '').trim())
      .filter((text) => text !== '')
    // Entries in priority order: a valid entry has `url`, an unusable one has `error`.
    const relays = []
    const relayUrls = []
    for (const text of texts) {
      try {
        const url = normalizeRelayUrl(text)
        if (relayUrls.includes(url)) continue
        if (relayUrls.length >= MAX_RELAYS) {
          relays.push({ text, error: `At most ${MAX_RELAYS} relays are used` })
          continue
        }
        relayUrls.push(url)
        relays.push({ text, url })
      } catch (error) {
        relays.push({ text, error: errorText(error) })
      }
    }
    return {
      enabled: read('enabled', false) === true,
      relays,
      relayUrls,
      relayError: relays.find((relay) => relay.error !== undefined)?.error,
      launcherUrl: String(read('launcherUrl', '')).trim(),
      hostName: String(read('hostName', '')).trim() || defaultHostName(),
      pairingMinutes: Number(read('pairingMinutes', 10)) || 10,
    }
  }

  async load() {
    try {
      const credentials = this.ctx.credentials
      const generated = await createIdentity({ extractable: true })
      const record = await credentials.modifyRecord(IDENTITY_KEY, async (current) => {
        if (current !== undefined) return undefined
        return { kind: 'grant', payload: { version: RECORD_VERSION, privateJwk: generated.privateJwk } }
      })
      const payload = record?.payload
      if (record?.kind !== 'grant' || payload?.version !== RECORD_VERSION || typeof payload.privateJwk?.d !== 'string') {
        throw new Error(`credential record ${IDENTITY_KEY} has an unsupported format`)
      }
      this.identity = await importIdentity(payload.privateJwk)
      const devices = await credentials.readRecord(DEVICES_KEY)
      if (devices !== undefined) {
        if (devices.kind !== 'grant' || devices.payload?.version !== RECORD_VERSION || !Array.isArray(devices.payload.devices)) {
          throw new Error(`credential record ${DEVICES_KEY} has an unsupported format`)
        }
        this.devices = devices.payload.devices.filter((device) => typeof device?.id === 'string')
      }
    } catch (error) {
      this.loadFailure = errorText(error)
      this.setControl('error', `Could not load the remote access identity: ${this.loadFailure}`)
      this.log('warn', this.loadFailure)
    }
  }

  async saveDevices() {
    const devices = this.devices.map((device) => ({ ...device }))
    await this.ctx.credentials.modifyRecord(DEVICES_KEY, async () => ({ kind: 'grant', payload: { version: RECORD_VERSION, devices } }))
  }

  /** State of the plugin as a whole: identity loading, switched off, or nothing to connect to. */
  setControl(state, error = null) {
    if (this.control.state !== state || this.control.error !== error) this.control = { state, error, since: Date.now() }
  }

  /** State of one relay's control connection. */
  setRelayState(runner, state, error = null) {
    if (runner.state !== state || runner.error !== error) Object.assign(runner, { state, error, since: Date.now() })
  }

  /** Control state over all relays: online while any relay is online. */
  aggregateControl() {
    if (this.runners.size === 0) return this.control
    const runners = [...this.runners.values()]
    for (const state of ['online', 'connecting', 'replaced']) {
      const match = runners.filter((runner) => runner.state === state)
      if (match.length > 0) {
        return { state, error: state === 'online' ? null : match[0].error, since: Math.min(...match.map((runner) => runner.since)) }
      }
    }
    const first = runners[0]
    return { state: first.state, error: first.error, since: first.since }
  }

  /** Start and stop relay connections to match the current Config. */
  async reconcile() {
    await this.ready
    if (this.disposed || this.identity === undefined) return
    const settings = this.settings()
    const wanted = settings.enabled ? settings.relayUrls : []
    for (const runner of [...this.runners.values()]) {
      if (!wanted.includes(runner.relayUrl)) this.stopRunner(runner)
    }
    // Keep the map in priority order, so snapshots list relays the way devices try them.
    const runners = new Map()
    for (const relayUrl of wanted) {
      let runner = this.runners.get(relayUrl)
      if (runner === undefined) {
        runner = { relayUrl, abort: new AbortController(), control: undefined, state: 'connecting', error: null, since: Date.now(), latencyMs: null, latencyAt: 0 }
        void this.controlLoop(runner)
      }
      runners.set(relayUrl, runner)
    }
    this.runners = runners
    if (!settings.enabled) {
      this.pairing = undefined
      this.setControl('disabled')
    } else if (wanted.length === 0) {
      this.setControl('unconfigured', settings.relayError ?? null)
    } else {
      this.setControl('online')
    }
  }

  stopRunner(runner) {
    this.runners.delete(runner.relayUrl)
    runner.abort.abort()
    for (const [key, session] of [...this.sessions]) {
      if (session.runner !== runner) continue
      session.close(1001, 'remote access stopped')
      this.sessions.delete(key)
    }
  }

  async controlLoop(runner) {
    let failures = 0
    while (!runner.abort.signal.aborted) {
      this.setRelayState(runner, 'connecting', failures > 0 ? runner.error : null)
      const outcome = await this.runControl(runner)
      if (runner.abort.signal.aborted) return
      let delay
      if (outcome.code === 4001) {
        this.setRelayState(runner, 'replaced', 'Another DSH using this identity took over the relay connection.')
        delay = REPLACED_RETRY_MS
      } else {
        failures = outcome.opened ? 0 : failures + 1
        const reason = outcome.opened ? `The relay closed the connection (${outcome.code})` : await this.diagnose(runner.relayUrl, outcome)
        if (runner.abort.signal.aborted) return
        this.setRelayState(runner, 'offline', reason)
        delay = Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)) * (0.75 + Math.random() * 0.5)
      }
      await wait(delay, runner.abort.signal)
    }
  }

  /** Measure the HTTP round trip to a relay, at most once per {@link LATENCY_MAX_AGE_MS}. */
  async measure(runner) {
    const now = Date.now()
    if (runner.measuring || now - runner.latencyAt < LATENCY_MAX_AGE_MS) return
    runner.measuring = true
    try {
      const started = performance.now()
      const response = await fetch(relayHealthUrl(runner.relayUrl), { signal: AbortSignal.timeout(5000) })
      await response.arrayBuffer()
      runner.latencyMs = response.ok ? Math.round(performance.now() - started) : null
    } catch (_unreachable) {
      // An unreachable relay shows no latency; its connection state already says why.
      runner.latencyMs = null
    } finally {
      runner.latencyAt = Date.now()
      runner.measuring = false
    }
  }

  async diagnose(relayUrl, outcome) {
    try {
      const response = await fetch(relayHealthUrl(relayUrl), { signal: AbortSignal.timeout(5000) })
      const body = await response.json().catch(() => undefined)
      if (response.ok && body?.ok === true) {
        return 'The relay is reachable but refused this host. Check that the system clock is correct.'
      }
      return `The relay health check answered HTTP ${response.status}.`
    } catch (error) {
      return `Cannot reach the relay: ${errorText(error.cause ?? error)}`
    } finally {
      this.log('debug', `control socket closed before opening (${outcome.code})`)
    }
  }

  runControl(runner) {
    return new Promise((resolve) => {
      let opened = false
      let ping
      let ws
      const abort = () => { try { ws?.close(1000, 'disabled') } catch (_closing) { /* already closing */ } }
      const finish = (code, reason) => {
        clearInterval(ping)
        runner.abort.signal.removeEventListener('abort', abort)
        runner.control = undefined
        resolve({ opened, code, reason })
      }
      hostSocketUrl(runner.relayUrl, this.identity, 'host-control').then((url) => {
        if (runner.abort.signal.aborted) {
          finish(1000, 'disabled')
          return
        }
        ws = new WebSocket(url)
        runner.control = ws
        runner.abort.signal.addEventListener('abort', abort, { once: true })
        ws.addEventListener('open', () => {
          opened = true
          this.setRelayState(runner, 'online')
          runner.latencyAt = 0
          void this.measure(runner)
          ping = setInterval(() => { if (ws.readyState === 1) ws.send('{"type":"ping"}') }, CONTROL_PING_MS)
        })
        ws.addEventListener('message', (event) => {
          if (typeof event.data === 'string') this.onControlMessage(runner, event.data)
        })
        ws.addEventListener('close', (event) => { finish(event.code, event.reason) })
      }, (error) => {
        this.setRelayState(runner, 'error', errorText(error))
        finish(1006, errorText(error))
      })
    })
  }

  onControlMessage(runner, text) {
    let message
    try {
      message = JSON.parse(text)
    } catch (_malformed) {
      // The relay protocol only sends JSON on the control socket; ignore anything else.
      return
    }
    if (message?.type === 'sync' && Array.isArray(message.connectionIds)) {
      for (const id of message.connectionIds) void this.attach(runner, String(id))
    } else if (message?.type === 'connected' && typeof message.connectionId === 'string') {
      void this.attach(runner, message.connectionId)
    } else if (message?.type === 'disconnected' && typeof message.connectionId === 'string') {
      this.sessions.get(`${runner.relayUrl} ${message.connectionId}`)?.close(1000, 'client disconnected')
    }
  }

  async attach(runner, connectionId) {
    // Connection ids are only unique within one relay.
    const key = `${runner.relayUrl} ${connectionId}`
    if (this.sessions.has(key) || runner.abort.signal.aborted) return
    const session = new DeviceSession(runner, connectionId)
    this.sessions.set(key, session)
    try {
      session.ws = await openSocket(await hostSocketUrl(runner.relayUrl, this.identity, 'host-data', connectionId))
      if (runner.abort.signal.aborted || session.closed) {
        session.close(1001, 'remote access stopped')
        return
      }
      const settings = this.settings()
      const { channel, device, probe } = await acceptHost(session.ws, {
        identity: this.identity,
        hostName: settings.hostName,
        pairingSecret: (pairingId) => this.pairingSecret(pairingId),
        authorize: (request) => this.authorize(request),
        relays: settings.relayUrls,
      })
      session.device = device
      session.mux = new Mux(channel, {
        request: (exchange) => this.proxyRequest(exchange),
        websocket: (socket) => this.proxyWebSocket(socket),
        keepAliveMs: 25_000,
      })
      session.mux.onclose = () => {
        if (this.sessions.get(key) === session) this.sessions.delete(key)
        this.touch(device.id)
      }
      if (session.closed) session.close(1001, 'remote access stopped')
      this.log(probe ? 'debug' : 'info', `device "${device.name}" ${probe ? 'measured latency' : 'connected'} through ${relayHost(runner.relayUrl)}`)
    } catch (error) {
      if (this.sessions.get(key) === session) this.sessions.delete(key)
      session.close(4000, 'handshake failed')
      if (!(error instanceof TunnelError) || error.code !== 'closed') this.log('debug', `rejected connection: ${errorText(error)}`)
    }
  }

  pairingSecret(pairingId) {
    const pairing = this.pairing
    if (pairing === undefined || pairing.id !== pairingId || pairing.expiresAt < Date.now()) return undefined
    return fromBase64Url(pairing.secret)
  }

  async authorize({ mode, pairingId, deviceId, deviceKey, deviceName }) {
    const now = Date.now()
    if (mode === 'pair') {
      const pairing = this.pairing
      if (pairing === undefined || pairing.id !== pairingId || pairing.expiresAt < now) {
        return { ok: false, code: 'pairing-invalid', reason: 'This pairing code is invalid, used, or expired' }
      }
      this.pairing = undefined
      const name = deviceName || 'Device'
      this.devices = [
        ...this.devices.filter((device) => device.id !== deviceId),
        { id: deviceId, name, publicJwk: deviceKey, pairedAt: now, lastSeenAt: now },
      ]
      try {
        await this.saveDevices()
      } catch (error) {
        this.devices = this.devices.filter((device) => device.id !== deviceId)
        this.log('warn', `could not save the paired device: ${errorText(error)}`)
        return { ok: false, code: 'storage', reason: 'The host could not save this device' }
      }
      this.log('info', `paired device "${name}"`)
      return { ok: true, device: { id: deviceId, name } }
    }
    const device = this.devices.find((candidate) => candidate.id === deviceId)
    if (device === undefined) {
      return { ok: false, code: 'unknown-device', reason: 'This device is not paired with this DSH, or it was removed' }
    }
    device.lastSeenAt = now
    this.scheduleLastSeenFlush()
    return { ok: true, device: { id: device.id, name: device.name } }
  }

  touch(deviceId) {
    const device = this.devices.find((candidate) => candidate.id === deviceId)
    if (device === undefined) return
    device.lastSeenAt = Date.now()
    this.scheduleLastSeenFlush()
  }

  scheduleLastSeenFlush() {
    if (this.lastSeenTimer !== undefined || this.disposed) return
    this.lastSeenTimer = setTimeout(() => {
      this.lastSeenTimer = undefined
      this.saveDevices().catch((error) => { this.log('warn', `could not save device activity: ${errorText(error)}`) })
    }, LAST_SEEN_FLUSH_MS)
  }

  // -------------------------------------------------------------------------
  // Loopback proxy
  // -------------------------------------------------------------------------

  target() {
    const origin = new URL(this.ctx.webServer.getOrigin())
    return { origin: origin.origin, protocol: origin.protocol, hostname: origin.hostname.replace(/^\[|\]$/g, ''), port: Number(origin.port) || (origin.protocol === 'https:' ? 443 : 80), host: origin.host }
  }

  agentFor(target) {
    return target.protocol === 'https:' ? https : http
  }

  sessionCookie(refresh = false) {
    if (refresh || this.cookie === undefined) {
      const pending = this.acquireCookie()
      this.cookie = pending
      pending.catch(() => { if (this.cookie === pending) this.cookie = undefined })
    }
    return this.cookie
  }

  acquireCookie() {
    const target = this.target()
    const url = new URL(this.ctx.connection.authenticatedUrl(`${target.origin}/`))
    return new Promise((resolve, reject) => {
      const request = this.agentFor(target).request({
        hostname: target.hostname,
        port: target.port,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        headers: { host: target.host, accept: 'text/html' },
        rejectUnauthorized: false,
      }, (response) => {
        response.resume()
        const cookies = response.headers['set-cookie'] ?? []
        const pair = cookies.map((cookie) => cookie.split(';', 1)[0].trim()).find((cookie) => cookie.startsWith('dsh-auth-'))
        if (pair !== undefined) resolve(pair)
        else reject(new Error(`the local Web GUI issued no session cookie (HTTP ${response.statusCode})`))
      })
      request.on('error', reject)
      request.end()
    })
  }

  requestHeaders(pairs, target, cookie) {
    const headers = {}
    for (const [name, value] of pairs) {
      if (DROP_REQUEST_HEADERS.has(name) || name.startsWith('sec-fetch-') || name.startsWith(':')) continue
      if (headers[name] === undefined) headers[name] = value
      else headers[name] = Array.isArray(headers[name]) ? [...headers[name], value] : [headers[name], value]
    }
    headers.host = target.host
    headers.cookie = cookie
    return headers
  }

  async proxyRequest(exchange) {
    if (!exchange.path.startsWith('/') || exchange.path.startsWith('//')) {
      exchange.respond(400, 'Bad Request', [['content-type', 'text/plain']])
      await exchange.write(new TextEncoder().encode('invalid request target'))
      exchange.end()
      return
    }
    const target = this.target()
    const replayable = exchange.method === 'GET' || exchange.method === 'HEAD'
    let cookie = await this.sessionCookie()
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.forward(exchange, target, cookie, replayable)
      if (response.statusCode === 401 && replayable && attempt === 0) {
        response.resume()
        cookie = await this.sessionCookie(true)
        continue
      }
      const headers = []
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        const name = response.rawHeaders[i].toLowerCase()
        if (!DROP_RESPONSE_HEADERS.has(name)) headers.push([name, response.rawHeaders[i + 1]])
      }
      exchange.respond(response.statusCode ?? 502, response.statusMessage ?? '', headers)
      for await (const chunk of response) await exchange.write(chunk)
      exchange.end()
      return
    }
  }

  forward(exchange, target, cookie, replayable) {
    return new Promise((resolve, reject) => {
      const request = this.agentFor(target).request({
        hostname: target.hostname,
        port: target.port,
        method: exchange.method,
        path: exchange.path,
        headers: this.requestHeaders(exchange.headers, target, cookie),
        rejectUnauthorized: false,
        signal: exchange.signal,
      }, resolve)
      request.on('error', reject)
      if (replayable) {
        request.end()
        return
      }
      void (async () => {
        const reader = exchange.body.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (!request.write(value)) await new Promise((drained) => { request.once('drain', drained) })
          }
          request.end()
        } catch (error) {
          request.destroy(error instanceof Error ? error : new Error(String(error)))
        }
      })()
    })
  }

  async proxyWebSocket(session) {
    if (!session.path.startsWith('/') || session.path.startsWith('//')) {
      session.fail('invalid request target')
      return
    }
    const target = this.target()
    const cookie = await this.sessionCookie()
    const url = `${target.protocol === 'https:' ? 'wss:' : 'ws:'}//${target.host}${session.path}`
    const ws = new WebSocket(url, { protocols: session.protocols, headers: { cookie } })
    ws.binaryType = 'arraybuffer'
    let opened = false
    ws.addEventListener('open', () => {
      opened = true
      session.accept(ws.protocol)
    })
    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') session.sendText(event.data)
      else session.sendBinary(new Uint8Array(event.data))
    })
    ws.addEventListener('close', (event) => {
      if (opened) session.close(event.code, event.reason)
      else {
        // An expired cookie fails the upgrade; the next socket gets a fresh one.
        void this.sessionCookie(true).catch(() => {})
        session.fail(`the local Web GUI refused the socket (${event.code})`)
      }
    })
    session.onmessage = (data) => {
      if (ws.readyState === 1) ws.send(data)
    }
    session.onclose = (code, reason) => {
      const valid = code === 1000 || (code >= 3000 && code <= 4999)
      try {
        ws.close(valid ? code : 1000, valid ? reason : '')
      } catch (_closing) {
        // The local socket is already closing.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Owner operations
  // -------------------------------------------------------------------------

  snapshot() {
    const settings = this.settings()
    const online = new Map()
    for (const session of this.sessions.values()) {
      if (session.device !== undefined && session.mux !== undefined && !session.mux.closed) {
        online.set(session.device.id, (online.get(session.device.id) ?? 0) + 1)
      }
    }
    const relays = settings.relays.map((relay) => {
      if (relay.url === undefined) {
        return { url: relay.text, host: relayHost(relay.text), state: 'invalid', error: relay.error, since: null, latencyMs: null }
      }
      const runner = this.runners.get(relay.url)
      if (runner === undefined) return { url: relay.url, host: relayHost(relay.url), state: 'disabled', error: null, since: null, latencyMs: null }
      return { url: relay.url, host: relayHost(relay.url), state: runner.state, error: runner.error, since: runner.since, latencyMs: runner.state === 'online' ? runner.latencyMs : null }
    })
    const pairing = this.pairing !== undefined && this.pairing.expiresAt > Date.now() ? this.pairing : undefined
    return {
      ready: this.identity !== undefined,
      serverId: this.identity?.id ?? null,
      hostName: settings.hostName,
      relayUrl: settings.relayUrls[0] ?? null,
      relayError: settings.relayError ?? null,
      relays,
      control: this.aggregateControl(),
      devices: this.devices
        .map((device) => ({ id: device.id, name: device.name, pairedAt: device.pairedAt, lastSeenAt: device.lastSeenAt ?? null, connections: online.get(device.id) ?? 0 }))
        .sort((a, b) => b.pairedAt - a.pairedAt),
      pairing: pairing === undefined ? null : {
        code: pairing.code,
        link: pairing.link,
        expiresAt: pairing.expiresAt,
      },
      now: Date.now(),
    }
  }

  async createPairing() {
    await this.ready
    if (this.identity === undefined) throw new TunnelError('unavailable', this.loadFailure ?? 'The identity is not loaded')
    const settings = this.settings()
    if (!settings.enabled) throw new TunnelError('disabled', 'Turn on remote access first')
    if (settings.relayUrls.length === 0) throw new TunnelError('unconfigured', settings.relayError ?? 'Add a relay address first')
    const id = randomToken(8)
    const secret = randomToken(16)
    const expiresAt = Date.now() + settings.pairingMinutes * 60_000
    const code = encodePairing({ relayUrls: settings.relayUrls, serverId: this.identity.id, pairingId: id, secret, hostName: settings.hostName, expiresAt })
    let link = null
    if (settings.launcherUrl !== '') {
      try {
        const url = new URL(settings.launcherUrl)
        url.hash = code
        link = url.href
      } catch (_invalid) {
        // An invalid launcher address leaves only the dsh-remote:// link; the UI shows the field error.
        link = null
      }
    }
    this.pairing = { id, secret, expiresAt, code, link }
    return this.snapshot()
  }

  async revoke(deviceId) {
    await this.ready
    const before = this.devices.length
    this.devices = this.devices.filter((device) => device.id !== deviceId)
    if (this.devices.length === before) throw new TunnelError('not-found', 'This device is not paired')
    await this.saveDevices()
    for (const session of this.sessions.values()) {
      if (session.device?.id === deviceId) session.close(4401, 'device removed')
    }
    return this.snapshot()
  }

  async rename(deviceId, name) {
    await this.ready
    const device = this.devices.find((candidate) => candidate.id === deviceId)
    if (device === undefined) throw new TunnelError('not-found', 'This device is not paired')
    const trimmed = String(name ?? '').trim().slice(0, 80)
    if (trimmed === '') throw new TunnelError('invalid', 'The name is empty')
    device.name = trimmed
    await this.saveDevices()
    return this.snapshot()
  }

  async handle(endpoint, payload, peer) {
    if (peer?.principal?.kind !== 'owner') return failure('forbidden', 'Only the owner can manage remote access')
    try {
      switch (endpoint) {
        case 'status':
          await this.ready
          // Latency is refreshed while someone reads the status, and shows up on the next read.
          for (const runner of this.runners.values()) if (runner.state === 'online') void this.measure(runner)
          return ok(this.snapshot())
        case 'pair':
          return ok(await this.createPairing())
        case 'cancel-pairing':
          this.pairing = undefined
          return ok(this.snapshot())
        case 'revoke':
          return ok(await this.revoke(String(payload?.id ?? '')))
        case 'rename':
          return ok(await this.rename(String(payload?.id ?? ''), payload?.name))
        case 'remotes':
          return ok(await this.remotesSnapshot())
        case 'remote-add': {
          await this.ready
          const id = await this.remotes.add(String(payload?.code ?? ''), payload?.name)
          return ok({ ...await this.remotesSnapshot(), added: id })
        }
        case 'remote-remove': {
          const { forgotten } = await this.remotes.remove(String(payload?.id ?? ''))
          return ok({ ...await this.remotesSnapshot(), forgotten })
        }
        case 'remote-open':
          return ok(await this.remotes.open(String(payload?.id ?? '')))
        case 'remote-probe': {
          const id = String(payload?.id ?? '')
          return ok({ id, results: await this.remotes.probe(id) })
        }
        case 'remote-relay-pin': {
          const id = String(payload?.id ?? '')
          await this.remotes.prefer(id, typeof payload?.relayUrl === 'string' ? payload.relayUrl : null)
          return ok({ id, results: await this.remotes.probe(id) })
        }
        case 'remote-close':
          this.remotes.close(String(payload?.id ?? ''))
          return ok(await this.remotesSnapshot())
        case 'last-session':
          return ok({ id: (await this.readLastSession())?.id ?? null })
        case 'session-opened':
          return ok(await this.setLastSession(String(payload?.id ?? '')))
        default:
          return failure('not-found', `Unknown operation ${endpoint}`)
      }
    } catch (error) {
      return failure(error instanceof TunnelError ? error.code : 'internal', errorText(error))
    }
  }

  /** The Session last opened in any window, or null. */
  async readLastSession() {
    if (this.lastSession === undefined) {
      let record
      try {
        record = await this.ctx.credentials.readRecord(LAST_SESSION_KEY)
      } catch (error) {
        this.log('warn', `remote-relay: cannot read the last opened session: ${errorText(error)}`)
      }
      const payload = record?.kind === 'grant' ? record.payload : undefined
      this.lastSession ??= payload?.version === RECORD_VERSION && SESSION_ID.test(payload.id) ? { id: payload.id, at: payload.at } : null
    }
    return this.lastSession
  }

  /** Record a window's newly opened Session; writes are coalesced. */
  async setLastSession(id) {
    if (!SESSION_ID.test(id)) throw new TunnelError('invalid', 'Not a session id')
    await this.readLastSession()
    this.lastSession = { id, at: Date.now() }
    if (this.lastSessionTimer === undefined && !this.disposed) {
      this.lastSessionTimer = setTimeout(() => {
        this.lastSessionTimer = undefined
        void this.saveLastSession()
      }, LAST_SESSION_FLUSH_MS)
    }
    return this.lastSession
  }

  async saveLastSession() {
    const value = this.lastSession
    if (!value) return
    try {
      await this.ctx.credentials.modifyRecord(LAST_SESSION_KEY, async () => ({ kind: 'grant', payload: { version: RECORD_VERSION, ...value } }))
    } catch (error) {
      this.log('warn', `remote-relay: cannot save the last opened session: ${errorText(error)}`)
    }
  }

  /** Local identity and the other DSH hosts this one can switch to. */
  async remotesSnapshot() {
    await this.ready
    await this.remotes.ready
    return {
      local: { name: this.settings().hostName, serverId: this.identity?.id ?? null },
      remotes: this.remotes.list(),
      now: Date.now(),
    }
  }

  dispose() {
    this.disposed = true
    this.remotes.dispose()
    clearTimeout(this.lastSeenTimer)
    for (const runner of [...this.runners.values()]) this.stopRunner(runner)
    if (this.lastSeenTimer !== undefined) {
      this.lastSeenTimer = undefined
      void this.saveDevices().catch(() => {})
    }
    if (this.lastSessionTimer !== undefined) {
      clearTimeout(this.lastSessionTimer)
      this.lastSessionTimer = undefined
      void this.saveLastSession()
    }
  }
}

/**
 * Activate remote access for this profile.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - volatile Config references.
 */
export function apply(ctx, config) {
  // The bundle ships its own settings page, so no generated page is needed.
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), 'remote-relay: settings presentation')
  })
  const host = new RemoteRelayHost(ctx, config)
  ctx.effect(() => {
    void host.reconcile()
    return () => { host.dispose() }
  }, 'remote-relay: relay connection')
  ctx.on('loader/volatile-update', () => { void host.reconcile() })
  // Exact Fetch routes on the shared /api channel reach only owner Peers, on every carrier
  // (browser HTTP, the desktop shell, and this plugin's own tunnel). They speak the Connection RPC
  // envelope, so the Client half calls them with `ctx.connection.rpc.call('/api', ...)`.
  for (const operation of OPERATIONS) {
    ctx.connection.fetch.register({
      path: `${API_PREFIX}/${operation}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let envelope
        try {
          envelope = await request.json()
        } catch (_malformed) {
          // A body that is not JSON cannot carry an rpcId to answer.
          return new Response('body is not JSON', { status: 400 })
        }
        const rpcId = typeof envelope?.rpcId === 'string' ? envelope.rpcId : 'invalid-request'
        const result = envelope?.type === 'client-request'
          ? await host.handle(operation, envelope.payload, OWNER)
          : failure('bad-request', 'Expected a client-request envelope')
        return Response.json({ type: 'server-response', rpcId, result })
      },
    })
  }
}
