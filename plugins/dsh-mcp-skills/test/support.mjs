// Test support: an isolated filesystem sandbox and a fake Cordis context that drives the real routes.

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const ENV_KEYS = ['DSH_HOME', 'DSH_AGENTS_HOME', 'TMPDIR']

/**
 * Create a unique temp directory and point DSH_HOME, DSH_AGENTS_HOME, and TMPDIR inside it.
 * @returns {Promise<{ base: string, dshHome: string, agentsHome: string, tmp: string, restore(): Promise<void> }>}
 */
export async function createSandbox() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-skills-test-')))
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  const sandbox = {
    base,
    dshHome: path.join(base, 'dsh-home'),
    agentsHome: path.join(base, 'agents-home'),
    tmp: path.join(base, 'tmp'),
  }
  await fs.mkdir(sandbox.tmp)
  process.env.DSH_HOME = sandbox.dshHome
  process.env.DSH_AGENTS_HOME = sandbox.agentsHome
  process.env.TMPDIR = sandbox.tmp
  sandbox.restore = async () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    await fs.rm(base, { recursive: true, force: true })
  }
  return sandbox
}

/** Write a file, creating parent directories. */
export async function put(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

/** A minimal valid SKILL.md. */
export function skillText(name, description = `${name} description`, extra = '') {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n`
}

/**
 * Apply the plugin to a fake context.
 * @param {Record<string, unknown>} services - values returned by `ctx.get(name)`; `ctx.inject` runs its
 *   callback at once when every named service is present.
 * @param {object} [config] - plugin Config.
 */
export function createHost(services = {}, config = undefined) {
  const routes = new Map()
  const disposers = []
  /** Messages passed to `ctx.logger.warn`. */
  const warnings = []
  const listeners = new Map()
  const ctx = {
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return async () => { routes.delete(route.path) }
        },
      },
    },
    logger: { warn(message) { warnings.push(String(message)) }, info() {}, error() {} },
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
  apply(ctx, config)
  let sequence = 0
  return {
    routes,
    warnings,
    /** Emit a Cordis event to the plugin's listeners. */
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    /** POST a raw body and return the Response. */
    async post(operation, body) {
      const route = routes.get(`/api/pcmid/${operation}`)
      assert.ok(route, `route ${operation} is registered`)
      return await route.fetch(new Request(`http://127.0.0.1/api/pcmid/${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }))
    },
    /** Call an operation through the RPC envelope and return `result`. */
    async call(operation, payload) {
      const rpcId = `rpc-${++sequence}`
      const response = await this.post(operation, JSON.stringify({ type: 'client-request', rpcId, payload }))
      assert.equal(response.status, 200)
      const envelope = await response.json()
      assert.equal(envelope.type, 'server-response')
      assert.equal(envelope.rpcId, rpcId)
      return envelope.result
    },
    /** Call an operation and return its value, failing on an error result. */
    async value(operation, payload) {
      const result = await this.call(operation, payload)
      assert.equal(result.ok, true, `${operation} failed: ${JSON.stringify(result.error)}`)
      return result.value
    },
    /** Call an operation and return its error, failing on success. */
    async error(operation, payload) {
      const result = await this.call(operation, payload)
      assert.equal(result.ok, false, `${operation} unexpectedly succeeded: ${JSON.stringify(result.value)}`)
      assert.deepEqual(result.error.details, {})
      return result.error
    },
    async dispose() {
      for (const dispose of disposers) await dispose?.()
    },
  }
}

/** A fake `ctx.skills` registry returning fixed winners. */
export function fakeSkills(summaries, { complete = true, contents = {} } = {}) {
  const calls = []
  return {
    calls,
    async snapshot(options) {
      calls.push({ method: 'snapshot', options })
      return { skills: summaries, complete }
    },
    async get(name, options) {
      calls.push({ method: 'get', name, options })
      return contents[name]
    },
  }
}

/** A fake `ctx.agentPresets` that hands out one scope lease per call and counts releases. */
export function fakePresets() {
  const presets = {
    keys: [],
    released: 0,
    async acquireScope(id) {
      assert.equal(id, undefined)
      const key = { preset: 'default' }
      presets.keys.push(key)
      return { key, [Symbol.asyncDispose]: async () => { presets.released++ } }
    },
  }
  return presets
}
