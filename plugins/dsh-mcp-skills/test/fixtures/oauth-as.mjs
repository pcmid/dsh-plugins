/**
 * A small OAuth 2.1 authorization server for MCP authorization tests and the live fixture: RFC 9728
 * protected resource metadata, RFC 8414 metadata, RFC 7591 registration, authorization code + PKCE S256,
 * refresh with rotation, RFC 7009 revocation, and RFC 8707 resource checks. Node built-ins only.
 *
 * `createAuthorizationServer(options).handle(request, response, url)` answers the OAuth paths and returns
 * `false` for any other path, so a caller can serve its protected MCP endpoint on the same origin.
 */

import { createHash, randomBytes } from 'node:crypto'

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  response.end(JSON.stringify(body))
}

function token(prefix) {
  return `${prefix}_${randomBytes(18).toString('base64url')}`
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

/**
 * @param {object} [options]
 * @param {string} [options.issuerPath] - issuer path below the origin (`''` = the origin itself). Default `/as`.
 * @param {boolean} [options.metadata] - serve any metadata at all. Default true.
 * @param {boolean} [options.protectedResource] - serve RFC 9728 metadata and name it in the challenge. Default true.
 * @param {boolean} [options.registration] - offer dynamic client registration. Default true.
 * @param {boolean} [options.revocation] - offer a revocation endpoint. Default true.
 * @param {string[] | null} [options.pkceMethods] - `code_challenge_methods_supported`; null omits it. Default `['S256']`.
 * @param {string[]} [options.scopes] - `scopes_supported` of the resource.
 * @param {string} [options.challengeScope] - `scope` in the `WWW-Authenticate` challenge.
 * @param {number | undefined} [options.expiresIn] - access token lifetime in seconds; undefined omits `expires_in`.
 * @param {boolean} [options.issueRefreshTokens] - default true.
 * @param {boolean} [options.rotateRefreshTokens] - default true.
 * @param {'auto' | 'page'} [options.approval] - redirect at once, or show an Approve page. Default `auto`.
 * @param {{ clientId: string, clientSecret?: string }[]} [options.staticClients] - pre-registered clients;
 *   they accept any `http://localhost:<port>/callback` redirect.
 */
export function createAuthorizationServer(options = {}) {
  const o = {
    issuerPath: '/as',
    metadata: true,
    protectedResource: true,
    registration: true,
    revocation: true,
    pkceMethods: ['S256'],
    scopes: ['mcp:read', 'mcp:write'],
    challengeScope: undefined,
    expiresIn: 3600,
    issueRefreshTokens: true,
    rotateRefreshTokens: true,
    approval: 'auto',
    staticClients: [],
    ...options,
  }
  const state = {
    base: '',
    clients: new Map(o.staticClients.map(client => [client.clientId, { ...client, static: true, redirectUris: [] }])),
    pending: new Map(),
    codes: new Map(),
    access: new Map(),
    refresh: new Map(),
    log: [],
    revoked: [],
    registrations: [],
    authorizations: [],
    /** Set to make refresh grants fail with `invalid_grant`. */
    rejectRefresh: false,
    /** Set to make the token endpoint answer 503. */
    unavailable: false,
  }
  const issuer = () => `${state.base}${o.issuerPath}`
  const resource = () => `${state.base}/mcp`
  const prmUrl = () => `${state.base}/.well-known/oauth-protected-resource/mcp`

  function redirectAllowed(client, uri) {
    if (client.static) return /^http:\/\/localhost:\d+\/callback$/.test(uri)
    return client.redirectUris.includes(uri)
  }

  function clientAuth(request, params) {
    const header = request.headers.authorization
    if (typeof header === 'string' && header.startsWith('Basic ')) {
      const [id, secret] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':').map(part => decodeURIComponent(part.replace(/\+/g, ' ')))
      return { clientId: id, clientSecret: secret, method: 'client_secret_basic' }
    }
    const clientId = params.get('client_id') ?? undefined
    const clientSecret = params.get('client_secret') ?? undefined
    return { clientId, clientSecret, method: clientSecret === undefined ? 'none' : 'client_secret_post' }
  }

  function authenticate(request, params) {
    const auth = clientAuth(request, params)
    const client = auth.clientId === undefined ? undefined : state.clients.get(auth.clientId)
    if (client === undefined) return { error: 'invalid_client' }
    if (client.clientSecret !== undefined && client.clientSecret !== auth.clientSecret) return { error: 'invalid_client' }
    return { client, method: auth.method }
  }

  function issue(clientId, scope, previousRefresh) {
    const accessToken = token('at')
    const expiresAt = o.expiresIn === undefined ? undefined : Date.now() + o.expiresIn * 1000
    state.access.set(accessToken, { clientId, scope, expiresAt })
    const body = { access_token: accessToken, token_type: 'Bearer', ...(o.expiresIn === undefined ? {} : { expires_in: o.expiresIn }), ...(scope ? { scope } : {}) }
    if (o.issueRefreshTokens) {
      if (previousRefresh !== undefined && !o.rotateRefreshTokens) {
        body.refresh_token = previousRefresh
      } else {
        if (previousRefresh !== undefined) state.refresh.delete(previousRefresh)
        const refreshToken = token('rt')
        state.refresh.set(refreshToken, { clientId, scope })
        body.refresh_token = refreshToken
      }
    }
    return body
  }

  function finishAuthorization(pending, approved) {
    const target = new URL(pending.redirectUri)
    if (approved) {
      const code = token('code')
      state.codes.set(code, pending)
      target.searchParams.set('code', code)
    } else {
      target.searchParams.set('error', 'access_denied')
      target.searchParams.set('error_description', 'The user denied the request')
    }
    target.searchParams.set('state', pending.state)
    return target.href
  }

  async function handle(request, response, url) {
    const path = url.pathname
    if (o.metadata && o.protectedResource && request.method === 'GET'
      && (path === '/.well-known/oauth-protected-resource/mcp' || path === '/.well-known/oauth-protected-resource')) {
      json(response, 200, { resource: resource(), authorization_servers: [issuer()], scopes_supported: o.scopes, bearer_methods_supported: ['header'] })
      return true
    }
    if (o.metadata && request.method === 'GET' && path === `/.well-known/oauth-authorization-server${o.issuerPath}`) {
      json(response, 200, {
        issuer: issuer(),
        authorization_endpoint: `${issuer()}/authorize`,
        token_endpoint: `${issuer()}/token`,
        ...(o.registration ? { registration_endpoint: `${issuer()}/register` } : {}),
        ...(o.revocation ? { revocation_endpoint: `${issuer()}/revoke` } : {}),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        ...(o.pkceMethods === null ? {} : { code_challenge_methods_supported: o.pkceMethods }),
        token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
        scopes_supported: o.scopes,
      })
      return true
    }
    if (!path.startsWith(`${o.issuerPath}/`)) return false
    const action = path.slice(o.issuerPath.length + 1)

    if (action === 'register' && request.method === 'POST' && o.registration) {
      const body = JSON.parse(await readBody(request) || '{}')
      state.registrations.push(body)
      if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
        json(response, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' })
        return true
      }
      const clientId = token('client')
      state.clients.set(clientId, { clientId, redirectUris: body.redirect_uris, static: false })
      json(response, 201, {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: body.client_name,
        redirect_uris: body.redirect_uris,
        grant_types: body.grant_types,
        response_types: body.response_types,
        token_endpoint_auth_method: 'none',
      })
      return true
    }

    if (action === 'authorize' && request.method === 'GET') {
      const params = url.searchParams
      state.authorizations.push(Object.fromEntries(params))
      const client = state.clients.get(params.get('client_id') ?? '')
      const redirectUri = params.get('redirect_uri') ?? ''
      const problem = client === undefined ? 'unknown client_id'
        : !redirectAllowed(client, redirectUri) ? 'redirect_uri is not registered for this client'
          : params.get('response_type') !== 'code' ? 'response_type must be code'
            : params.get('code_challenge_method') !== 'S256' || !params.get('code_challenge') ? 'PKCE S256 is required'
              : !params.get('state') ? 'state is required'
                : params.get('resource') !== resource() ? `resource must be ${resource()}`
                  : undefined
      if (problem !== undefined) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        response.end(`Invalid authorization request: ${problem}`)
        return true
      }
      const pending = {
        id: token('req'),
        clientId: client.clientId,
        redirectUri,
        challenge: params.get('code_challenge'),
        state: params.get('state'),
        scope: params.get('scope') ?? '',
        resource: params.get('resource'),
      }
      if (o.approval === 'auto') {
        response.writeHead(302, { location: finishAuthorization(pending, true) })
        response.end()
        return true
      }
      state.pending.set(pending.id, pending)
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Authorize</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:30rem;margin:12vh auto;padding:0 1.5rem}button{font:inherit;padding:.4rem 1.2rem;margin-right:.5rem}</style></head>
<body><h1>Authorize DeepSeek Harness?</h1>
<p>Client <code>${escapeHtml(client.clientId)}</code> asks for <code>${escapeHtml(pending.scope || '(no scope)')}</code> on <code>${escapeHtml(pending.resource)}</code>.</p>
<form method="get" action="${escapeHtml(`${o.issuerPath}/decide`)}"><input type="hidden" name="request" value="${escapeHtml(pending.id)}">
<button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form></body></html>`)
      return true
    }

    if (action === 'decide' && request.method === 'GET') {
      const pending = state.pending.get(url.searchParams.get('request') ?? '')
      if (pending === undefined) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('This authorization request is unknown or already used.')
        return true
      }
      state.pending.delete(pending.id)
      response.writeHead(302, { location: finishAuthorization(pending, url.searchParams.get('decision') === 'approve') })
      response.end()
      return true
    }

    if (action === 'token' && request.method === 'POST') {
      const params = new URLSearchParams(await readBody(request))
      const auth = clientAuth(request, params)
      state.log.push({ grantType: params.get('grant_type'), params: Object.fromEntries(params), authMethod: auth.method })
      if (state.unavailable) {
        json(response, 503, { error: 'temporarily_unavailable' })
        return true
      }
      const authenticated = authenticate(request, params)
      if (authenticated.error !== undefined) {
        json(response, 401, { error: authenticated.error })
        return true
      }
      const clientId = authenticated.client.clientId
      if (params.get('grant_type') === 'authorization_code') {
        const code = params.get('code') ?? ''
        const pending = state.codes.get(code)
        state.codes.delete(code)
        const verifier = params.get('code_verifier') ?? ''
        const problem = pending === undefined ? 'unknown or used code'
          : pending.clientId !== clientId ? 'code was issued to another client'
            : pending.redirectUri !== params.get('redirect_uri') ? 'redirect_uri differs'
              : createHash('sha256').update(verifier).digest('base64url') !== pending.challenge ? 'PKCE verification failed'
                : params.get('resource') !== pending.resource ? 'resource differs'
                  : undefined
        if (problem !== undefined) {
          json(response, 400, { error: 'invalid_grant', error_description: problem })
          return true
        }
        json(response, 200, issue(clientId, pending.scope))
        return true
      }
      if (params.get('grant_type') === 'refresh_token') {
        const refreshToken = params.get('refresh_token') ?? ''
        const grant = state.refresh.get(refreshToken)
        if (state.rejectRefresh || grant === undefined || grant.clientId !== clientId) {
          json(response, 400, { error: 'invalid_grant', error_description: 'refresh token is invalid' })
          return true
        }
        json(response, 200, issue(clientId, grant.scope, refreshToken))
        return true
      }
      json(response, 400, { error: 'unsupported_grant_type' })
      return true
    }

    if (action === 'revoke' && request.method === 'POST' && o.revocation) {
      const params = new URLSearchParams(await readBody(request))
      state.revoked.push({ token: params.get('token'), hint: params.get('token_type_hint'), clientId: clientAuth(request, params).clientId })
      state.refresh.delete(params.get('token') ?? '')
      state.access.delete(params.get('token') ?? '')
      response.writeHead(200)
      response.end()
      return true
    }
    return false
  }

  return {
    options: o,
    state,
    /** @param {string} base - origin the server is reachable at, such as `http://127.0.0.1:47301`. */
    setBase(base) {
      state.base = base
    },
    issuer,
    resource,
    /** @returns {string} the `WWW-Authenticate` value for a request without a valid token. */
    challenge() {
      const params = [`realm="mcp"`]
      if (o.metadata && o.protectedResource) params.push(`resource_metadata="${prmUrl()}"`)
      if (o.challengeScope !== undefined) params.push(`scope="${o.challengeScope}"`)
      return `Bearer ${params.join(', ')}`
    },
    /**
     * @param {string | undefined} header - `Authorization` request header.
     * @returns {{ clientId: string, scope: string } | undefined} the token grant, when valid.
     */
    verify(header) {
      if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined
      const grant = state.access.get(header.slice(7))
      if (grant === undefined || (grant.expiresAt !== undefined && grant.expiresAt <= Date.now())) return undefined
      return grant
    },
    handle,
  }
}
