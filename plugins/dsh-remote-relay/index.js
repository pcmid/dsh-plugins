/**
 * Host half of the DSH remote relay bundle.
 *
 * While enabled, the plugin keeps one signed `host-control` socket on a self-hosted
 * openchamber-relay. For each device that dials the relay it opens a `host-data` socket, completes
 * the end-to-end encrypted handshake from `launcher/tunnel.js`, admits only paired devices, and
 * then forwards the device's HTTP requests and WebSockets to this process's own Web GUI on
 * loopback. The plugin signs in to the Web GUI with its own browser cookie, so the device never
 * receives a DSH credential and the Web GUI keeps listening on loopback only. A paired device
 * therefore acts with the owner's full authority.
 *
 * The identity key and the paired-device list live in `ctx.credentials` records. Pairing offers
 * are one-time, short-lived, and kept in memory only. The Client half manages everything through
 * exact `/api/remote-relay/*` Connection routes and the row's volatile Config fields.
 *
 * @module @pcmid/dsh-remote-relay
 */

import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import z from '@deepseek-ai/schemastery'
import {
  TunnelError, Mux, acceptHost, createIdentity, encodePairing, fromBase64Url, hostSocketUrl, importIdentity,
  normalizeRelayUrl, openSocket, randomToken, relayHealthUrl,
} from './launcher/tunnel.js'

/** Cordis plugin name; the patch row id `remote-relay` is the settings namespace. */
export const name = 'remote-relay'
export const inject = ['connection', 'webServer', 'credentials']

export const Config = z.object({
  enabled: z.boolean().default(false).volatile()
    .description('Keep a connection to the relay so paired devices can reach this DSH.'),
  relayUrl: z.string().default('').volatile()
    .description('Relay WebSocket endpoint, for example wss://relay.example.com/ws.'),
  launcherUrl: z.string().default('').volatile()
    .description('HTTPS address of the deployed launcher page; pairing QR codes open it.'),
  hostName: z.string().default('').volatile()
    .description('Name paired devices show for this DSH; empty uses the computer name.'),
  pairingMinutes: z.number().min(1).max(1440).default(10).volatile()
    .description('Minutes a pairing code stays valid.'),
})

/** Exact `/api` routes this plugin answers; only owner Peers reach exact routes. */
const API_PREFIX = '/api/remote-relay'
const OPERATIONS = ['status', 'pair', 'cancel-pairing', 'revoke', 'rename']
const OWNER = { principal: { kind: 'owner' } }
const IDENTITY_KEY = 'remote-relay/identity'
const DEVICES_KEY = 'remote-relay/devices'
const RECORD_VERSION = 1
const CONTROL_PING_MS = 30_000
const REPLACED_RETRY_MS = 60_000
const LAST_SEEN_FLUSH_MS = 60_000

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
  constructor(connectionId) {
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
    this.runner = undefined
    this.control = { state: 'starting', error: null, since: Date.now() }
    this.cookie = undefined
    this.disposed = false
    this.loadFailure = undefined
    this.lastSeenTimer = undefined
    this.ready = this.load()
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
    let relayUrl
    let relayError
    const relayText = String(read('relayUrl', '')).trim()
    if (relayText !== '') {
      try {
        relayUrl = normalizeRelayUrl(relayText)
      } catch (error) {
        relayError = errorText(error)
      }
    }
    return {
      enabled: read('enabled', false) === true,
      relayText,
      relayUrl,
      relayError,
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

  setControl(state, error = null) {
    if (this.control.state !== state || this.control.error !== error) this.control = { state, error, since: Date.now() }
  }

  /** Start, restart, or stop the relay connection to match the current Config. */
  async reconcile() {
    await this.ready
    if (this.disposed || this.identity === undefined) return
    const settings = this.settings()
    const wanted = settings.enabled && settings.relayUrl !== undefined ? settings.relayUrl : undefined
    if (this.runner !== undefined && this.runner.relayUrl === wanted) return
    this.stopRunner()
    if (!settings.enabled) {
      this.pairing = undefined
      this.setControl('disabled')
      return
    }
    if (settings.relayUrl === undefined) {
      this.setControl('unconfigured', settings.relayError ?? null)
      return
    }
    const runner = { relayUrl: settings.relayUrl, abort: new AbortController(), control: undefined }
    this.runner = runner
    void this.controlLoop(runner)
  }

  stopRunner() {
    const runner = this.runner
    if (runner === undefined) return
    this.runner = undefined
    runner.abort.abort()
    for (const session of this.sessions.values()) session.close(1001, 'remote access stopped')
    this.sessions.clear()
  }

  async controlLoop(runner) {
    let failures = 0
    while (!runner.abort.signal.aborted) {
      this.setControl('connecting', failures > 0 ? this.control.error : null)
      const outcome = await this.runControl(runner)
      if (runner.abort.signal.aborted) return
      let delay
      if (outcome.code === 4001) {
        this.setControl('replaced', 'Another DSH using this identity took over the relay connection.')
        delay = REPLACED_RETRY_MS
      } else {
        failures = outcome.opened ? 0 : failures + 1
        this.setControl('offline', outcome.opened ? `The relay closed the connection (${outcome.code})` : await this.diagnose(runner.relayUrl, outcome))
        delay = Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)) * (0.75 + Math.random() * 0.5)
      }
      await wait(delay, runner.abort.signal)
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
          this.setControl('online')
          ping = setInterval(() => { if (ws.readyState === 1) ws.send('{"type":"ping"}') }, CONTROL_PING_MS)
        })
        ws.addEventListener('message', (event) => {
          if (typeof event.data === 'string') this.onControlMessage(runner, event.data)
        })
        ws.addEventListener('close', (event) => { finish(event.code, event.reason) })
      }, (error) => {
        this.setControl('error', errorText(error))
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
      this.sessions.get(message.connectionId)?.close(1000, 'client disconnected')
    }
  }

  async attach(runner, connectionId) {
    if (this.sessions.has(connectionId) || runner.abort.signal.aborted) return
    const session = new DeviceSession(connectionId)
    this.sessions.set(connectionId, session)
    try {
      session.ws = await openSocket(await hostSocketUrl(runner.relayUrl, this.identity, 'host-data', connectionId))
      if (runner.abort.signal.aborted || session.closed) {
        session.close(1001, 'remote access stopped')
        return
      }
      const { channel, device } = await acceptHost(session.ws, {
        identity: this.identity,
        hostName: this.settings().hostName,
        pairingSecret: (pairingId) => this.pairingSecret(pairingId),
        authorize: (request) => this.authorize(request),
      })
      session.device = device
      session.mux = new Mux(channel, {
        request: (exchange) => this.proxyRequest(exchange),
        websocket: (socket) => this.proxyWebSocket(socket),
        keepAliveMs: 25_000,
      })
      session.mux.onclose = () => {
        if (this.sessions.get(connectionId) === session) this.sessions.delete(connectionId)
        this.touch(device.id)
      }
      if (session.closed) session.close(1001, 'remote access stopped')
      this.log('info', `device "${device.name}" connected`)
    } catch (error) {
      if (this.sessions.get(connectionId) === session) this.sessions.delete(connectionId)
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
    const pairing = this.pairing !== undefined && this.pairing.expiresAt > Date.now() ? this.pairing : undefined
    return {
      ready: this.identity !== undefined,
      serverId: this.identity?.id ?? null,
      hostName: settings.hostName,
      relayUrl: settings.relayUrl ?? null,
      relayError: settings.relayError ?? null,
      control: this.control,
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
    if (settings.relayUrl === undefined) throw new TunnelError('unconfigured', settings.relayError ?? 'Set the relay address first')
    const id = randomToken(8)
    const secret = randomToken(16)
    const expiresAt = Date.now() + settings.pairingMinutes * 60_000
    const code = encodePairing({ relayUrl: settings.relayUrl, serverId: this.identity.id, pairingId: id, secret, hostName: settings.hostName, expiresAt })
    let link = null
    if (settings.launcherUrl !== '') {
      try {
        const url = new URL(settings.launcherUrl)
        url.hash = code
        link = url.href
      } catch (_invalid) {
        // An invalid launcher address leaves only the connector code; the UI shows the field error.
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
        default:
          return failure('not-found', `Unknown operation ${endpoint}`)
      }
    } catch (error) {
      return failure(error instanceof TunnelError ? error.code : 'internal', errorText(error))
    }
  }

  dispose() {
    this.disposed = true
    clearTimeout(this.lastSeenTimer)
    this.stopRunner()
    if (this.lastSeenTimer !== undefined) {
      this.lastSeenTimer = undefined
      void this.saveDevices().catch(() => {})
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
