/**
 * Host half of the model defaults bundle: keeps the conversation default from
 * following composer switches, and starts new sessions with agent teamwork on
 * while this row's `agentTeams` switch is set.
 *
 * The page's model, agent, and permission values are Harness settings, written
 * through the settings API; the conversation default stays owned by
 * `@deepseek-ai/dsh-agent-default-model`. The teamwork switch is this row's own
 * volatile Config, written through the same API, so saving it reloads nothing.
 *
 * @module @pcmid/dsh-model-defaults
 */
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'model-defaults'

/**
 * The switch is volatile: the listener reads it at every session creation, so a
 * saved change applies to the next new session without a reload.
 */
export const Config = z.object({
  agentTeams: z.boolean().default(false).volatile()
    .description('Start new sessions with agent teamwork on. Sessions already started keep their own choice.'),
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
 * Stop session model switches from overwriting the conversation default.
 *
 * Harness saves every composer selection as the default through
 * `agentDefaultModel.saveSelection()`, and that composer path is its only
 * caller; the settings page writes the same config through the settings API and
 * is unaffected. Harness offers no extension point for this, and a second
 * provider of the service is rejected, so the method is overridden on the
 * instance. A selection is still saved while no default exists, because a new
 * session would otherwise have no model at all.
 *
 * @param defaults - the `agentDefaultModel` service.
 * @param warn - reports a Harness whose service no longer has this method.
 * @returns the disposer restoring the Harness method.
 */
export function keepDefaultFromSessionSwitches(defaults, warn) {
  const save = defaults.saveSelection
  if (typeof save !== 'function') {
    warn('model-defaults: agentDefaultModel.saveSelection is missing; composer switches may change the default')
    return () => {}
  }
  defaults.saveSelection = async (next) => {
    if (defaults.currentSelection() !== undefined) return
    await save.call(defaults, next)
  }
  return () => { delete defaults.saveSelection }
}

/**
 * Build the `agent/created` listener that turns agent teamwork on for a new
 * root session while the switch is on.
 *
 * It follows agent-team's own `defaultEnabled`: only sessions starting fresh,
 * new ones and ordinary forks, get it. Resumed sessions keep what they saved,
 * and subagents follow their root, so neither is touched. It goes through
 * `agentTeams.setEnabled`, the call behind the composer's teamwork switch. A
 * failure is logged and leaves the session off, so the session still opens.
 *
 * @param teams - the `agentTeams` service.
 * @param enabled - reads the switch at each creation.
 * @param warn - reports a session the switch could not turn on.
 * @returns the listener.
 */
export function startWithTeams(teams, enabled, warn) {
  return async ({ agent, source, signal }) => {
    if (source !== 'startup' || agent.session.header.origin === 'subagent') return
    if (!enabled() || teams.isEnabled(agent)) return
    try {
      await teams.setEnabled(agent, true, signal)
    } catch (error) {
      if (signal?.aborted) return
      warn(`model-defaults: could not turn on agent teamwork for session ${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * Keep the conversation default from following composer switches, and start
 * new sessions with agent teamwork while the switch is on. Both hang on
 * optional injections, so a Harness without either service still loads this row.
 * @param ctx - plugin context.
 * @param config - row Config.
 */
export function apply(ctx, config = {}) {
  ctx.inject(['agentDefaultModel'], (child) => {
    child.effect(
      () => keepDefaultFromSessionSwitches(child.agentDefaultModel, message => child.logger.warn(message)),
      'model-defaults: keep the default from session switches',
    )
  })
  ctx.inject(['agentTeams'], (child) => {
    child.on('agent/created', startWithTeams(
      child.agentTeams,
      () => current(config.agentTeams) === true,
      message => child.logger.warn(message),
    ))
  })
}
