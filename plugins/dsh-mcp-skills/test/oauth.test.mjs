import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { grantKey, isAuthError, oauthRef } from '../host/oauth.js'
import { parseBearerChallenge } from '../host/oauth-http.js'
import { createMcpHost, eventually, fakeCredentials, fakeManager, startOAuthEnv } from './mcp-support.mjs'

const SERVER = 'my-server'
const REF = 'MCP_MY_SERVER_OAUTH'
const KEY = 'mcp-skills/oauth-my--server'

/** Start a test environment and a host; both are closed when the test ends. */
async function setup(t, { as, mcp, services = {}, timing, config } = {}) {
  const env = await startOAuthEnv({ as, mcp })
  const credentials = services.credentials === null ? undefined : services.credentials ?? fakeCredentials()
  const host = createMcpHost({ services: { ...services, credentials }, timing, config })
  t.after(async () => {
    await host.dispose()
    await env.close()
  })
  return { env, host, credentials }
}

/** Follow the authorization redirect without reaching the callback; returns the callback URL. */
async function approve(authUrl) {
  const response = await fetch(authUrl, { redirect: 'manual' })
  assert.equal(response.status, 302, await response.text())
  return response.headers.get('location')
}

async function serverState(host, name = SERVER) {
  return (await host.value('mcp-state', {})).servers[name]
}

/** Authorize `SERVER` end to end through the real callback listener. */
async function authorize(env, host, extra = {}) {
  const started = await host.value('mcp-auth-start', { server: SERVER, url: env.mcpUrl, ...extra })
  const callback = await approve(started.authUrl)
  const page = await fetch(callback)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /授权完成，可以关闭此页面回到 DSH。/)
  return started
}

describe('naming', () => {
  it('derives the reference and a valid credential key from the server name', () => {
    assert.equal(oauthRef('my-server'), 'MCP_MY_SERVER_OAUTH')
    assert.equal(oauthRef('GitHub_2'), 'MCP_GITHUB_2_OAUTH')
    assert.equal(grantKey('my-server'), 'mcp-skills/oauth-my--server')
    assert.equal(grantKey('GitHub_2'), 'mcp-skills/oauth--git-hub-02')
    const names = ['a-b', 'a_b', 'aB', 'ab', 'a--b', 'a-0b', 'A', 'a']
    assert.equal(new Set(names.map(grantKey)).size, names.length)
    for (const name of names) assert.match(grantKey(name), /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/)
  })

  it('recognizes authorization failures and parses Bearer challenges', () => {
    for (const text of ['Error POSTing to endpoint (HTTP 401): {}', 'Server requires authorization', 'Unauthorized', 'invalid_token']) assert.ok(isAuthError(text), text)
    for (const text of ['connection closed', 'HTTP 4010', 'fetch failed']) assert.ok(!isAuthError(text), text)
    assert.deepEqual(parseBearerChallenge('Basic realm="x", Bearer realm="mcp", resource_metadata="https://a.example/.well-known/x", scope="a b", error="invalid_token"'),
      { realm: 'mcp', resource_metadata: 'https://a.example/.well-known/x', scope: 'a b', error: 'invalid_token' })
    assert.deepEqual(parseBearerChallenge('Bearer error=invalid_token, error_description="say \\"hi\\""'), { error: 'invalid_token', error_description: 'say "hi"' })
    assert.equal(parseBearerChallenge('Basic realm="x"'), undefined)
    assert.equal(parseBearerChallenge(null), undefined)
  })
})

describe('mcp-auth-check', () => {
  it('reports oauth with issuer, scopes, and registration support', async (t) => {
    const { env, host } = await setup(t)
    assert.deepEqual(await host.value('mcp-auth-check', { url: env.mcpUrl }), {
      kind: 'oauth', issuer: `${env.base}/as`, scopes: ['mcp:read', 'mcp:write'], registration: true,
    })
    const requests = env.mcpLog.length
    await host.value('mcp-auth-check', { url: env.mcpUrl })
    assert.equal(env.mcpLog.length, requests, 'the result is cached')
    assert.equal(env.mcpLog[0].authorization, undefined)
  })

  it('prefers the challenge scope and falls back to the server origin as issuer', async (t) => {
    const scoped = await setup(t, { as: { challengeScope: 'mcp:read' } })
    assert.deepEqual((await scoped.host.value('mcp-auth-check', { url: scoped.env.mcpUrl })).scopes, ['mcp:read'])
    const legacy = await setup(t, { as: { issuerPath: '', protectedResource: false, registration: false } })
    assert.deepEqual(await legacy.host.value('mcp-auth-check', { url: legacy.env.mcpUrl }), {
      kind: 'oauth', issuer: legacy.env.base, registration: false,
    })
  })

  it('reports none (ending the session), token, forbidden, and unreachable', async (t) => {
    const open = await setup(t, { mcp: 'none' })
    assert.deepEqual(await open.host.value('mcp-auth-check', { url: open.env.mcpUrl }), { kind: 'none' })
    assert.deepEqual(open.env.mcpLog.map(entry => [entry.method, entry.session]), [['POST', undefined], ['DELETE', 'session-1']])
    const token = await setup(t, { as: { metadata: false } })
    assert.deepEqual(await token.host.value('mcp-auth-check', { url: token.env.mcpUrl }), { kind: 'token', status: 401 })
    const plain = await setup(t, { as: { pkceMethods: ['plain'] } })
    assert.deepEqual(await plain.host.value('mcp-auth-check', { url: plain.env.mcpUrl }), { kind: 'token', status: 401 })
    const forbidden = await setup(t, { mcp: 'forbidden' })
    assert.deepEqual(await forbidden.host.value('mcp-auth-check', { url: forbidden.env.mcpUrl }), { kind: 'forbidden', status: 403 })
    const closed = await startOAuthEnv()
    const url = closed.mcpUrl
    await closed.close()
    const unreachable = await open.host.value('mcp-auth-check', { url })
    assert.equal(unreachable.kind, 'unreachable')
    assert.match(unreachable.error, /127\.0\.0\.1/)
  })

  it('accepts only https, or http on a loopback host', async (t) => {
    const { host } = await setup(t)
    for (const url of ['http://example.com/mcp', 'ftp://127.0.0.1/mcp', 'not a url', 'https://user:pw@example.com/mcp']) {
      assert.equal((await host.error('mcp-auth-check', { url })).code, 'bad-request', url)
    }
  })
})

describe('mcp-auth-start and the callback', () => {
  it('registers a client, builds a PKCE authorization URL, and stores the grant after the callback', async (t) => {
    const { env, host, credentials } = await setup(t)
    const started = await host.value('mcp-auth-start', { server: SERVER, url: env.mcpUrl })
    assert.equal(started.ref, REF)
    assert.equal(started.header, 'Authorization')
    assert.equal(started.template, 'Bearer ${credential:MCP_MY_SERVER_OAUTH}')
    assert.match(started.redirectUri, /^http:\/\/localhost:\d+\/callback$/)
    assert.deepEqual(env.as.state.registrations, [{
      client_name: 'DeepSeek Harness',
      redirect_uris: [started.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }])
    const authUrl = new URL(started.authUrl)
    assert.equal(`${authUrl.origin}${authUrl.pathname}`, `${env.base}/as/authorize`)
    const params = Object.fromEntries(authUrl.searchParams)
    assert.deepEqual(Object.keys(params).sort(), ['client_id', 'code_challenge', 'code_challenge_method', 'redirect_uri', 'resource', 'response_type', 'scope', 'state'])
    assert.equal(params.response_type, 'code')
    assert.equal(params.code_challenge_method, 'S256')
    assert.match(params.code_challenge, /^[A-Za-z0-9_-]{43}$/)
    assert.match(params.state, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(params.redirect_uri, started.redirectUri)
    assert.equal(params.resource, env.mcpUrl)
    assert.equal(params.scope, 'mcp:read mcp:write')
    assert.deepEqual((await serverState(host)).flow, {
      flowId: started.flowId, status: 'pending', authUrl: started.authUrl, redirectUri: started.redirectUri, startedAt: (await serverState(host)).flow.startedAt,
    })

    const page = await fetch(await approve(started.authUrl))
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /授权完成/)
    assert.match(html, /Authorization is complete/)

    const exchange = env.as.state.log.find(entry => entry.grantType === 'authorization_code')
    assert.equal(exchange.params.redirect_uri, started.redirectUri)
    assert.equal(exchange.params.resource, env.mcpUrl)
    assert.equal(exchange.params.client_id, params.client_id)
    assert.match(exchange.params.code_verifier, /^[A-Za-z0-9_-]{43}$/)

    const record = credentials.records.get(KEY)
    assert.equal(record.kind, 'grant')
    const { payload } = record
    assert.equal(payload.version, 1)
    assert.equal(payload.server, SERVER)
    assert.equal(payload.serverUrl, env.mcpUrl)
    assert.equal(payload.resource, env.mcpUrl)
    assert.equal(payload.issuer, `${env.base}/as`)
    assert.deepEqual(payload.endpoints, {
      authorization: `${env.base}/as/authorize`, token: `${env.base}/as/token`, registration: `${env.base}/as/register`, revocation: `${env.base}/as/revoke`,
    })
    assert.deepEqual(payload.client, { clientId: params.client_id, authMethod: 'none', redirectUri: started.redirectUri, port: Number(new URL(started.redirectUri).port) })
    assert.ok(env.as.state.refresh.has(payload.tokens.refreshToken))
    assert.ok(payload.tokens.expiresAt > Date.now() + 3500_000)
    assert.equal(payload.tokens.scope, 'mcp:read mcp:write')
    assert.ok(env.as.verify(`Bearer ${credentials.refs.get(REF)}`), 'the reference holds a valid access token')
    assert.ok(!JSON.stringify(payload).includes(credentials.refs.get(REF)), 'the record never holds the access token')

    const state = await serverState(host)
    assert.equal(state.flow.status, 'done')
    assert.deepEqual(state.auth, { state: 'authorized', issuer: new URL(env.base).host, expiresAt: payload.tokens.expiresAt, canRefresh: true })
    const visible = JSON.stringify([started, await host.value('mcp-state', {}), html])
    assert.ok(!visible.includes(credentials.refs.get(REF)) && !visible.includes(payload.tokens.refreshToken), 'no token reaches a response')
    await assert.rejects(fetch(started.redirectUri), 'the callback listener is closed')
  })

  it('reuses the stored client and port on re-authorization', async (t) => {
    const { env, host, credentials } = await setup(t)
    const first = await authorize(env, host)
    const second = await host.value('mcp-auth-start', { server: SERVER, url: env.mcpUrl })
    assert.equal(second.redirectUri, first.redirectUri)
    assert.equal(env.as.state.registrations.length, 1)
    assert.equal(new URL(second.authUrl).searchParams.get('client_id'), credentials.records.get(KEY).payload.client.clientId)
  })

  it('completes with a pasted callback URL and rejects a state mismatch', async (t) => {
    const { env, host, credentials } = await setup(t)
    const started = await host.value('mcp-auth-start', { server: SERVER, url: env.mcpUrl })
    const callback = new URL(await approve(started.authUrl))
    const forged = new URL(callback)
    forged.searchParams.set('state', 'forged-state')
    const mismatch = await host.error('mcp-auth-complete', { flowId: started.flowId, callbackUrl: forged.href })
    assert.equal(mismatch.code, 'bad-request')
    assert.match(mismatch.message, /state mismatch/)
    const page = await fetch(forged)
    assert.equal(page.status, 400)
    assert.match(await page.text(), /state mismatch/)
    assert.equal((await serverState(host)).flow.status, 'pending')
    assert.equal(credentials.records.size, 0)

    assert.deepEqual(await host.value('mcp-auth-complete', { flowId: started.flowId, callbackUrl: callback.href }), { ok: true })
    assert.equal((await serverState(host)).flow.status, 'done')
    assert.ok(credentials.refs.has(REF))
    assert.deepEqual(await host.value('mcp-auth-complete', { flowId: started.flowId, callbackUrl: callback.href }), { ok: true })
    assert.equal(env.as.state.log.filter(entry => entry.grantType === 'authorization_code').length, 1)
    assert.equal((await host.error('mcp-auth-complete', { flowId: 'unknown', callbackUrl: callback.href })).code, 'not-found')
  })

  it('needs a client ID without dynamic registration, and authenticates a confidential client', async (t) => {
    const { env, host, credentials } = await setup(t, {
      as: { registration: false, staticClients: [{ clientId: 'public-client' }, { clientId: 'secret-client', clientSecret: 's3cret value' }] },
    })
    const required = await host.error('mcp-auth-start', { server: SERVER, url: env.mcpUrl })
    assert.equal(required.code, 'oauth-client-required')
    assert.match(required.message, /client ID/)

    await authorize(env, host, { clientId: 'public-client' })
    assert.equal(env.as.state.log.at(-1).authMethod, 'none')
    assert.equal(credentials.records.get(KEY).payload.client.authMethod, 'none')

    await authorize(env, host, { clientId: 'secret-client', clientSecret: 's3cret value' })
    const exchange = env.as.state.log.at(-1)
    assert.equal(exchange.authMethod, 'client_secret_basic')
    assert.equal(exchange.params.client_id, undefined)
    assert.equal(credentials.records.get(KEY).payload.client.clientSecret, 's3cret value')
    assert.equal((await host.error('mcp-auth-start', { server: SERVER, url: env.mcpUrl, clientSecret: 'x' })).code, 'bad-request')
  })

  it('reports an authorization error from the redirect and replaces older flows', async (t) => {
    const { env, host } = await setup(t, { as: { approval: 'page' } })
    const first = await host.value('mcp-auth-start', { server: SERVER, url: env.mcpUrl })
    const second = await host.value('mcp-auth-start', { server: SERVER, url: env.mcpUrl })
    assert.notEqual(first.flowId, second.flowId)
    assert.equal((await serverState(host)).flow.flowId, second.flowId)
    assert.equal((await host.error('mcp-auth-complete', { flowId: first.flowId, callbackUrl: first.redirectUri })).code, 'not-found')

    const consent = await fetch(second.authUrl)
    assert.match(await consent.text(), /Approve/)
    const requestId = env.as.state.pending.keys().next().value
    const denied = await fetch(`${env.base}/as/decide?request=${requestId}&decision=deny`, { redirect: 'manual' })
    const page = await fetch(denied.headers.get('location'))
    assert.equal(page.status, 400)
    assert.match(await page.text(), /授权失败.*access_denied/s)
    const flow = (await serverState(host)).flow
    assert.equal(flow.status, 'error')
    assert.match(flow.error, /access_denied/)
  })

  it('cancels a flow and closes its listener', async (t) => {
    const { env, host } = await setup(t)
    const started = await host.value('mcp-auth-start', { server: SERVER, url: env.mcpUrl })
    assert.deepEqual(await host.value('mcp-auth-cancel', { flowId: started.flowId }), { ok: true })
    assert.equal((await serverState(host)).flow.status, 'cancelled')
    await assert.rejects(fetch(started.redirectUri))
    assert.deepEqual(await host.value('mcp-auth-cancel', { flowId: 'unknown' }), { ok: true })
  })

  it('closes callback listeners when the plugin is disposed', async (t) => {
    const { env, host } = await setup(t)
    const started = await host.value('mcp-auth-start', { server: SERVER, url: env.mcpUrl })
    assert.equal((await fetch(`${started.redirectUri}?state=x`)).status, 400)
    await host.dispose()
    await assert.rejects(fetch(started.redirectUri))
    assert.equal((await host.error('mcp-auth-start', { server: SERVER, url: env.mcpUrl })).code, 'unavailable')
  })

  it('needs the credential store and a valid server name', async (t) => {
    const { env, host } = await setup(t, { services: { credentials: null } })
    assert.equal((await host.error('mcp-auth-start', { server: SERVER, url: env.mcpUrl })).code, 'unavailable')
    assert.equal((await host.error('mcp-auth-forget', { server: SERVER })).code, 'unavailable')
    const other = createMcpHost({ services: { credentials: fakeCredentials() } })
    t.after(() => other.dispose())
    assert.equal((await other.error('mcp-auth-start', { server: 'bad name', url: env.mcpUrl })).code, 'bad-request')
    assert.equal((await other.error('mcp-auth-start', { server: SERVER, url: 'http://example.com/mcp' })).code, 'bad-request')
  })
})

describe('token refresh', () => {
  const fast = { refreshLeadMs: 900, minRefreshDelayMs: 50, refreshRetryMs: 100 }

  it('refreshes before expiry and stores a rotated refresh token', async (t) => {
    const { env, host, credentials } = await setup(t, { as: { expiresIn: 1 }, timing: { oauthTiming: fast } })
    await authorize(env, host)
    const before = credentials.records.get(KEY).payload.tokens.refreshToken
    const firstAccess = credentials.refs.get(REF)
    env.as.options.expiresIn = 3600
    await eventually(() => env.as.state.log.some(entry => entry.grantType === 'refresh_token'), 3000, 'a refresh')
    await eventually(() => credentials.refs.get(REF) !== firstAccess, 3000, 'the new access token')
    const refresh = env.as.state.log.find(entry => entry.grantType === 'refresh_token')
    assert.equal(refresh.params.refresh_token, before)
    assert.equal(refresh.params.resource, env.mcpUrl)
    const tokens = credentials.records.get(KEY).payload.tokens
    assert.notEqual(tokens.refreshToken, before)
    assert.ok(env.as.state.refresh.has(tokens.refreshToken))
    assert.ok(!env.as.state.refresh.has(before))
    assert.ok(tokens.expiresAt > Date.now() + 3500_000)
    assert.ok(env.as.verify(`Bearer ${credentials.refs.get(REF)}`))
    const auth = (await serverState(host)).auth
    assert.equal(auth.state, 'authorized')
    assert.equal(auth.error, undefined)
  })

  it('marks the grant expired on invalid_grant and removes the token at expiry', async (t) => {
    const { env, host, credentials } = await setup(t, { as: { expiresIn: 1 }, timing: { oauthTiming: fast } })
    await authorize(env, host)
    env.as.state.rejectRefresh = true
    await eventually(async () => (await serverState(host))?.auth?.state === 'expired', 3000, 'expired state')
    const auth = (await serverState(host)).auth
    assert.equal(auth.canRefresh, false)
    assert.match(auth.error, /invalid_grant/)
    assert.equal(credentials.records.get(KEY).payload.tokens.refreshToken, undefined)
    assert.ok(credentials.refs.has(REF), 'the access token stays until it expires')
    await eventually(() => !credentials.refs.has(REF), 3000, 'unset at expiry')
    assert.equal(env.as.state.log.filter(entry => entry.grantType === 'refresh_token').length, 1)
  })

  it('retries transient refresh failures', async (t) => {
    const { env, host, credentials } = await setup(t, { as: { expiresIn: 1 }, timing: { oauthTiming: { ...fast, refreshRetryMs: 50 } } })
    await authorize(env, host)
    const firstAccess = credentials.refs.get(REF)
    env.as.state.unavailable = true
    await eventually(async () => /retrying/.test((await serverState(host))?.auth?.error ?? ''), 3000, 'a transient error')
    assert.equal((await serverState(host)).auth.state, 'authorized')
    env.as.options.expiresIn = 3600
    env.as.state.unavailable = false
    await eventually(() => credentials.refs.get(REF) !== undefined && credentials.refs.get(REF) !== firstAccess, 3000, 'a successful retry')
    await eventually(async () => (await serverState(host)).auth.error === undefined, 3000, 'the error to clear')
  })

  it('loads stored grants at start and expires a grant without a refresh token', async (t) => {
    const { env, host, credentials } = await setup(t, { as: { expiresIn: 3600 } })
    await authorize(env, host)
    await host.dispose()
    credentials.records.set('mcp-skills/oauth-other', {
      kind: 'grant',
      payload: { ...structuredClone(credentials.records.get(KEY).payload), server: 'other', tokens: { expiresAt: Date.now() - 1000 } },
    })
    credentials.refs.set('MCP_OTHER_OAUTH', 'stale')
    credentials.records.set('someone-else/key', { kind: 'grant', payload: {} })
    const restarted = createMcpHost({ services: { credentials } })
    t.after(() => restarted.dispose())
    await eventually(async () => Object.keys((await restarted.value('mcp-state', {})).servers).length === 2, 3000, 'loaded grants')
    const { servers } = await restarted.value('mcp-state', {})
    assert.equal(servers[SERVER].auth.state, 'authorized')
    assert.equal(servers.other.auth.state, 'expired')
    await eventually(() => !credentials.refs.has('MCP_OTHER_OAUTH'), 3000, 'the expired token to be removed')
  })

  it('refreshes after an authorization failure instead of reconnecting', async (t) => {
    const manager = fakeManager([SERVER])
    const { env, host, credentials } = await setup(t, { services: { mcpManager: manager } })
    await authorize(env, host)
    const firstAccess = credentials.refs.get(REF)
    host.emit('mcp-manager/status', SERVER, { state: 'connected', toolCount: 1, connectedAt: Date.now() })
    host.emit('mcp-manager/status', SERVER, { state: 'failed', reason: 'reconnect-disabled', lastError: 'Error POSTing to endpoint (HTTP 401): invalid_token' })
    await eventually(() => credentials.refs.get(REF) !== firstAccess, 3000, 'a refreshed token')
    const state = await serverState(host)
    assert.match(state.authFailure.lastError, /401/)
    assert.equal(state.retry, undefined)
    assert.deepEqual(manager.restarts, [])
    // A second failure within a minute does not refresh again; the grant is marked expired.
    host.emit('mcp-manager/status', SERVER, { state: 'failed', reason: 'reconnect-disabled', lastError: 'Unauthorized' })
    await eventually(async () => (await serverState(host)).auth.state === 'expired', 3000, 'expired state')
    assert.equal(env.as.state.log.filter(entry => entry.grantType === 'refresh_token').length, 1)
  })
})

describe('mcp-auth-forget', () => {
  it('revokes the refresh token, deletes the grant, and removes the token', async (t) => {
    const { env, host, credentials } = await setup(t)
    await authorize(env, host)
    const { refreshToken } = credentials.records.get(KEY).payload.tokens
    const { clientId } = credentials.records.get(KEY).payload.client
    assert.deepEqual(await host.value('mcp-auth-forget', { server: SERVER }), { ok: true })
    assert.deepEqual(env.as.state.revoked, [{ token: refreshToken, hint: 'refresh_token', clientId }])
    assert.equal(credentials.records.has(KEY), false)
    assert.equal(credentials.refs.has(REF), false)
    assert.deepEqual(credentials.calls.filter(call => call[0] === 'deleteRecord' || call[0] === 'unset'), [['deleteRecord', KEY], ['unset', REF]])
    assert.equal((await serverState(host))?.auth, undefined)
    assert.deepEqual(await host.value('mcp-auth-forget', { server: SERVER }), { ok: true })
  })
})
