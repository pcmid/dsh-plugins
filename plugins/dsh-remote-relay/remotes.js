/**
 * Device switcher, Host half: other DSH hosts this DSH has paired with as a device, and the loopback
 * origins that show their Web GUI inside this DSH's own window.
 *
 * Pairing uses the one-time code the other DSH shows on its settings page; the device key it creates is
 * stored in the credential record `remote-relay/remotes` together with a random per-host label.
 * Opening a host starts one end-to-end encrypted tunnel to it and serves it at
 * `http://<label>.localhost:<port>/` on loopback. The label is the admission secret: a request
 * reaches the tunnel only when its Host header names a known label on this listener's port, so
 * another web page cannot address it, and the origin shares no cookies or storage with this DSH or
 * with other hosts. Browsers that do not resolve `*.localhost` to loopback cannot load the views.
 *
 * @module @pcmid/dsh-remote-relay/remotes
 */

import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { RemoteHost, TunnelError, createIdentity, decodePairing, importIdentity, normalizeRelayList, pairDevice } from './launcher/tunnel.js'
import { forwardRequest, forwardUpgrade } from './loopback.js'

const REMOTES_KEY = 'remote-relay/remotes'
const RECORD_VERSION = 1
/** A tunnel with no request or socket in flight for this long is closed. */
const IDLE_STOP_MS = 2 * 60_000
/** How long removing a host waits for it to confirm that it removed this DSH. */
const FORGET_TIMEOUT_MS = 6000
const LABEL_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const LABEL_PATTERN = /^([a-z2-7]{26})\.localhost:(\d+)$/

function newLabel() {
  return Array.from(randomBytes(26), (byte) => LABEL_ALPHABET[byte & 31]).join('')
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function relayHost(relayUrl) {
  try {
    return new URL(relayUrl).host
  } catch (_invalid) {
    return relayUrl
  }
}

function plain(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/** Paired remote hosts, their tunnels, and the loopback listener that serves them. */
export class RemoteDevices {
  /**
   * @param {object} ctx - plugin context with `credentials`.
   * @param {object} options - collaborators from the Host plugin.
   * @param {(level: string, message: string) => void} options.log - plugin logger.
   * @param {() => string | undefined} options.localServerId - this DSH's own relay identity, once loaded.
   * @param {() => string} options.localName - this DSH's display name.
   */
  constructor(ctx, options) {
    this.ctx = ctx
    this.options = options
    this.remotes = []
    this.keys = new Map()
    this.port = null
    this.sessions = new Map()
    this.servers = []
    this.listening = undefined
    this.disposed = false
    this.loadFailure = undefined
    this.ready = this.load().catch((error) => {
      this.loadFailure = errorText(error)
      this.options.log('warn', this.loadFailure)
    })
  }

  async loaded() {
    await this.ready
    if (this.loadFailure !== undefined) throw new TunnelError('unavailable', `Could not read the added devices: ${this.loadFailure}`)
  }

  async load() {
    const record = await this.ctx.credentials.readRecord(REMOTES_KEY)
    if (record === undefined) return
    const payload = record.payload
    if (record.kind !== 'grant' || payload?.version !== RECORD_VERSION || !Array.isArray(payload.remotes)) {
      throw new Error(`credential record ${REMOTES_KEY} has an unsupported format`)
    }
    this.port = Number.isInteger(payload.port) ? payload.port : null
    this.remotes = payload.remotes.filter((remote) => typeof remote?.serverId === 'string' && typeof remote.label === 'string')
    for (const remote of this.remotes) {
      // Records before relay lists hold one `relayUrl`; it stays written as the first relay.
      remote.relayUrls = normalizeRelayList(remote.relayUrls ?? remote.relayUrl)
      try {
        this.keys.set(remote.serverId, await importIdentity(remote.privateJwk))
      } catch (error) {
        this.options.log('warn', `the stored key for "${remote.hostName}" is unusable: ${errorText(error)}`)
      }
    }
  }

  async save() {
    const remotes = this.remotes.map((remote) => ({ ...remote }))
    const port = this.port
    await this.ctx.credentials.modifyRecord(REMOTES_KEY, async () => ({ kind: 'grant', payload: { version: RECORD_VERSION, port, remotes } }))
  }

  find(id) {
    const remote = this.remotes.find((candidate) => candidate.serverId === id)
    if (remote === undefined) throw new TunnelError('not-found', 'This device was removed')
    return remote
  }

  /** @returns {Array<object>} paired hosts with their tunnel state, most recently used first. */
  list() {
    return this.remotes
      .map((remote) => {
        const session = this.sessions.get(remote.serverId)
        const relays = remote.relayUrls.map(relayHost)
        const via = session?.status.state === 'connected' && session.status.relayUrl ? relayHost(session.status.relayUrl) : null
        const preferred = remote.preferredRelay !== undefined && remote.relayUrls.includes(remote.preferredRelay) ? relayHost(remote.preferredRelay) : null
        return {
          id: remote.serverId,
          name: remote.hostName || remote.serverId.slice(0, 8),
          deviceName: remote.deviceName,
          relay: via ?? relays[0] ?? '',
          relays,
          via,
          preferred,
          pairedAt: remote.pairedAt,
          lastOpenedAt: remote.lastOpenedAt ?? null,
          state: session?.status.state ?? 'idle',
          error: session?.status.error ?? null,
          code: session?.status.code ?? null,
        }
      })
      .sort((a, b) => (b.lastOpenedAt ?? b.pairedAt) - (a.lastOpenedAt ?? a.pairedAt))
  }

  /**
   * Pair with another DSH using its one-time code or link.
   * @param {string} code - pairing code, launcher link, or `dsh-remote://pair#…` link.
   * @param {string} [deviceName] - name the other DSH shows for this one.
   * @returns {Promise<string>} the paired host id.
   */
  async add(code, deviceName) {
    await this.loaded()
    const pairing = decodePairing(code)
    if (pairing.serverId === this.options.localServerId()) {
      throw new TunnelError('self', 'This pairing code belongs to this DSH')
    }
    const name = String(deviceName ?? '').trim().slice(0, 80) || this.options.localName()
    const previous = this.remotes.find((remote) => remote.serverId === pairing.serverId)
    // Pairing again keeps this DSH's device key, so the other DSH replaces its earlier entry for this
    // DSH instead of listing it twice; after a removal over there, the same key is admitted again.
    const kept = previous === undefined ? undefined : this.keys.get(previous.serverId)
    const device = kept === undefined ? await createIdentity({ extractable: true }) : { ...kept, privateJwk: previous.privateJwk }
    const result = await pairDevice({ pairing, device, deviceName: name })
    if (previous !== undefined) this.stop(previous.serverId)
    const entry = {
      serverId: pairing.serverId,
      relayUrls: result.relayUrls,
      relayUrl: result.relayUrls[0],
      hostName: result.hostName || pairing.hostName,
      deviceId: device.id,
      deviceName: result.device.name || name,
      privateJwk: device.privateJwk,
      pairedAt: Date.now(),
      lastOpenedAt: null,
      label: previous?.label ?? newLabel(),
    }
    this.remotes = [...this.remotes.filter((remote) => remote.serverId !== pairing.serverId), entry]
    this.keys.set(entry.serverId, device)
    await this.save()
    this.options.log('info', `paired with "${entry.hostName}" as "${entry.deviceName}"`)
    return entry.serverId
  }

  /**
   * Remove a paired host. The host is first asked to remove this DSH from its own device list, so
   * it does not keep listing a device whose key is about to be deleted.
   * @param {string} id - host id.
   * @returns {Promise<{ forgotten: boolean }>} whether the host confirmed that it no longer lists this DSH.
   */
  async remove(id) {
    await this.loaded()
    const remote = this.find(id)
    const forgotten = await this.forget(remote)
    this.stop(id)
    this.remotes = this.remotes.filter((candidate) => candidate.serverId !== id)
    this.keys.delete(id)
    await this.save()
    return { forgotten }
  }

  /**
   * Best effort: revoke this DSH's device on the host through its own tunnel. The host closes that
   * tunnel while revoking, so the answer is usually the next connection attempt being refused as an
   * unknown device. An unreachable host keeps its entry; the deleted key makes it unusable.
   */
  async forget(remote) {
    if (!this.keys.has(remote.serverId)) return false
    const session = this.session(remote)
    const settled = () => session.status.state === 'rejected'
    const deadline = Date.now() + FORGET_TIMEOUT_MS
    if (!settled()) {
      const body = JSON.stringify({ type: 'client-request', rpcId: 'forget', payload: { id: remote.deviceId } })
      const abort = new AbortController()
      const answer = session.remote
        .request({ method: 'POST', path: '/api/pcmid/remote-relay/revoke', headers: [['content-type', 'application/json']], body }, abort.signal)
        .then(async (response) => {
          const text = response.body === null ? '' : await new Response(response.body).text()
          try { return JSON.parse(text)?.result?.ok === true } catch (_invalid) { return false }
        }, () => false)
      let timer
      const timeout = new Promise((resolve) => { timer = setTimeout(resolve, FORGET_TIMEOUT_MS, false) })
      const confirmed = await Promise.race([answer, timeout])
      clearTimeout(timer)
      abort.abort()
      if (confirmed) return true
      while (!settled() && session.remote.running && Date.now() < deadline) await new Promise((resolve) => { setTimeout(resolve, 100) })
    }
    return session.status.state === 'rejected' && session.status.code === 'unknown-device'
  }

  /**
   * Start the tunnel to a paired host and return the loopback origin that serves it.
   * @param {string} id - host id.
   * @returns {Promise<{ origin: string }>} origin to load in a frame.
   */
  async open(id) {
    await this.loaded()
    const remote = this.find(id)
    await this.listen()
    this.session(remote)
    remote.lastOpenedAt = Date.now()
    void this.save().catch((error) => { this.options.log('warn', `could not save device use: ${errorText(error)}`) })
    return { origin: `http://${remote.label}.localhost:${this.port}` }
  }

  /** Close the tunnel to a host; a later request from its frame opens it again. */
  close(id) {
    this.stop(id)
  }

  session(remote) {
    const existing = this.sessions.get(remote.serverId)
    if (existing !== undefined && existing.status.state !== 'rejected') return existing
    if (existing !== undefined) this.stop(remote.serverId)
    const session = { status: { state: 'connecting', error: null, code: null, relayUrl: null }, active: 0, idle: undefined, remote: undefined }
    session.remote = this.client(remote, {
      onstatus: (status) => {
        session.status = { state: status.state, error: status.error ?? null, code: status.code ?? null, relayUrl: status.relayUrl ?? null }
        if (status.state === 'rejected') this.options.log('info', `"${remote.hostName}" refused this DSH: ${status.error}`)
      },
      onrelays: (relayUrls) => {
        remote.relayUrls = relayUrls
        remote.relayUrl = relayUrls[0]
        this.options.log('info', `"${remote.hostName}" now offers relays ${relayUrls.map(relayHost).join(', ')}`)
        void this.save().catch((error) => { this.options.log('warn', `could not save the relays of "${remote.hostName}": ${errorText(error)}`) })
      },
    })
    this.sessions.set(remote.serverId, session)
    if (session.remote.options.device === undefined) {
      session.status = { state: 'rejected', error: 'The stored device key is unusable; add this device again', code: 'storage' }
      return session
    }
    session.remote.start()
    this.scheduleIdle(remote.serverId, session)
    return session
  }

  client(remote, observers) {
    return new RemoteHost({
      relayUrls: remote.relayUrls,
      serverId: remote.serverId,
      device: this.keys.get(remote.serverId),
      deviceName: remote.deviceName,
      preferredRelay: remote.preferredRelay,
      ...observers,
    })
  }

  /**
   * Measure the round trip to a paired host through each of its relays. An open tunnel is measured
   * in place; nothing switches relays.
   * @param {string} id - host id.
   * @returns {Promise<Array<{ relayUrl: string, host: string, current: boolean, ms: number | null, code?: string, error?: string }>>} results in priority order.
   */
  async probe(id) {
    await this.loaded()
    const remote = this.find(id)
    if (!this.keys.has(id)) throw new TunnelError('storage', 'The stored device key is unusable; add this device again')
    const open = this.sessions.get(id)
    const client = open !== undefined && open.status.state !== 'rejected' ? open.remote : this.client(remote, {})
    const results = await client.probe()
    return results.map((result) => ({ ...result, host: relayHost(result.relayUrl) }))
  }

  /**
   * Prefer one of a paired host's relays, or none, and move an open tunnel onto it. The choice is
   * stored: later connections try that relay first while the host still offers it.
   * @param {string} id - host id.
   * @param {string | null} relayUrl - one of the host's relays, or null to follow its priority.
   * @returns {Promise<void>} settles once an open tunnel is back.
   */
  async prefer(id, relayUrl) {
    await this.loaded()
    const remote = this.find(id)
    if (relayUrl !== null && !remote.relayUrls.includes(relayUrl)) throw new TunnelError('not-found', 'This DSH does not offer that relay')
    if (relayUrl === null) delete remote.preferredRelay
    else remote.preferredRelay = relayUrl
    await this.save()
    const open = this.sessions.get(id)
    if (open !== undefined && open.status.state !== 'rejected') await open.remote.prefer(relayUrl)
  }

  stop(id) {
    const session = this.sessions.get(id)
    if (session === undefined) return
    this.sessions.delete(id)
    clearTimeout(session.idle)
    session.remote.stop()
  }

  scheduleIdle(id, session) {
    clearTimeout(session.idle)
    if (session.active > 0 || this.disposed) return
    session.idle = setTimeout(() => {
      if (this.sessions.get(id) === session && session.active === 0) this.stop(id)
    }, IDLE_STOP_MS)
  }

  hold(id, session) {
    session.active += 1
    clearTimeout(session.idle)
    let released = false
    return () => {
      if (released) return
      released = true
      session.active -= 1
      this.scheduleIdle(id, session)
    }
  }

  // -------------------------------------------------------------------------
  // Loopback listener
  // -------------------------------------------------------------------------

  listen() {
    this.listening ??= this.startListening().catch((error) => {
      this.listening = undefined
      throw error
    })
    return this.listening
  }

  async startListening() {
    const bind = (host, port) => new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => { this.onRequest(req, res) })
      server.on('upgrade', (req, socket, head) => { this.onUpgrade(req, socket, head) })
      server.on('clientError', (_error, socket) => { socket.destroy() })
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        resolve(server)
      })
    })
    let primary
    try {
      primary = await bind('127.0.0.1', this.port ?? 0)
    } catch (error) {
      if (this.port === null || error?.code !== 'EADDRINUSE') throw error
      this.options.log('info', `port ${this.port} is in use; device views move to a new port`)
      primary = await bind('127.0.0.1', 0)
    }
    this.servers.push(primary)
    const port = primary.address().port
    if (port !== this.port) {
      this.port = port
      await this.save()
    }
    // Browsers may try ::1 first for *.localhost; a second listener avoids the refused attempt.
    await bind('::1', port).then((server) => { this.servers.push(server) }, () => {})
    if (this.disposed) this.closeServers()
  }

  closeServers() {
    for (const server of this.servers.splice(0)) {
      server.closeAllConnections?.()
      server.close()
    }
  }

  /** Resolve the paired host addressed by a request, or the reason it is refused. */
  admit(req, upgrade) {
    const host = String(req.headers.host ?? '').toLowerCase()
    const match = LABEL_PATTERN.exec(host)
    const remote = match !== null && Number(match[2]) === this.port
      ? this.remotes.find((candidate) => candidate.label === match[1])
      : undefined
    if (remote === undefined) return { status: 404, message: 'Not found' }
    const origin = req.headers.origin
    if (origin !== undefined && origin !== `http://${host}`) return { status: 403, message: 'Cross-origin request refused' }
    // The view loads as a cross-site frame of this DSH; every other request comes from the view itself.
    if (!upgrade && req.headers['sec-fetch-site'] === 'cross-site' && req.headers['sec-fetch-mode'] !== 'navigate') {
      return { status: 403, message: 'Cross-site request refused' }
    }
    return { remote }
  }

  onRequest(req, res) {
    const verdict = this.admit(req, false)
    if (verdict.remote === undefined) {
      plain(res, verdict.status, verdict.message)
      return
    }
    const id = verdict.remote.serverId
    const session = this.session(verdict.remote)
    const release = this.hold(id, session)
    res.on('close', release)
    void forwardRequest(session.remote, req, res, {
      onerror: (error) => `${verdict.remote.hostName || 'DSH'}: ${error.message}`,
    }).finally(release)
  }

  onUpgrade(req, socket, head) {
    const verdict = this.admit(req, true)
    if (verdict.remote === undefined) {
      socket.on('error', () => {})
      socket.end(`HTTP/1.1 ${verdict.status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    const id = verdict.remote.serverId
    const session = this.session(verdict.remote)
    forwardUpgrade(session.remote, req, socket, head, { onclose: this.hold(id, session) })
  }

  dispose() {
    this.disposed = true
    for (const id of [...this.sessions.keys()]) this.stop(id)
    this.closeServers()
  }
}
