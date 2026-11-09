/**
 * Host half of the model defaults bundle: owns the small model selection and
 * keeps the conversation default from following composer switches.
 *
 * The small model is the model auxiliary work runs on instead of the
 * conversation's model. It is stored as this row's config and read through the
 * `smallModel` service; the Client half edits it on the Models settings page.
 * The conversation default stays owned by `@deepseek-ai/dsh-agent-default-model`.
 *
 * @module @local/dsh-model-defaults
 */

import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

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

/** Small model selection; omitting provider or model configures none, and `enabled: false` keeps the choice but stops using it. */
export class SmallModelConfig extends Service {
  static Config = z.object({
    enabled: z.boolean().volatile(),
    provider: z.string().volatile(),
    model: z.string().volatile(),
    reasoningEffort: z.string().volatile(),
  })

  constructor(ctx, config) {
    super(ctx, 'smallModel')
    this.config = config
    // Edited by this bundle's own section, so no generated settings page.
    ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
    ctx.inject(['agentDefaultModel'], (child) => {
      child.effect(
        () => keepDefaultFromSessionSwitches(child.agentDefaultModel, message => child.logger.warn(message)),
        'model-defaults: keep the default from session switches',
      )
    })
  }

  /**
   * Read the small model selection consumers should use.
   * @returns a detached provider, model, and optional effort, or undefined while it is switched off or until both provider and model are set.
   */
  currentSelection() {
    if (this.config.enabled.get() === false) return undefined
    const provider = this.config.provider.get()
    const model = this.config.model.get()
    if (!provider || !model) return undefined
    const reasoningEffort = this.config.reasoningEffort.get()
    return { provider, model, ...reasoningEffort ? { reasoningEffort } : {} }
  }
}

export default SmallModelConfig
