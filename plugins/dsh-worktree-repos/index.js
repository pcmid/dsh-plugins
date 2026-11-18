/**
 * Host half of @pcmid/dsh-worktree-repos: a new session in a workspace that is
 * not a Git checkout can move into one of the Git repositories under that
 * workspace, so Harness's worktree option can cut a worktree from it.
 *
 * How many directory levels are searched is this row's volatile `depth`
 * Config. Two owner-only routes under `/api/pcmid/worktree-repos/` serve the
 * browser half:
 *
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

/** The depth is volatile: a saved change applies to the next look at the new-session row without a reload. */
export const Config = z.object({
  depth: z.natural().min(1).default(1).volatile()
    .description('How many directory levels under the workspace are searched for Git repositories. 1 searches only its direct subdirectories.'),
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
 * @param {{ depth: unknown }} config - row Config.
 */
export function apply(ctx, config) {
  const operations = createOperations({
    depth: () => current(config.depth),
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
