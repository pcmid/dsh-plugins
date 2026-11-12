/**
 * Host half of the DSH MCP and skills settings bundle.
 *
 * Serves two independent APIs as exact Connection Fetch routes (reachable only by owner Peers) that speak
 * the Connection RPC envelope:
 *
 * - `POST /api/pcmid/mcp-settings/<operation>` — the MCP servers page (`tools`, `state`, `retry`, `auth-*`).
 * - `POST /api/pcmid/skill-settings/<operation>` — the Skills page (`list`, `read`, `save`, `delete`, `repos-*`).
 *
 * The Client half calls them with `ctx.connection.rpc.call('/api', 'pcmid/<group>/<operation>', payload)`.
 * Operations and payloads are specified in docs/host-api.md and docs/auth-retry.md. `skills`,
 * `agentPresets`, `tools`, `mcpManager`, and `credentials` are optional services read lazily.
 *
 * @module @pcmid/dsh-mcp-skills
 */

import { HostError, ok, toFailure } from './host/errors.js'
import { listMcpTools } from './host/mcp.js'
import { setupMcp } from './host/mcp-routes.js'
import { SerialQueue } from './host/paths.js'
import { RepoManager } from './host/repos.js'
import { SkillCatalog } from './host/skills.js'

/** Cordis plugin name. */
export const name = 'mcp-skills'
export const inject = ['connection']
export { Config } from './host/mcp-routes.js'

/** Route groups: the MCP page's API and the Skills page's API. */
const MCP_API = '/api/pcmid/mcp-settings'
const SKILL_API = '/api/pcmid/skill-settings'

/**
 * Register the Host API routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ reconnectAfterConnected?: boolean, reconnectMaxAttempts?: number }} [config] - resolved Config.
 */
export function apply(ctx, config) {
  // Skill writes, repository state, and repository working copies are touched one task at a time, so
  // concurrent requests cannot interleave on one root or copy from a working copy being reset.
  const queue = new SerialQueue()
  const logger = { warn: message => ctx.logger?.warn?.(message) }
  const catalog = new SkillCatalog(ctx, queue, logger)
  const repos = new RepoManager({ queue, catalog, logger })
  catalog.repos = repos
  ctx.effect(() => () => repos.dispose(), 'mcp-skills: repository git processes and queued writes')

  registerGroup(ctx, SKILL_API, {
    'list': payload => catalog.list(payload),
    'read': payload => catalog.read(payload),
    'save': payload => catalog.save(payload),
    'delete': payload => catalog.remove(payload),
    'repos-list': payload => repos.list(payload),
    'repos-add': payload => repos.add(payload),
    'repos-get': payload => repos.get(payload),
    'repos-refresh': payload => repos.refresh(payload),
    'repos-remove': payload => repos.remove(payload),
    'repos-install': payload => repos.install(payload),
    'repos-update': payload => repos.update(payload),
  })

  // setupMcp names its operations `mcp-<op>`; inside the MCP group the prefix is redundant.
  const mcp = Object.entries(setupMcp(ctx, config)).map(([operation, handle]) => [operation.replace(/^mcp-/, ''), handle])
  registerGroup(ctx, MCP_API, {
    'tools': payload => listMcpTools(ctx, payload),
    ...Object.fromEntries(mcp),
  })
}

/**
 * Register one API group: an exact POST route per operation, answering in the RPC envelope.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context owning the routes.
 * @param {string} prefix - route prefix such as `/api/pcmid/skill-settings`.
 * @param {Record<string, (payload: object, request: Request) => unknown>} operations - handlers by operation name.
 */
function registerGroup(ctx, prefix, operations) {
  for (const [operation, handle] of Object.entries(operations)) {
    ctx.connection.fetch.register({
      path: `${prefix}/${operation}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let envelope
        try {
          envelope = await request.json()
        } catch {
          // A body that is not JSON cannot carry an rpcId to answer.
          return new Response('body is not JSON', { status: 400 })
        }
        const rpcId = typeof envelope?.rpcId === 'string' ? envelope.rpcId : 'invalid-request'
        let result
        try {
          if (envelope?.type !== 'client-request') throw new HostError('bad-request', 'Expected a client-request envelope')
          const payload = envelope.payload ?? {}
          if (typeof payload !== 'object' || Array.isArray(payload)) throw new HostError('bad-request', 'The request payload must be an object')
          result = ok(await handle(payload, request))
        } catch (error) {
          result = toFailure(error)
        }
        return Response.json({ type: 'server-response', rpcId, result })
      },
    })
  }
}
