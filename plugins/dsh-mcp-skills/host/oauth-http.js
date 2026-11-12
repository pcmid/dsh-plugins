/**
 * Bounded HTTP for OAuth discovery and token requests, and the URL rules they share.
 *
 * Every request has a 10 second budget (headers and body together), reads at most 1 MiB of body, and
 * follows at most 3 redirects that keep the original scheme. URLs must be `https:`, or `http:` on a
 * loopback host.
 */

import { HostError, errorMessage } from './errors.js'

export const REQUEST_TIMEOUT_MS = 10_000
export const MAX_BODY_BYTES = 1 << 20
const MAX_REDIRECTS = 3
const REDIRECTS = new Set([301, 302, 303, 307, 308])

/**
 * @param {string} hostname - `URL.hostname` (IPv6 in brackets).
 * @returns {boolean} whether the host is `localhost`, `127.0.0.0/8`, or `::1`.
 */
export function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

/**
 * Parse a URL that may be fetched or opened for OAuth.
 * @param {unknown} text - candidate URL.
 * @param {string} what - name used in the error message.
 * @returns {URL} the parsed URL.
 * @throws {HostError} `bad-request` unless it is `https:`, or `http:` on a loopback host, without user info.
 */
export function checkRemoteUrl(text, what) {
  let url
  try {
    url = new URL(String(text))
  } catch {
    // Reported below with the field name.
    url = undefined
  }
  if (url === undefined || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new HostError('bad-request', `${what} must be an http:// or https:// URL: ${String(text)}`)
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new HostError('bad-request', `${what} must use https:// (OAuth requires HTTPS except on localhost): ${url.href}`)
  }
  if (url.username !== '' || url.password !== '') throw new HostError('bad-request', `${what} must not contain a user name or password`)
  return url
}

/**
 * @param {URL | string} url - server URL.
 * @returns {string} the URL without its fragment, used as the RFC 8707 resource.
 */
export function normalizeResource(url) {
  const copy = new URL(String(url))
  copy.hash = ''
  return copy.href
}

/** Describe a fetch failure without leaking request contents. */
function networkMessage(url, error) {
  if (error?.name === 'TimeoutError') return `${url.host} did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds`
  const cause = error?.cause
  const detail = cause?.code ?? cause?.message ?? errorMessage(error)
  return `cannot reach ${url.host} (${detail})`
}

async function readLimited(response, url, maxBytes) {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error(`the response from ${url.host} is larger than ${maxBytes} bytes`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Send one request with the shared bounds.
 * @param {URL | string} target - absolute URL (already checked by the caller).
 * @param {{ method?: string, headers?: Record<string, string>, body?: string, readBody?: boolean,
 *   signal?: AbortSignal }} [options] - `readBody: false` cancels the body unread (for streams).
 * @returns {Promise<{ status: number, headers: Headers, url: URL, body: string }>} the final response.
 * @throws {Error} on network failure, timeout, an oversized body, or a disallowed redirect; the message
 *   names the host, never request contents.
 */
export async function httpRequest(target, options = {}) {
  let url = new URL(String(target))
  let method = options.method ?? 'GET'
  let body = options.body
  for (let hop = 0; ; hop++) {
    const signal = options.signal === undefined
      ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      : AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), options.signal])
    let response
    try {
      response = await fetch(url, { method, headers: options.headers, body, redirect: 'manual', signal })
    } catch (error) {
      throw new Error(networkMessage(url, error))
    }
    const location = response.headers.get('location')
    if (REDIRECTS.has(response.status) && location !== null) {
      await response.body?.cancel().catch(() => {})
      const next = new URL(location, url)
      if (hop >= MAX_REDIRECTS) throw new Error(`${url.host} redirected more than ${MAX_REDIRECTS} times`)
      if (next.protocol !== url.protocol) throw new Error(`${url.host} redirected to a different scheme (${next.protocol})`)
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET'
        body = undefined
      }
      url = next
      continue
    }
    if (options.readBody === false) {
      await response.body?.cancel().catch(() => {})
      return { status: response.status, headers: response.headers, url, body: '' }
    }
    try {
      return { status: response.status, headers: response.headers, url, body: await readLimited(response, url, MAX_BODY_BYTES) }
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Error(networkMessage(url, error))
      throw error
    }
  }
}

/**
 * @param {string} text - response body.
 * @returns {Record<string, unknown> | undefined} the JSON object, or `undefined` for anything else.
 */
export function parseJsonObject(text) {
  try {
    const value = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
  } catch {
    // Not JSON.
    return undefined
  }
}

const TOKEN = /[!#$%&'*+.^_`|~0-9A-Za-z-]/

/**
 * Parse the `Bearer` challenge of a `WWW-Authenticate` header (RFC 9110 §11.6.1).
 * @param {string | null} header - header value, possibly with several challenges.
 * @returns {Record<string, string> | undefined} lower-cased parameter names to values, or `undefined`
 *   without a Bearer challenge.
 */
export function parseBearerChallenge(header) {
  if (typeof header !== 'string') return undefined
  const challenges = []
  let current
  let i = 0
  const readToken = () => {
    const start = i
    while (i < header.length && TOKEN.test(header[i])) i++
    return header.slice(start, i)
  }
  while (i < header.length) {
    while (i < header.length && /[\s,]/.test(header[i])) i++
    const token = readToken()
    if (token === '') {
      i++
      continue
    }
    let j = i
    while (j < header.length && header[j] === ' ') j++
    if (header[j] === '=' && current !== undefined) {
      i = j + 1
      while (i < header.length && header[i] === ' ') i++
      let value = ''
      if (header[i] === '"') {
        i++
        while (i < header.length && header[i] !== '"') {
          if (header[i] === '\\' && i + 1 < header.length) i++
          value += header[i++]
        }
        i++
      } else {
        const start = i
        while (i < header.length && header[i] !== ',' && !/\s/.test(header[i])) i++
        value = header.slice(start, i)
      }
      current.params[token.toLowerCase()] = value
      continue
    }
    current = { scheme: token.toLowerCase(), params: {} }
    challenges.push(current)
  }
  return challenges.find(challenge => challenge.scheme === 'bearer')?.params
}
