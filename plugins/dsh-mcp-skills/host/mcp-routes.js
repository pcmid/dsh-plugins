/**
 * MCP reconnect and OAuth wiring (docs/auth-retry.md): the plugin Config, the supervisor, OAuth, and the
 * `mcp-state`, `mcp-retry`, and `mcp-auth-*` operations. `mcpManager` and `credentials` are optional
 * services: their listeners and timers live only while the service is present, and operations that need
 * a missing service answer `unavailable`.
 */

import z from '@deepseek-ai/schemastery'
import { errorMessage } from './errors.js'
import { McpStateHub, mcpStateSnapshot } from './mcp-state.js'
import { OAuthManager } from './oauth.js'
import { ReconnectSupervisor } from './supervisor.js'

/** Plugin Config; not volatile, so it changes only through `cordis.patch.yml`. */
export const Config = z.object({
  reconnectAfterConnected: z.boolean().default(true)
    .description('Reconnect automatically when a server that connected before loses its connection. A first connection failure is never retried automatically.'),
  reconnectMaxAttempts: z.natural().min(1).max(100).default(10)
    .description('Automatic reconnect attempts (1 s doubling to 30 s apart) before giving up.'),
})

/**
 * Start the supervisor and OAuth for one plugin instance.
 * @param {object} ctx - plugin context.
 * @param {{ reconnectAfterConnected?: boolean, reconnectMaxAttempts?: number } | undefined} config - resolved Config.
 * @param {{ oauthTiming?: object, longPollMs?: number }} [timing] - shorter contract timings for tests only.
 * @returns {Record<string, (payload: object, request: Request) => Promise<unknown> | unknown>} operations by name.
 */
export function setupMcp(ctx, config, timing = {}) {
  const hub = new McpStateHub({ timeoutMs: timing.longPollMs })
  const oauth = new OAuthManager(ctx, { onChange: () => hub.bump(), timing: timing.oauthTiming })
  const supervisor = new ReconnectSupervisor({
    getManager: () => ctx.get('mcpManager'),
    onChange: () => hub.bump(),
    onAuthFailure: server => oauth.handleAuthFailure(server),
    enabled: config?.reconnectAfterConnected ?? true,
    maxAttempts: config?.reconnectMaxAttempts ?? 10,
  })
  ctx.effect(() => () => {
    supervisor.dispose()
    hub.dispose()
    return oauth.dispose()
  }, 'mcp-skills: reconnect supervisor and OAuth flows')

  ctx.inject(['mcpManager'], (child) => {
    child.on('mcp-manager/status', (server, status) => { supervisor.onStatus(server, status) })
    child.effect(() => {
      supervisor.seed(child.mcpManager.list())
      return () => supervisor.reset()
    }, 'mcp-skills: reconnect supervision')
  })
  ctx.inject(['credentials'], (child) => {
    child.effect(() => {
      oauth.load().catch((error) => { ctx.logger?.warn?.(`mcp-skills: cannot read stored OAuth grants: ${errorMessage(error)}`) })
      return () => oauth.unload()
    }, 'mcp-skills: OAuth token refresh')
  })

  return {
    'mcp-state': async (payload, request) => {
      supervisor.prune()
      await hub.wait(payload.since, request?.signal)
      return mcpStateSnapshot(hub.version, supervisor, oauth)
    },
    'mcp-retry': payload => supervisor.retry(payload),
    'mcp-auth-check': payload => oauth.check(payload),
    'mcp-auth-start': payload => oauth.start(payload),
    'mcp-auth-complete': payload => oauth.complete(payload),
    'mcp-auth-cancel': payload => oauth.cancel(payload),
    'mcp-auth-forget': payload => oauth.forget(payload),
  }
}
