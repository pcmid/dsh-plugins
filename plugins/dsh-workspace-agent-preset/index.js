/**
 * Host half of @pcmid/dsh-workspace-agent-preset: new sessions opened in a
 * workspace start with that workspace's agent preset.
 *
 * The workspace → preset table is this row's volatile Config, edited from the
 * workspace menu in the browser half through the settings API and stored in
 * the profile's user patch layer. A session created without an explicit
 * preset in a listed workspace gets the listed one; everything else, including
 * an explicit choice in the new-session chip, is left to Harness.
 *
 * @module @pcmid/dsh-workspace-agent-preset
 */
import z from '@deepseek-ai/schemastery'
import { overrideCreate, routeRequest } from './route.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'workspace-agent-preset'

/** The table is volatile: a saved change applies to the next session without a reload. */
export const Config = z.object({
  workspaces: z.dict(z.string()).default({}).volatile()
    .description('Agent preset id per workspace directory. New sessions opened in a listed workspace start with it; other workspaces use the global default.'),
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
 * Install the creation default while the Session controller, Workspace
 * registry, and preset registry are all present.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ workspaces: unknown }} config - row Config.
 */
export function apply(ctx, config) {
  ctx.inject(['sessionController', 'workspaceRegistry', 'agentPresets'], (child) => {
    const warn = message => child.logger.warn(message)
    const route = request => routeRequest(request, {
      workspaces: () => current(config.workspaces),
      workspacePath: workspaceId => child.workspaceRegistry.get(workspaceId)?.path,
      problem: async (preset) => {
        try {
          return (await child.agentPresets.resolve(preset)).broken
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
      warn,
    })
    child.effect(() => overrideCreate(child.sessionController, route, warn), 'workspace-agent-preset: session creation default')
  })
}
