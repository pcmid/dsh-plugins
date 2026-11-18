/**
 * Host half of @pcmid/dsh-worktree-repos: a new session in a workspace that is
 * not a Git checkout can move into one of the Git repositories directly under
 * that workspace, so Harness's worktree option can cut a worktree from it.
 *
 * The workspaces with scanning turned on are this row's volatile Config,
 * toggled from the workspace menu in the browser half. Three owner-only
 * routes under `/api/pcmid/worktree-repos/` serve the browser half:
 *
 * - `probe` tells the workspace menu whether a workspace is a Git checkout;
 *   the menu offers scanning only outside one.
 * - `repositories` lists the repositories a new session may move into.
 * - `choose` moves the session's working directory into one of them, or back
 *   to the workspace, as Agent maintenance. An open worktree request is
 *   withdrawn first, because its base branch belongs to the previous
 *   directory; the answer says whether one was.
 *
 * @module @pcmid/dsh-worktree-repos
 */
import z from '@deepseek-ai/schemastery'
import { HostError, createOperations } from './repos.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'worktree-repos'

/** Route registration, live Agents, and Session working directories. */
export const inject = ['connection', 'agents', 'workingDirectory']

/** Route prefix of the browser half's API. */
const API = '/api/pcmid/worktree-repos'

/** The list is volatile: a toggle applies to the next look at the new-session row without a reload. */
export const Config = z.object({
  workspaces: z.array(z.string()).default([]).volatile()
    .description('Workspace directories with scanning on. A new session in a listed workspace that is not itself a Git checkout can move into a Git repository among its first-level subdirectories.'),
})

/**
 * Read a Config field that may be volatile.
 * @param {unknown} value - a plain value, or a volatile reference exposing `get()`.
 * @returns {unknown} the current value.
 */
function current(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

/**
 * Register the routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ workspaces: unknown }} config - row Config.
 */
export function apply(ctx, config) {
  const operations = createOperations({
    workspaces: () => current(config.workspaces),
    agentOf: sessionId => ctx.agents.get(sessionId),
    // The predicate Harness uses before reusing a blank Session.
    started: (session) => {
      const boundary = ctx.agents.turnBoundaryOf(session)
      return boundary.openTurnStartSeq !== null || boundary.lastTurn !== 0
    },
    cwdOf: session => ctx.workingDirectory.get(session),
    changeDirectory: async (agent, path, signal) => {
      // The request's base branch was picked in the previous directory. Withdrawing
      // an open request appends a record; without one, nothing is written.
      const before = agent.session.seq
      await ctx.get('forgePanel')?.cancelWorktree(agent.session, signal)
      const withdrawn = agent.session.seq !== before
      let running
      try {
        running = agent.runMaintenance(async (work) => {
          await ctx.workingDirectory.set(agent, path, AbortSignal.any([signal, work]))
        })
      } catch {
        // A running turn or other maintenance owns the Agent.
        throw new HostError('busy', 'The session is busy. Try again in a moment.')
      }
      await running
      return withdrawn
    },
  })
  for (const [operation, handle] of Object.entries(operations)) registerOperation(ctx, operation, handle)
}

/**
 * Register one exact POST route that speaks the Connection RPC envelope.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context owning the route.
 * @param {string} operation - operation name under {@link API}.
 * @param {(payload: object, signal: AbortSignal) => Promise<unknown>} handle - operation body.
 */
function registerOperation(ctx, operation, handle) {
  ctx.connection.fetch.register({
    path: `${API}/${operation}`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let envelope
      try {
        envelope = await request.json()
      } catch {
        // A body that is not JSON carries no rpcId to answer.
        return new Response('body is not JSON', { status: 400 })
      }
      const rpcId = typeof envelope?.rpcId === 'string' ? envelope.rpcId : 'invalid-request'
      let result
      try {
        const payload = envelope?.payload
        if (envelope?.type !== 'client-request' || typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          throw new HostError('bad-request', 'Expected a client-request envelope with an object payload')
        }
        result = { ok: true, value: await handle(payload, request.signal ?? new AbortController().signal) }
      } catch (error) {
        const code = error instanceof HostError ? error.code : 'internal'
        result = { ok: false, error: { code, message: error?.message ?? String(error), details: {} } }
      }
      return Response.json({ type: 'server-response', rpcId, result })
    },
  })
}
