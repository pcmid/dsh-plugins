/**
 * OAuth for remote MCP servers (MCP authorization: OAuth 2.1 authorization code + PKCE S256, RFC 9728,
 * 8414, 7591, 8707), as specified in docs/auth-retry.md §2.
 *
 * Credential storage:
 * - The grant (client registration, endpoints, refresh token, expiry) is one `kind: 'grant'` record per
 *   server at `mcp-skills/oauth-<encoded server name>` ({@link grantKey}); a DSH credential key is exactly
 *   `<scope>/<id>` with lowercase hyphenated segments.
 * - The access token is stored only in the credential reference `MCP_<NAME>_OAUTH` ({@link oauthRef}),
 *   which the server entry's `Authorization: Bearer ${credential:…}` header resolves; mcp-client reconnects
 *   when that reference changes.
 * Token values are never logged, returned, or shown on the callback page.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { HostError, errorMessage } from './errors.js'
import { callbackPage, openCallbackListener } from './oauth-callback.js'
import { discover } from './oauth-discovery.js'
import { checkRemoteUrl, httpRequest, normalizeResource, parseBearerChallenge, parseJsonObject } from './oauth-http.js'

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
const KEY_PREFIX = 'mcp-skills/oauth-'
const AUTH_LIKE = /\b401\b|requires authorization|unauthori[sz]ed|invalid_token/i
const PROTOCOL_VERSION = '2025-06-18'
const CLIENT_NAME = 'DeepSeek Harness'
const MAX_CHECK_CACHE = 64
/** `setTimeout` accepts at most 2^31-1 ms; longer waits are chained. */
const MAX_TIMER_MS = 2 ** 31 - 1

/** Contract timings (docs/auth-retry.md); tests pass shorter values to {@link OAuthManager}. */
export const DEFAULT_TIMING = Object.freeze({
  checkTtlMs: 60_000,
  flowTtlMs: 10 * 60_000,
  flowKeepMs: 2 * 60_000,
  refreshLeadMs: 120_000,
  minRefreshDelayMs: 5_000,
  refreshRetryMs: 60_000,
  /** Minimum spacing of refreshes triggered by authorization failures, so a server that rejects every new token cannot loop. */
  failureRefreshIntervalMs: 60_000,
})

/**
 * @param {string} server - server name.
 * @returns {string} the access-token credential reference `MCP_<NAME>_OAUTH`.
 */
export function oauthRef(server) {
  return `MCP_${server.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_OAUTH`
}

/**
 * Credential key of a server's grant record. The id segment keeps `[a-z0-9]`, writes `-` as `--`, `_` as
 * `-0`, and an uppercase letter as `-` plus the lowercase letter, so distinct names never share a key.
 * @param {string} server - server name matching `[A-Za-z0-9_-]{1,32}`.
 * @returns {string} `mcp-skills/oauth-<encoded>`.
 */
export function grantKey(server) {
  const encoded = server.replace(/[^a-z0-9]/g, ch => (ch === '-' ? '--' : ch === '_' ? '-0' : `-${ch.toLowerCase()}`))
  return `${KEY_PREFIX}${encoded}`
}

/**
 * @param {unknown} text - an MCP connection error.
 * @returns {boolean} whether it looks like an authorization failure.
 */
export function isAuthError(text) {
  return typeof text === 'string' && AUTH_LIKE.test(text)
}

function checkServerName(server) {
  if (typeof server !== 'string' || !SERVER_NAME.test(server)) {
    throw new HostError('bad-request', `MCP server name ${JSON.stringify(server)} is invalid: use 1-32 letters, digits, "_", or "-"`)
  }
  return server
}

function optionalText(value, field) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new HostError('bad-request', `Field "${field}" must be text`)
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function base64url(buffer) {
  return buffer.toString('base64url')
}

function sameSecret(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  return left.length === right.length && timingSafeEqual(left, right)
}

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    // A malformed stored issuer is shown as stored.
    return String(url)
  }
}

/** Run `fn` at an absolute time, chaining timers past the `setTimeout` limit. */
function scheduleAt(time, fn) {
  const handle = { timer: undefined }
  const arm = () => {
    const delay = Math.max(0, time - Date.now())
    handle.timer = setTimeout(delay > MAX_TIMER_MS ? arm : fn, Math.min(delay, MAX_TIMER_MS))
    handle.timer.unref?.()
  }
  arm()
  return () => clearTimeout(handle.timer)
}

/** An explicit OAuth error response (`{ error, error_description }` with a 4xx status). */
class OAuthResponseError extends Error {
  constructor(endpoint, status, code, description) {
    super(`${new URL(endpoint).host} answered HTTP ${status}: ${code}${description ? ` (${description})` : ''}`)
    this.name = 'OAuthResponseError'
    this.code = code
  }
}

/** Read and validate a stored grant payload; `undefined` for anything else. */
export function parseGrant(record) {
  const payload = record?.kind === 'grant' ? record.payload : undefined
  if (typeof payload !== 'object' || payload === null || payload.version !== 1) return undefined
  const { server, endpoints, client, tokens } = payload
  if (typeof server !== 'string' || !SERVER_NAME.test(server)) return undefined
  if (typeof endpoints?.token !== 'string' || typeof client?.clientId !== 'string' || typeof tokens !== 'object' || tokens === null) return undefined
  return payload
}

/** Token endpoint request with the client's authentication method. */
async function tokenRequest(endpoint, client, params) {
  const body = new URLSearchParams(params)
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
  if (client.clientSecret !== undefined && client.authMethod === 'client_secret_basic') {
    const encode = text => encodeURIComponent(text).replace(/%20/g, '+')
    headers.authorization = `Basic ${Buffer.from(`${encode(client.clientId)}:${encode(client.clientSecret)}`).toString('base64')}`
  } else {
    body.set('client_id', client.clientId)
    if (client.clientSecret !== undefined && client.authMethod === 'client_secret_post') body.set('client_secret', client.clientSecret)
  }
  const response = await httpRequest(endpoint, { method: 'POST', headers, body: body.toString() })
  const json = parseJsonObject(response.body)
  if (response.status >= 400 && response.status < 500 && typeof json?.error === 'string') {
    throw new OAuthResponseError(endpoint, response.status, json.error, typeof json.error_description === 'string' ? json.error_description : '')
  }
  return { status: response.status, json }
}

/** Parse a successful token response. */
function readTokens(endpoint, { status, json }) {
  const host = new URL(endpoint).host
  if (status < 200 || status >= 300) throw new Error(`${host} answered the token request with HTTP ${status}`)
  if (typeof json?.access_token !== 'string' || json.access_token === '') throw new Error(`${host} returned no access token`)
  if (json.token_type !== undefined && String(json.token_type).toLowerCase() !== 'bearer') {
    throw new Error(`${host} returned a "${json.token_type}" token; only Bearer tokens are supported`)
  }
  const seconds = Number(json.expires_in)
  return {
    accessToken: json.access_token,
    ...(typeof json.refresh_token === 'string' && json.refresh_token !== '' ? { refreshToken: json.refresh_token } : {}),
    ...(json.expires_in !== undefined && Number.isFinite(seconds) && seconds > 0 ? { expiresAt: Date.now() + seconds * 1000 } : {}),
    ...(typeof json.scope === 'string' && json.scope !== '' ? { scope: json.scope } : {}),
  }
}

/** OAuth flows, grants, and token refresh for MCP servers. */
export class OAuthManager {
  #ctx
  #onChange
  #timing
  #flows = new Map()
  #serverFlows = new Map()
  #grants = new Map()
  #checks = new Map()
  #generation = 0
  #disposed = false

  /**
   * @param {object} ctx - plugin context; `credentials` is read lazily with `ctx.get`.
   * @param {{ onChange?: () => void, timing?: Partial<typeof DEFAULT_TIMING> }} [options] - `onChange` runs
   *   after any change visible in {@link view}.
   */
  constructor(ctx, { onChange = () => {}, timing = {} } = {}) {
    this.#ctx = ctx
    this.#onChange = onChange
    this.#timing = { ...DEFAULT_TIMING, ...timing }
  }

  #credentials() {
    const credentials = this.#ctx.get('credentials')
    if (credentials === undefined) throw new HostError('unavailable', 'The DSH credential store is not available, so OAuth cannot be used')
    return credentials
  }

  #changed() {
    if (!this.#disposed) this.#onChange()
  }

  #warn(message) {
    this.#ctx.logger?.warn?.(`mcp-skills: ${message}`)
  }

  // ── mcp-auth-check ────────────────────────────────────────────────────────────────────────────────

  /** `mcp-auth-check`: payload `{ url }`. */
  async check(payload) {
    const url = checkRemoteUrl(payload.url, 'Server URL')
    const entry = await this.#probe(url)
    return entry.result
  }

  /** Probe a server once (cached for `checkTtlMs`, except unreachable results). */
  async #probe(url) {
    const key = normalizeResource(url)
    const cached = this.#checks.get(key)
    if (cached !== undefined && Date.now() - cached.at < this.#timing.checkTtlMs) return cached
    const entry = { at: Date.now(), ...await this.#probeNow(url) }
    this.#checks.delete(key)
    if (entry.result.kind !== 'unreachable') {
      this.#checks.set(key, entry)
      while (this.#checks.size > MAX_CHECK_CACHE) this.#checks.delete(this.#checks.keys().next().value)
    }
    return entry
  }

  async #probeNow(url) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
    }
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'dsh-mcp-skills', version: '0.2.0' } },
    })
    let response
    try {
      response = await httpRequest(url, { method: 'POST', headers, body, readBody: false })
    } catch (error) {
      return { result: { kind: 'unreachable', error: errorMessage(error) } }
    }
    if (response.status >= 200 && response.status < 300) {
      const session = response.headers.get('mcp-session-id')
      if (session !== null) {
        try {
          await httpRequest(response.url, {
            method: 'DELETE',
            headers: { 'mcp-session-id': session, 'mcp-protocol-version': PROTOCOL_VERSION },
            readBody: false,
          })
        } catch {
          // Ending the probe session is a courtesy; the server expires it anyway.
        }
      }
      return { result: { kind: 'none' } }
    }
    if (response.status === 401) {
      const challenge = parseBearerChallenge(response.headers.get('www-authenticate'))
      let discovery
      try {
        discovery = await discover(url, challenge)
      } catch (error) {
        return { result: { kind: 'token', status: 401 }, challenge, discoveryError: errorMessage(error) }
      }
      if (discovery === undefined) return { result: { kind: 'token', status: 401 }, challenge }
      return {
        result: {
          kind: 'oauth',
          issuer: discovery.issuer,
          ...(discovery.scope === undefined ? {} : { scopes: discovery.scope.split(/\s+/) }),
          registration: discovery.endpoints.registration !== undefined,
        },
        challenge,
        discovery,
      }
    }
    if (response.status === 403) return { result: { kind: 'forbidden', status: 403 } }
    return { result: { kind: 'unreachable', error: `${url.host} answered HTTP ${response.status}` } }
  }

  // ── mcp-auth-start ────────────────────────────────────────────────────────────────────────────────

  /** `mcp-auth-start`: payload `{ server, url, clientId?, clientSecret? }`. */
  async start(payload) {
    const credentials = this.#credentials()
    const server = checkServerName(payload.server)
    const url = checkRemoteUrl(payload.url, 'Server URL')
    const clientId = optionalText(payload.clientId, 'clientId')
    const clientSecret = optionalText(payload.clientSecret, 'clientSecret')
    if (clientSecret !== undefined && clientId === undefined) throw new HostError('bad-request', 'A client secret needs a client ID')
    if (this.#disposed) throw new HostError('unavailable', 'The plugin is stopping')

    const discovery = await this.#discoveryFor(url)
    // Awaiting the old listener lets this flow reuse its port, which the stored client's redirect URI names.
    await this.#cancelServerFlow(server)
    const existing = parseGrant(await credentials.readRecord(grantKey(server)))
    let flow
    const listener = await openCallbackListener(existing?.client?.port, async (callbackUrl) => {
      if (flow === undefined || !this.#flows.has(flow.flowId)) {
        return { status: 410, html: callbackPage(false, 'This authorization is no longer active. Start it again in DSH.') }
      }
      try {
        await this.#receive(flow, callbackUrl.searchParams)
        return { status: 200, html: callbackPage(true) }
      } catch (error) {
        return { status: 400, html: callbackPage(false, errorMessage(error)) }
      }
    })
    try {
      const redirectUri = `http://localhost:${listener.port}/callback`
      const client = await this.#client(discovery, existing, redirectUri, clientId, clientSecret)
      const verifier = base64url(randomBytes(32))
      const state = base64url(randomBytes(32))
      const authUrl = new URL(discovery.endpoints.authorization)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('client_id', client.clientId)
      authUrl.searchParams.set('redirect_uri', redirectUri)
      authUrl.searchParams.set('code_challenge', base64url(createHash('sha256').update(verifier).digest()))
      authUrl.searchParams.set('code_challenge_method', 'S256')
      authUrl.searchParams.set('state', state)
      authUrl.searchParams.set('resource', discovery.resource)
      if (discovery.scope !== undefined) authUrl.searchParams.set('scope', discovery.scope)
      flow = {
        flowId: randomUUID(),
        server,
        serverUrl: url.href,
        status: 'pending',
        authUrl: authUrl.href,
        redirectUri,
        startedAt: Date.now(),
        state,
        verifier,
        discovery,
        client: { ...client, redirectUri, port: listener.port },
        listener,
      }
      flow.expiry = setTimeout(() => {
        this.#endFlow(flow, 'error', 'The authorization was not completed within 10 minutes; start it again')
      }, this.#timing.flowTtlMs)
      flow.expiry.unref?.()
      this.#flows.set(flow.flowId, flow)
      this.#serverFlows.set(server, flow.flowId)
      this.#changed()
      const ref = oauthRef(server)
      return { flowId: flow.flowId, authUrl: flow.authUrl, redirectUri, ref, header: 'Authorization', template: `Bearer \${credential:${ref}}` }
    } catch (error) {
      await listener.close()
      throw error
    }
  }

  async #discoveryFor(url) {
    let entry = await this.#probe(url)
    // A fresh probe is needed when the cached one predates a server-side change, such as enabling OAuth.
    if (entry.result.kind !== 'oauth' && Date.now() - entry.at > 1000) {
      this.#checks.delete(normalizeResource(url))
      entry = await this.#probe(url)
    }
    switch (entry.result.kind) {
      case 'oauth':
        return entry.discovery
      case 'unreachable':
        throw new HostError('oauth-failed', `Cannot reach ${url.host}: ${entry.result.error}`)
      case 'forbidden':
        throw new HostError('oauth-failed', `${url.host} refused the request (HTTP 403)`)
      case 'token':
        throw new HostError('oauth-failed', entry.discoveryError
          ?? `${url.host} asks for credentials (HTTP 401) but publishes no OAuth metadata; put an access token in the request headers instead`)
      default: {
        // The server answered without credentials; it may still publish metadata for optional authorization.
        const discovery = await discover(url, undefined)
        if (discovery === undefined) throw new HostError('oauth-failed', `${url.host} does not require authorization and publishes no OAuth metadata`)
        return discovery
      }
    }
  }

  /** Choose the OAuth client: explicit input, then a stored compatible one, then dynamic registration. */
  async #client(discovery, existing, redirectUri, clientId, clientSecret) {
    const endpoints = discovery.endpoints
    if (clientId !== undefined) {
      const methods = endpoints.authMethods
      const authMethod = clientSecret === undefined
        ? 'none'
        : methods === undefined || methods.includes('client_secret_basic') || !methods.includes('client_secret_post')
          ? 'client_secret_basic'
          : 'client_secret_post'
      return { clientId, ...(clientSecret === undefined ? {} : { clientSecret }), authMethod }
    }
    const stored = existing?.client
    if (stored !== undefined && existing.issuer === discovery.issuer
      && (stored.redirectUri === redirectUri || endpoints.registration === undefined)) {
      return {
        clientId: stored.clientId,
        ...(typeof stored.clientSecret === 'string' ? { clientSecret: stored.clientSecret } : {}),
        authMethod: stored.authMethod ?? 'none',
      }
    }
    if (endpoints.registration === undefined) {
      throw new HostError('oauth-client-required',
        `${hostOf(discovery.issuer)} does not support automatic client registration; enter a client ID registered for ${redirectUri}`)
    }
    let response
    try {
      response = await httpRequest(endpoints.registration, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_name: CLIENT_NAME,
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
      })
    } catch (error) {
      throw new HostError('oauth-failed', `Client registration at ${hostOf(endpoints.registration)} failed: ${errorMessage(error)}`)
    }
    const json = parseJsonObject(response.body)
    if (response.status < 200 || response.status >= 300 || typeof json?.client_id !== 'string' || json.client_id === '') {
      const reason = typeof json?.error === 'string' ? `${json.error}${typeof json.error_description === 'string' ? ` (${json.error_description})` : ''}` : `HTTP ${response.status}`
      throw new HostError('oauth-failed', `Client registration at ${hostOf(endpoints.registration)} failed: ${reason}`)
    }
    const secret = typeof json.client_secret === 'string' && json.client_secret !== '' ? json.client_secret : undefined
    const authMethod = typeof json.token_endpoint_auth_method === 'string' ? json.token_endpoint_auth_method : secret === undefined ? 'none' : 'client_secret_basic'
    if (!['none', 'client_secret_basic', 'client_secret_post'].includes(authMethod)) {
      throw new HostError('oauth-failed', `${hostOf(endpoints.registration)} registered the client with "${authMethod}" authentication, which is not supported`)
    }
    return { clientId: json.client_id, ...(secret === undefined ? {} : { clientSecret: secret }), authMethod }
  }

  // ── callback, mcp-auth-complete, mcp-auth-cancel ──────────────────────────────────────────────────

  /** Handle redirect parameters for a flow; resolves when the grant is stored. */
  async #receive(flow, params) {
    if (flow.status === 'exchanging') return await flow.exchange
    if (flow.status === 'done') return
    if (flow.status !== 'pending') {
      throw new HostError('bad-request', `This authorization ${flow.status === 'cancelled' ? 'was cancelled' : `failed: ${flow.error}`}; start it again`)
    }
    const state = params.get('state')
    if (state === null || !sameSecret(state, flow.state)) {
      throw new HostError('bad-request', 'The callback does not belong to this authorization (state mismatch); use the newest authorization page')
    }
    const error = params.get('error')
    if (error !== null) {
      const description = params.get('error_description')
      const message = `The authorization server returned "${error}"${description ? `: ${description}` : ''}`
      this.#endFlow(flow, 'error', message)
      throw new HostError('oauth-failed', message)
    }
    const code = params.get('code')
    if (code === null || code === '') throw new HostError('bad-request', 'The callback URL has no authorization code')
    flow.status = 'exchanging'
    this.#changed()
    flow.exchange = this.#exchange(flow, code)
    await flow.exchange
  }

  async #exchange(flow, code) {
    try {
      const { discovery, client } = flow
      let tokens
      try {
        tokens = readTokens(discovery.endpoints.token, await tokenRequest(discovery.endpoints.token, client, {
          grant_type: 'authorization_code',
          code,
          redirect_uri: flow.redirectUri,
          code_verifier: flow.verifier,
          resource: discovery.resource,
        }))
      } catch (error) {
        throw new HostError('oauth-failed', `Getting the access token failed: ${errorMessage(error)}`)
      }
      if (this.#disposed) throw new HostError('unavailable', 'The plugin is stopping')
      const payload = {
        version: 1,
        server: flow.server,
        serverUrl: flow.serverUrl,
        resource: discovery.resource,
        issuer: discovery.issuer,
        endpoints: {
          authorization: discovery.endpoints.authorization,
          token: discovery.endpoints.token,
          ...(discovery.endpoints.registration === undefined ? {} : { registration: discovery.endpoints.registration }),
          ...(discovery.endpoints.revocation === undefined ? {} : { revocation: discovery.endpoints.revocation }),
        },
        client: {
          clientId: client.clientId,
          ...(client.clientSecret === undefined ? {} : { clientSecret: client.clientSecret }),
          authMethod: client.authMethod,
          redirectUri: client.redirectUri,
          port: client.port,
        },
        tokens: {
          ...(tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken }),
          ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
          ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
        },
        updatedAt: Date.now(),
      }
      const credentials = this.#credentials()
      await credentials.modifyRecord(grantKey(flow.server), async () => ({ kind: 'grant', payload }))
      await credentials.set(oauthRef(flow.server), tokens.accessToken)
      this.#track(payload)
      this.#endFlow(flow, 'done')
    } catch (error) {
      this.#endFlow(flow, 'error', errorMessage(error))
      throw error
    }
  }

  /** `mcp-auth-complete`: payload `{ flowId, callbackUrl }`. */
  async complete(payload) {
    const flow = this.#flowFor(payload.flowId)
    if (typeof payload.callbackUrl !== 'string' || payload.callbackUrl.trim() === '') {
      throw new HostError('bad-request', 'Paste the full address from the browser after authorizing')
    }
    let url
    try {
      url = new URL(payload.callbackUrl.trim(), flow.redirectUri)
    } catch {
      // Reported with the expected form.
      throw new HostError('bad-request', `That is not the callback address; it starts with ${flow.redirectUri}`)
    }
    await this.#receive(flow, url.searchParams)
    return { ok: true }
  }

  /** `mcp-auth-cancel`: payload `{ flowId }`; unknown or finished flows are left as they are. */
  cancel(payload) {
    if (typeof payload.flowId !== 'string') throw new HostError('bad-request', 'Field "flowId" must be the id returned by mcp-auth-start')
    const flow = this.#flows.get(payload.flowId)
    if (flow !== undefined && flow.status === 'pending') this.#endFlow(flow, 'cancelled')
    return { ok: true }
  }

  #flowFor(flowId) {
    if (typeof flowId !== 'string') throw new HostError('bad-request', 'Field "flowId" must be the id returned by mcp-auth-start')
    const flow = this.#flows.get(flowId)
    if (flow === undefined) throw new HostError('not-found', 'This authorization has expired; start it again')
    return flow
  }

  /** Move a flow to a terminal status, close its listener, and drop it after `flowKeepMs`. */
  #endFlow(flow, status, error) {
    if (flow.status === 'done' || flow.status === 'error' || flow.status === 'cancelled') return
    flow.status = status
    if (error !== undefined) flow.error = error
    clearTimeout(flow.expiry)
    void flow.listener.close()
    flow.keep = setTimeout(() => this.#dropFlow(flow), this.#timing.flowKeepMs)
    flow.keep.unref?.()
    this.#changed()
  }

  #dropFlow(flow) {
    clearTimeout(flow.expiry)
    clearTimeout(flow.keep)
    void flow.listener.close()
    if (!this.#flows.delete(flow.flowId)) return
    if (this.#serverFlows.get(flow.server) === flow.flowId) this.#serverFlows.delete(flow.server)
    this.#changed()
  }

  /** Cancel and drop the server's flow; resolves when its listener port is free again. */
  #cancelServerFlow(server) {
    const flowId = this.#serverFlows.get(server)
    const flow = flowId === undefined ? undefined : this.#flows.get(flowId)
    if (flow === undefined) return Promise.resolve()
    if (flow.status === 'pending') this.#endFlow(flow, 'cancelled')
    this.#dropFlow(flow)
    return flow.listener.close()
  }

  // ── mcp-auth-forget ───────────────────────────────────────────────────────────────────────────────

  /** `mcp-auth-forget`: payload `{ server }`. Revokes the refresh token when possible, then deletes the grant and the reference. */
  async forget(payload) {
    const credentials = this.#credentials()
    const server = checkServerName(payload.server)
    await this.#cancelServerFlow(server)
    this.#untrack(server)
    const key = grantKey(server)
    const grant = parseGrant(await credentials.readRecord(key))
    const refreshToken = grant?.tokens.refreshToken
    if (grant?.endpoints.revocation !== undefined && refreshToken !== undefined) {
      try {
        await tokenRequest(grant.endpoints.revocation, grant.client, { token: refreshToken, token_type_hint: 'refresh_token' })
      } catch {
        // Revocation is best effort; the local grant is removed either way.
      }
    }
    await credentials.deleteRecord(key)
    await credentials.unset(oauthRef(server))
    this.#changed()
    return { ok: true }
  }

  // ── grants and refresh ────────────────────────────────────────────────────────────────────────────

  /** Read every stored grant and schedule refreshes. Runs when the credential store becomes available. */
  async load() {
    const generation = ++this.#generation
    const credentials = this.#ctx.get('credentials')
    if (credentials === undefined) return
    const entries = await credentials.listRecords()
    for (const entry of entries) {
      if (generation !== this.#generation || this.#disposed) return
      if (entry.kind !== 'grant' || !String(entry.key).startsWith(KEY_PREFIX)) continue
      let grant
      try {
        grant = parseGrant(await credentials.readRecord(entry.key))
      } catch (error) {
        this.#warn(`cannot read OAuth grant ${entry.key}: ${errorMessage(error)}`)
        continue
      }
      if (grant === undefined || grantKey(grant.server) !== String(entry.key)) continue
      if (generation !== this.#generation || this.#disposed) return
      this.#track(grant)
    }
  }

  /** Stop refresh timers; grants are re-read by the next {@link load}. */
  unload() {
    this.#generation++
    for (const server of [...this.#grants.keys()]) this.#untrack(server)
    this.#changed()
  }

  #untrack(server) {
    const grant = this.#grants.get(server)
    if (grant === undefined) return
    grant.cancel?.()
    this.#grants.delete(server)
  }

  /**
   * Track a stored grant as authorized and schedule its refresh or expiry. A refreshed grant keeps the
   * time of its last failure-triggered refresh, so repeated authorization failures cannot loop.
   */
  #track(payload, { refreshed = false } = {}) {
    const previous = this.#grants.get(payload.server)
    this.#untrack(payload.server)
    const grant = {
      state: 'authorized',
      issuer: hostOf(payload.issuer),
      expiresAt: payload.tokens.expiresAt,
      canRefresh: typeof payload.tokens.refreshToken === 'string',
      updatedAt: payload.updatedAt,
      generation: this.#generation,
      ...(refreshed && previous?.failureRefreshAt !== undefined ? { failureRefreshAt: previous.failureRefreshAt } : {}),
    }
    this.#grants.set(payload.server, grant)
    this.#schedule(payload.server, grant)
    this.#changed()
  }

  #schedule(server, grant) {
    grant.cancel?.()
    grant.cancel = undefined
    if (grant.expiresAt === undefined) return
    if (grant.canRefresh) {
      const at = Math.max(Date.now() + this.#timing.minRefreshDelayMs, grant.expiresAt - this.#timing.refreshLeadMs)
      grant.cancel = scheduleAt(at, () => { void this.#refresh(server, 'scheduled') })
    } else if (grant.expiresAt <= Date.now()) {
      void this.#expire(server, grant, 'expired', 'The access token expired; authorize again')
    } else {
      grant.cancel = scheduleAt(grant.expiresAt, () => { void this.#expire(server, grant, 'expired', 'The access token expired; authorize again') })
    }
  }

  /** Mark a grant unusable and remove the access token, which moves the server to `waiting-credentials`. */
  async #expire(server, grant, state, error) {
    if (this.#grants.get(server) !== grant) return
    grant.state = state
    grant.error = error
    this.#changed()
    try {
      await this.#ctx.get('credentials')?.unset(oauthRef(server))
    } catch (unsetError) {
      this.#warn(`cannot remove the expired access token of "${server}": ${errorMessage(unsetError)}`)
    }
  }

  /**
   * Refresh a grant's access token under the record lock, rotating the refresh token when the server
   * returns a new one. Concurrent calls share one refresh.
   */
  #refresh(server, reason) {
    const grant = this.#grants.get(server)
    if (grant === undefined) return Promise.resolve()
    grant.refreshing ??= this.#refreshNow(server, grant, reason).finally(() => { grant.refreshing = undefined })
    return grant.refreshing
  }

  async #refreshNow(server, grant, reason) {
    const credentials = this.#ctx.get('credentials')
    if (credentials === undefined) return
    const current = () => this.#grants.get(server) === grant && grant.generation === this.#generation && !this.#disposed
    let outcome = { kind: 'missing' }
    try {
      await credentials.modifyRecord(grantKey(server), async (record) => {
        const payload = parseGrant(record)
        const refreshToken = payload?.tokens.refreshToken
        if (payload === undefined || refreshToken === undefined) return undefined
        if (reason === 'scheduled' && payload.updatedAt !== grant.updatedAt) {
          // Another process refreshed this grant and stored its access token already.
          outcome = { kind: 'newer', payload }
          return undefined
        }
        let tokens
        try {
          tokens = readTokens(payload.endpoints.token, await tokenRequest(payload.endpoints.token, payload.client, {
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            ...(typeof payload.resource === 'string' ? { resource: payload.resource } : {}),
          }))
        } catch (error) {
          if (!(error instanceof OAuthResponseError)) {
            outcome = { kind: 'transient', error }
            return undefined
          }
          // The server refused the refresh token; drop it so no later start retries it.
          const { refreshToken: _dropped, ...rest } = payload.tokens
          outcome = { kind: 'rejected', error, payload: { ...payload, tokens: rest, updatedAt: Date.now() } }
          return { kind: 'grant', payload: outcome.payload }
        }
        const next = {
          ...payload,
          tokens: {
            refreshToken: tokens.refreshToken ?? refreshToken,
            ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
            ...((tokens.scope ?? payload.tokens.scope) === undefined ? {} : { scope: tokens.scope ?? payload.tokens.scope }),
          },
          updatedAt: Date.now(),
        }
        outcome = { kind: 'refreshed', payload: next, accessToken: tokens.accessToken }
        return { kind: 'grant', payload: next }
      })
    } catch (error) {
      // A store failure keeps a rejection a rejection; anything else is retried. When storing refreshed
      // tokens failed, the old refresh token may already be rotated away and the next attempt reports it.
      if (outcome.kind !== 'rejected') outcome = { kind: 'transient', error }
    }
    switch (outcome.kind) {
      case 'refreshed':
        // A grant forgotten or replaced meanwhile must not get this token back.
        if (!current()) return
        try {
          await credentials.set(oauthRef(server), outcome.accessToken)
        } catch (error) {
          outcome = { kind: 'transient', error }
          break
        }
        if (current()) this.#track(outcome.payload, { refreshed: true })
        return
      case 'newer':
        if (current()) this.#track(outcome.payload, { refreshed: true })
        return
      case 'rejected':
        if (!current()) return
        grant.canRefresh = false
        grant.updatedAt = outcome.payload.updatedAt
        grant.cancel?.()
        grant.cancel = undefined
        grant.state = 'expired'
        grant.error = `The authorization server refused to renew the access token (${outcome.error.code}); authorize again`
        this.#changed()
        if (grant.expiresAt === undefined || grant.expiresAt <= Date.now()) {
          await this.#expire(server, grant, 'expired', grant.error)
        } else {
          grant.cancel = scheduleAt(grant.expiresAt, () => { void this.#expire(server, grant, 'expired', grant.error) })
        }
        return
      case 'missing':
        if (current()) {
          this.#untrack(server)
          this.#changed()
        }
        return
      default:
        break
    }
    if (!current()) return
    // Transient failure: retry every `refreshRetryMs`, also after expiry (the refresh token usually
    // outlives the access token), and remove the expired access token meanwhile.
    const message = `Renewing the access token failed: ${errorMessage(outcome.error)}`
    grant.cancel?.()
    grant.cancel = scheduleAt(Date.now() + this.#timing.refreshRetryMs, () => { void this.#refresh(server, 'retry') })
    if (grant.expiresAt !== undefined && grant.expiresAt <= Date.now()) {
      if (grant.state !== 'error') await this.#expire(server, grant, 'error', `${message}; retrying every minute`)
    } else {
      grant.error = `${message}; retrying every minute`
      this.#changed()
    }
  }

  /**
   * React to an MCP connection that failed with an authorization error: refresh the token when the grant
   * has a refresh token (at most once per `failureRefreshIntervalMs`), otherwise mark the grant expired.
   * @param {string} server - server name.
   */
  handleAuthFailure(server) {
    const grant = this.#grants.get(server)
    if (grant === undefined) return
    const now = Date.now()
    if (grant.canRefresh && now - (grant.failureRefreshAt ?? -Infinity) >= this.#timing.failureRefreshIntervalMs) {
      grant.failureRefreshAt = now
      void this.#refresh(server, 'auth-failure')
      return
    }
    if (grant.state === 'authorized') {
      grant.state = 'expired'
      grant.error = grant.canRefresh
        ? 'The server keeps rejecting renewed access tokens; authorize again'
        : 'The server rejected the access token; authorize again'
      this.#changed()
    }
  }

  // ── state ─────────────────────────────────────────────────────────────────────────────────────────

  /** @returns {string[]} servers with a grant or a retained flow. */
  servers() {
    return [...new Set([...this.#grants.keys(), ...this.#serverFlows.keys()])]
  }

  /**
   * @param {string} server - server name.
   * @returns {{ auth?: object, flow?: object }} the §2.6 fields for `mcp-state`.
   */
  view(server) {
    const out = {}
    const grant = this.#grants.get(server)
    if (grant !== undefined) {
      out.auth = {
        state: grant.state,
        issuer: grant.issuer,
        ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
        canRefresh: grant.canRefresh,
        ...(grant.error === undefined ? {} : { error: grant.error }),
      }
    }
    const flowId = this.#serverFlows.get(server)
    const flow = flowId === undefined ? undefined : this.#flows.get(flowId)
    if (flow !== undefined) {
      out.flow = {
        flowId: flow.flowId,
        status: flow.status,
        authUrl: flow.authUrl,
        redirectUri: flow.redirectUri,
        startedAt: flow.startedAt,
        ...(flow.error === undefined ? {} : { error: flow.error }),
      }
    }
    return out
  }

  /** Cancel flows, close listeners, and stop timers. */
  async dispose() {
    this.#disposed = true
    this.#generation++
    for (const server of [...this.#grants.keys()]) this.#untrack(server)
    const listeners = []
    for (const flow of this.#flows.values()) {
      clearTimeout(flow.expiry)
      clearTimeout(flow.keep)
      if (flow.status === 'pending') flow.status = 'cancelled'
      listeners.push(flow.listener.close())
    }
    this.#flows.clear()
    this.#serverFlows.clear()
    this.#checks.clear()
    await Promise.all(listeners)
  }
}
