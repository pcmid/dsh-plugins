// Test support for the MCP reconnect and OAuth operations: a fake Cordis context around `setupMcp`, a fake
// credential store, a fake MCP manager, and a loopback OAuth server with a protected `/mcp` endpoint.

import assert from 'node:assert/strict'
import http from 'node:http'
import { HostError, ok, toFailure } from '../host/errors.js'
import { setupMcp } from '../host/mcp-routes.js'
import { createAuthorizationServer } from './fixtures/oauth-as.mjs'

/** DSH's CredentialKey grammar: exactly `<scope>/<id>`, both lowercase hyphenated. */
const CREDENTIAL_KEY = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Apply the MCP half to a fake context.
 * @param {{ services?: object, config?: object, timing?: object }} [options] - `ctx.get` services, plugin
 *   Config, and shorter timings.
 */
export function createMcpHost({ services = {}, config, timing } = {}) {
  const listeners = new Map()
  const disposers = []
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    get: name => services[name],
    effect(effect) {
      disposers.push(effect())
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(listener)
      return () => listeners.get(event).delete(listener)
    },
    inject(deps, callback) {
      if (!deps.every(dep => services[dep] !== undefined)) return
      callback(Object.assign(Object.create(ctx), Object.fromEntries(deps.map(dep => [dep, services[dep]]))))
    },
  }
  const operations = setupMcp(ctx, config, timing)
  const host = {
    ctx,
    operations,
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    /** Run one operation and return its JSON round-tripped result envelope. */
    async call(operation, payload = {}, request = undefined) {
      let result
      try {
        if (typeof payload !== 'object' || payload === null) throw new HostError('bad-request', 'payload')
        result = ok(await operations[operation](payload, request))
      } catch (error) {
        result = toFailure(error)
      }
      return JSON.parse(JSON.stringify(result))
    },
    async value(operation, payload) {
      const result = await host.call(operation, payload)
      assert.equal(result.ok, true, `${operation} failed: ${JSON.stringify(result.error)}`)
      return result.value
    },
    async error(operation, payload) {
      const result = await host.call(operation, payload)
      assert.equal(result.ok, false, `${operation} unexpectedly succeeded: ${JSON.stringify(result.value)}`)
      return result.error
    },
    async dispose() {
      for (const dispose of disposers) await dispose?.()
    },
  }
  return host
}

/** A fake `ctx.credentials` that records calls (never values) and enforces DSH's key and ref grammars. */
export function fakeCredentials() {
  const records = new Map()
  const refs = new Map()
  const calls = []
  let queue = Promise.resolve()
  const clone = value => (value === undefined ? undefined : structuredClone(value))
  return {
    records,
    refs,
    calls,
    async readRecord(key) {
      calls.push(['readRecord', key])
      return clone(records.get(key))
    },
    async listRecords() {
      calls.push(['listRecords'])
      return [...records].map(([key, record]) => ({ key, kind: record.kind }))
    },
    modifyRecord(key, mutate) {
      assert.match(key, CREDENTIAL_KEY, `credential key ${key}`)
      const run = queue.then(async () => {
        const next = await mutate(clone(records.get(key)))
        calls.push(['modifyRecord', key, next === undefined ? 'kept' : 'written'])
        if (next !== undefined) {
          assert.equal(next.kind, 'grant')
          JSON.parse(JSON.stringify(next.payload))
          records.set(key, clone(next))
        }
        return clone(records.get(key))
      })
      queue = run.catch(() => {})
      return run
    },
    async deleteRecord(key) {
      calls.push(['deleteRecord', key])
      records.delete(key)
    },
    async set(ref, value) {
      assert.match(ref, CREDENTIAL_REF)
      assert.ok(typeof value === 'string' && value !== '')
      calls.push(['set', ref])
      refs.set(ref, value)
    },
    async unset(ref) {
      calls.push(['unset', ref])
      refs.delete(ref)
    },
  }
}

/**
 * A fake `ctx.mcpManager` whose server list the test controls.
 * @param {string[]} names - configured servers.
 */
export function fakeManager(names = []) {
  const manager = {
    servers: new Map(names.map(name => [name, { state: 'connecting', attempt: 0 }])),
    restarts: [],
    failRestart: undefined,
    list: () => [...manager.servers].map(([name, status]) => ({ name, configured: true, status })),
    async restart(name) {
      manager.restarts.push(name)
      if (manager.failRestart !== undefined) throw new Error(manager.failRestart)
      if (!manager.servers.has(name)) throw new Error(`no MCP server "${name}"`)
    },
  }
  return manager
}

/**
 * Start a loopback OAuth server with a protected MCP endpoint at `/mcp`.
 * @param {{ as?: object, mcp?: 'oauth' | 'none' | 'token' | 'forbidden' }} [options] - authorization
 *   server options, and how `/mcp` answers a request without a valid token.
 */
export async function startOAuthEnv({ as: asOptions = {}, mcp = 'oauth' } = {}) {
  const as = createAuthorizationServer(asOptions)
  const mcpLog = []
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, as.state.base)
    as.handle(request, response, url).then((handled) => {
      if (handled) return
      if (url.pathname !== '/mcp') {
        response.writeHead(404).end()
        return
      }
      request.resume()
      const authorization = request.headers.authorization
      mcpLog.push({ method: request.method, authorization, session: request.headers['mcp-session-id'] })
      if (request.method === 'DELETE') {
        response.writeHead(200).end()
        return
      }
      if (mcp === 'none' || as.verify(authorization) !== undefined) {
        response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } }))
        return
      }
      if (mcp === 'forbidden') {
        response.writeHead(403).end('forbidden')
        return
      }
      response.writeHead(401, { 'www-authenticate': as.challenge(), 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'invalid_token' }))
    }, (error) => {
      response.writeHead(500).end(String(error))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  as.setBase(base)
  return {
    as,
    base,
    mcpUrl: `${base}/mcp`,
    mcpLog,
    async close() {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

/** Poll `predicate` until it is truthy or `timeoutMs` passes. */
export async function eventually(predicate, timeoutMs = 3000, message = 'condition') {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${message}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
