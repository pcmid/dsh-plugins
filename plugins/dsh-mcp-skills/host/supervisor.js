/**
 * Reconnect supervisor (docs/auth-retry.md §1).
 *
 * The Client writes `reconnect: { enabled: false }` into every server entry it saves, so mcp-client reports
 * both a failed first connection and a lost connection as `failed / reconnect-disabled` without retrying.
 * This supervisor restarts only servers that have connected at least once (`armed`), with exponential
 * backoff (1 s doubling to 30 s) for at most `maxAttempts` attempts. Authorization failures are not
 * retried; they go to {@link ReconnectSupervisor} `onAuthFailure` instead. Servers without the disabled
 * reconnect policy never report `reconnect-disabled`, so DSH's own retries stay untouched.
 */

import { HostError, errorMessage } from './errors.js'
import { isAuthError } from './oauth.js'

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

/** Restarts servers that lost an established connection. */
export class ReconnectSupervisor {
  #servers = new Map()
  #getManager
  #onChange
  #onAuthFailure
  #enabled
  #maxAttempts
  #baseDelayMs
  #maxDelayMs
  #disposed = false

  /**
   * @param {{ getManager: () => object | undefined, onChange?: () => void, onAuthFailure?: (name: string) => void,
   *   enabled?: boolean, maxAttempts?: number, baseDelayMs?: number, maxDelayMs?: number }} options -
   *   `getManager` returns the `mcpManager` service when present; `enabled: false` disables automatic
   *   restarts (authorization handling stays on).
   */
  constructor({ getManager, onChange = () => {}, onAuthFailure = () => {}, enabled = true, maxAttempts = 10, baseDelayMs = 1000, maxDelayMs = 30_000 }) {
    this.#getManager = getManager
    this.#onChange = onChange
    this.#onAuthFailure = onAuthFailure
    this.#enabled = enabled
    this.#maxAttempts = maxAttempts
    this.#baseDelayMs = baseDelayMs
    this.#maxDelayMs = maxDelayMs
  }

  /**
   * Arm servers that are already connected when the manager becomes available.
   * @param {{ name: string, status: { state: string } }[]} views - `mcpManager.list()`.
   */
  seed(views) {
    for (const view of views) {
      if (view?.status?.state === 'connected') this.#update(view.name, entry => this.#connected(entry))
    }
  }

  /**
   * Handle `mcp-manager/status`.
   * @param {string} name - server name.
   * @param {{ state: string, reason?: string, lastError?: string }} status - its new status.
   */
  onStatus(name, status) {
    if (this.#disposed || typeof name !== 'string') return
    switch (status?.state) {
      case 'connected':
        this.#update(name, entry => this.#connected(entry))
        return
      case 'disabled':
        this.#delete(name)
        return
      case 'failed':
        if (status.reason === 'reconnect-disabled') this.#failed(name, typeof status.lastError === 'string' ? status.lastError : '')
        return
      case 'connecting':
      case 'reconnecting':
      case 'waiting-credentials':
      case 'closed':
        // Something else started or stopped the instance; a pending restart would interrupt it.
        this.#update(name, (entry) => { this.#cancel(entry) }, false)
        return
      default:
    }
  }

  /**
   * `mcp-retry`: cancel automatic reconnects, disarm, and restart now.
   * @param {{ server?: unknown }} payload - `{ server }`.
   */
  async retry(payload) {
    const name = payload.server
    if (typeof name !== 'string' || !SERVER_NAME.test(name)) {
      throw new HostError('bad-request', `MCP server name ${JSON.stringify(name)} is invalid: use 1-32 letters, digits, "_", or "-"`)
    }
    const manager = this.#getManager()
    if (manager === undefined) throw new HostError('unavailable', 'The DSH MCP manager is not available')
    if (!manager.list().some(view => view.name === name)) throw new HostError('not-found', `There is no MCP server named "${name}"`)
    this.#update(name, (entry) => {
      this.#cancel(entry)
      entry.armed = false
      entry.attempts = 0
      entry.retry = undefined
      entry.gaveUp = undefined
    }, false)
    try {
      await manager.restart(name)
    } catch (error) {
      throw new HostError('internal', `Restarting "${name}" failed: ${errorMessage(error)}`)
    }
    return { ok: true }
  }

  /** Forget servers that no longer appear in `mcpManager.list()`. */
  prune() {
    const manager = this.#getManager()
    if (manager === undefined || this.#servers.size === 0) return
    const names = new Set(manager.list().map(view => view.name))
    for (const name of [...this.#servers.keys()]) if (!names.has(name)) this.#delete(name)
  }

  /** @returns {string[]} supervised server names. */
  names() {
    return [...this.#servers.keys()]
  }

  /**
   * @param {string} name - server name.
   * @returns {{ armed: boolean, retry?: object, gaveUp?: object, authFailure?: object }} §3 fields.
   */
  view(name) {
    const entry = this.#servers.get(name)
    if (entry === undefined) return { armed: false }
    return {
      armed: entry.armed,
      ...(entry.retry === undefined ? {} : { retry: { ...entry.retry } }),
      ...(entry.gaveUp === undefined ? {} : { gaveUp: { ...entry.gaveUp } }),
      ...(entry.authFailure === undefined ? {} : { authFailure: { ...entry.authFailure } }),
    }
  }

  /** Drop all state and timers (the manager went away). */
  reset() {
    const had = this.#servers.size > 0
    for (const entry of this.#servers.values()) this.#cancel(entry)
    this.#servers.clear()
    if (had && !this.#disposed) this.#onChange()
  }

  dispose() {
    this.#disposed = true
    for (const entry of this.#servers.values()) this.#cancel(entry)
    this.#servers.clear()
  }

  #connected(entry) {
    this.#cancel(entry)
    entry.armed = true
    entry.attempts = 0
    entry.retry = undefined
    entry.gaveUp = undefined
    entry.authFailure = undefined
  }

  #failed(name, lastError) {
    this.#update(name, (entry) => {
      this.#cancel(entry)
      entry.retry = undefined
      if (isAuthError(lastError)) {
        entry.authFailure = { lastError, at: Date.now() }
        this.#onAuthFailure(name)
        return
      }
      entry.authFailure = undefined
      if (!this.#enabled || !entry.armed) return
      if (entry.attempts >= this.#maxAttempts) {
        entry.gaveUp = { attempts: entry.attempts, ...(lastError === '' ? {} : { lastError }), at: Date.now() }
        entry.armed = false
        entry.attempts = 0
        return
      }
      entry.attempts++
      const delay = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** (entry.attempts - 1))
      entry.retry = { attempt: entry.attempts, max: this.#maxAttempts, nextAt: Date.now() + delay, ...(lastError === '' ? {} : { lastError }) }
      entry.timer = setTimeout(() => {
        entry.timer = undefined
        void this.#restart(name, entry)
      }, delay)
      entry.timer.unref?.()
    })
  }

  async #restart(name, entry) {
    if (this.#servers.get(name) !== entry || this.#disposed) return
    const manager = this.#getManager()
    if (manager === undefined) return
    if (!manager.list().some(view => view.name === name)) {
      this.#delete(name)
      return
    }
    try {
      await manager.restart(name)
    } catch (error) {
      if (this.#servers.get(name) !== entry || this.#disposed) return
      if (!manager.list().some(view => view.name === name)) {
        this.#delete(name)
        return
      }
      this.#failed(name, `Restart failed: ${errorMessage(error)}`)
    }
  }

  #cancel(entry) {
    clearTimeout(entry.timer)
    entry.timer = undefined
  }

  /** Apply `mutate` to a server's entry (created when `create`), notifying only when the view changed. */
  #update(name, mutate, create = true) {
    let entry = this.#servers.get(name)
    if (entry === undefined) {
      if (!create) return
      entry = { armed: false, attempts: 0 }
      this.#servers.set(name, entry)
    }
    const before = JSON.stringify(this.view(name))
    mutate(entry)
    if (!entry.armed && entry.retry === undefined && entry.gaveUp === undefined && entry.authFailure === undefined && entry.timer === undefined && entry.attempts === 0) {
      this.#servers.delete(name)
    }
    if (JSON.stringify(this.view(name)) !== before) this.#onChange()
  }

  #delete(name) {
    const entry = this.#servers.get(name)
    if (entry === undefined) return
    this.#cancel(entry)
    this.#servers.delete(name)
    this.#onChange()
  }
}
