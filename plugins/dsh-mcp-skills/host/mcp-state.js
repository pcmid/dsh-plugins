/**
 * `mcp-state` (docs/auth-retry.md §3): a version counter and long-poll waiters over the supervisor and
 * OAuth state.
 */

import { HostError } from './errors.js'

/** Version counter that wakes long-poll requests when any part of the MCP state changes. */
export class McpStateHub {
  #waiters = new Set()
  #timeoutMs
  version = 1

  /** @param {{ timeoutMs?: number }} [options] - long-poll limit; 20 s by contract. */
  constructor({ timeoutMs = 20_000 } = {}) {
    this.#timeoutMs = timeoutMs
  }

  /** Record a change and wake every waiter. */
  bump() {
    this.version++
    this.#release()
  }

  /**
   * Wait while `since` equals the current version, for at most the long-poll limit.
   * @param {unknown} since - payload `since`; `undefined` returns at once.
   * @param {AbortSignal} [signal] - ends the wait early (request closed).
   */
  async wait(since, signal) {
    if (since === undefined || since === null) return
    if (typeof since !== 'number' || !Number.isFinite(since)) throw new HostError('bad-request', 'Field "since" must be a version number')
    if (since !== this.version || signal?.aborted) return
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        this.#waiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, this.#timeoutMs)
      timer.unref?.()
      signal?.addEventListener('abort', done, { once: true })
      this.#waiters.add(done)
    })
  }

  /** Release every waiter (plugin disposal). */
  dispose() {
    this.#release()
  }

  #release() {
    for (const done of [...this.#waiters]) done()
  }
}

/**
 * Build the `mcp-state` value.
 * @param {number} version - current version.
 * @param {import('./supervisor.js').ReconnectSupervisor} supervisor - reconnect state.
 * @param {import('./oauth.js').OAuthManager} oauth - authorization and flow state.
 * @returns {{ version: number, servers: Record<string, object> }} only servers with some state.
 */
export function mcpStateSnapshot(version, supervisor, oauth) {
  const servers = {}
  for (const name of new Set([...supervisor.names(), ...oauth.servers()])) {
    const state = { ...supervisor.view(name), ...oauth.view(name) }
    if (state.armed || Object.keys(state).length > 1) servers[name] = state
  }
  return { version, servers }
}
