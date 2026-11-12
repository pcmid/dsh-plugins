/**
 * Host half of the DSH MCP and skills settings bundle.
 *
 * Registers exact Connection Fetch routes `POST /api/mcp-skills/<operation>` (reachable only by owner
 * Peers) that speak the Connection RPC envelope, so the Client half calls them with
 * `ctx.connection.rpc.call('/api', 'mcp-skills/<operation>', payload)`. Operations and payloads are
 * specified in docs/host-api.md. `skills`, `agentPresets`, and `tools` are optional services read lazily.
 *
 * @module @pcmid/dsh-mcp-skills
 */

import { HostError, ok, toFailure } from './host/errors.js'
import { SkillImporter } from './host/importer.js'
import { listMcpTools } from './host/mcp.js'
import { SerialQueue } from './host/paths.js'
import { SkillCatalog } from './host/skills.js'

/** Cordis plugin name. */
export const name = 'mcp-skills'
export const inject = ['connection']

const API_PREFIX = '/api/mcp-skills'

/**
 * Register the Host API routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  // Skill writes and installs run one at a time so concurrent requests cannot interleave on one root.
  const queue = new SerialQueue()
  const catalog = new SkillCatalog(ctx, queue)
  const importer = new SkillImporter(queue)
  ctx.effect(() => () => importer.dispose(), 'mcp-skills: import scans and temporary clones')

  const operations = {
    'skills-list': payload => catalog.list(payload),
    'skills-read': payload => catalog.read(payload),
    'skills-save': payload => catalog.save(payload),
    'skills-delete': payload => catalog.remove(payload),
    'skills-scan': payload => importer.scan(payload),
    'skills-install': payload => importer.install(payload),
    'mcp-tools': payload => listMcpTools(ctx, payload),
  }

  for (const [operation, handle] of Object.entries(operations)) {
    ctx.connection.fetch.register({
      path: `${API_PREFIX}/${operation}`,
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
          result = ok(await handle(payload))
        } catch (error) {
          result = toFailure(error)
        }
        return Response.json({ type: 'server-response', rpcId, result })
      },
    })
  }
}
