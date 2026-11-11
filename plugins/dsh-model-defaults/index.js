/**
 * Host half of the model defaults bundle: keeps the conversation default from
 * following composer switches.
 *
 * The page's own values — the new-session model, agent, and permissions — are
 * Harness settings, written through the settings API; this row holds no
 * configuration of its own. The conversation default stays owned by
 * `@deepseek-ai/dsh-agent-default-model`.
 *
 * @module @pcmid/dsh-model-defaults
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'model-defaults'

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

/** Keep the conversation default from following composer switches. */
export function apply(ctx) {
  ctx.inject(['agentDefaultModel'], (child) => {
    child.effect(
      () => keepDefaultFromSessionSwitches(child.agentDefaultModel, message => child.logger.warn(message)),
      'model-defaults: keep the default from session switches',
    )
  })
}
