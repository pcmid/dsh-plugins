/**
 * MCP authorization discovery: protected resource metadata (RFC 9728), then authorization server
 * metadata (RFC 8414 / OpenID Connect Discovery), with the 2025-03-26 fallback that treats the MCP
 * server's origin as the issuer.
 */

import { HostError, errorMessage } from './errors.js'
import { checkRemoteUrl, httpRequest, normalizeResource, parseJsonObject } from './oauth-http.js'

function stripSlash(pathname) {
  return pathname.replace(/\/+$/, '')
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/** GET a JSON object, or `undefined` when the document is absent or not JSON. Network errors propagate. */
async function getJson(url) {
  const response = await httpRequest(url, { headers: { accept: 'application/json' } })
  if (response.status < 200 || response.status >= 300) return undefined
  return parseJsonObject(response.body)
}

function optionalUrl(value) {
  if (typeof value !== 'string') return undefined
  try {
    return checkRemoteUrl(value, 'endpoint').href
  } catch {
    // An unusable optional endpoint is treated as absent.
    return undefined
  }
}

/** Read protected resource metadata; `undefined` when none of the candidate documents is usable. */
async function protectedResource(serverUrl, challenge) {
  const candidates = []
  if (challenge?.resource_metadata !== undefined) {
    candidates.push(checkRemoteUrl(new URL(challenge.resource_metadata, serverUrl).href, 'resource_metadata'))
  } else {
    const path = stripSlash(serverUrl.pathname)
    if (path !== '') candidates.push(new URL(`/.well-known/oauth-protected-resource${path}`, serverUrl.origin))
    candidates.push(new URL('/.well-known/oauth-protected-resource', serverUrl.origin))
  }
  for (const url of candidates) {
    const document = await getJson(url)
    if (document === undefined || !isStringArray(document.authorization_servers) || document.authorization_servers.length === 0) continue
    let resource = normalizeResource(serverUrl)
    if (typeof document.resource === 'string') {
      let declared
      try {
        declared = new URL(document.resource)
      } catch {
        // A malformed resource makes this document unusable.
        continue
      }
      // A document describing another origin's resource is not this server's.
      if (declared.origin !== serverUrl.origin) continue
      resource = normalizeResource(declared)
    }
    const issuer = checkRemoteUrl(document.authorization_servers[0], 'authorization server').href
    return {
      issuer,
      resource,
      ...(isStringArray(document.scopes_supported) && document.scopes_supported.length > 0 ? { scopes: document.scopes_supported } : {}),
    }
  }
  return undefined
}

/**
 * Read authorization server metadata for an issuer.
 * @param {string} issuer - issuer URL.
 * @returns {Promise<object | undefined>} validated metadata, or `undefined` when no document is found.
 * @throws {HostError} `oauth-failed` when the server does not support PKCE S256.
 */
export async function authorizationServer(issuer) {
  const url = new URL(issuer)
  const path = stripSlash(url.pathname)
  const candidates = path === ''
    ? [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`]
    : [
        `${url.origin}/.well-known/oauth-authorization-server${path}`,
        `${url.origin}/.well-known/openid-configuration${path}`,
        `${stripSlash(url.href.replace(/[?#].*$/, ''))}/.well-known/openid-configuration`,
      ]
  for (const candidate of candidates) {
    const document = await getJson(candidate)
    if (document === undefined || typeof document.authorization_endpoint !== 'string' || typeof document.token_endpoint !== 'string') continue
    const methods = document.code_challenge_methods_supported
    if (Array.isArray(methods) && !methods.includes('S256')) {
      throw new HostError('oauth-failed', `The authorization server ${url.host} does not support PKCE with S256, which MCP requires`)
    }
    return {
      authorization: checkRemoteUrl(document.authorization_endpoint, 'authorization_endpoint').href,
      token: checkRemoteUrl(document.token_endpoint, 'token_endpoint').href,
      ...(optionalUrl(document.registration_endpoint) === undefined ? {} : { registration: optionalUrl(document.registration_endpoint) }),
      ...(optionalUrl(document.revocation_endpoint) === undefined ? {} : { revocation: optionalUrl(document.revocation_endpoint) }),
      ...(isStringArray(document.token_endpoint_auth_methods_supported) ? { authMethods: document.token_endpoint_auth_methods_supported } : {}),
    }
  }
  return undefined
}

/**
 * Discover how to authorize against an MCP server.
 * @param {URL} serverUrl - checked MCP server URL.
 * @param {Record<string, string> | undefined} challenge - parsed `WWW-Authenticate: Bearer` parameters.
 * @returns {Promise<{ issuer: string, resource: string, scope?: string, endpoints: object } | undefined>}
 *   `undefined` when the server publishes no usable OAuth metadata. `scope` is the challenge's `scope`,
 *   else the resource's `scopes_supported` joined with spaces.
 * @throws {HostError} `oauth-failed` when a server is unreachable or its metadata is unusable.
 */
export async function discover(serverUrl, challenge) {
  try {
    const resource = await protectedResource(serverUrl, challenge)
    const issuer = resource?.issuer ?? serverUrl.origin
    const endpoints = await authorizationServer(issuer)
    if (endpoints === undefined) return undefined
    const scope = challenge?.scope?.trim() || resource?.scopes?.join(' ') || undefined
    return {
      issuer,
      resource: resource?.resource ?? normalizeResource(serverUrl),
      ...(scope === undefined ? {} : { scope }),
      endpoints,
    }
  } catch (error) {
    if (error instanceof HostError && error.code === 'oauth-failed') throw error
    throw new HostError('oauth-failed', `OAuth discovery for ${serverUrl.host} failed: ${errorMessage(error)}`)
  }
}
