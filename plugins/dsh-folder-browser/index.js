/**
 * Host half of @pcmid/dsh-folder-browser: runs DSH's own browse backend
 * (`@deepseek-ai/dsh-host-directory-picker-browse`), which lists and creates
 * folders on the Host for the dialog in `client.js`.
 *
 * `directoryPicker` has one provider at a time. When this plugin is enabled
 * while DSH runs, DSH disables the `directory-picker` row and starts this one
 * at the same time, so the system-dialog backend that row mounted can still
 * be unloading here. The browse backend is therefore mounted only once
 * `directoryPicker` is free, right after the old provider lets go.
 * @module @pcmid/dsh-folder-browser
 */

import BrowseDirectoryPicker from '@deepseek-ai/dsh-host-directory-picker-browse'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'folder-browser-ui'

/** The browse backend's own configuration (`maxEntries`), passed through unchanged. */
export const Config = BrowseDirectoryPicker.Config

/**
 * Mount the browse backend as a child plugin, now or as soon as no other
 * plugin provides `directoryPicker`.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context; the backend unloads with it.
 * @param {{ maxEntries: number }} config - validated browse backend configuration.
 */
export async function apply(ctx, config) {
  let backend
  let waitingFor
  const mount = () => {
    if (backend !== undefined) return
    // Not strict: a provider that is still unloading keeps the name registered.
    const holder = ctx.get('directoryPicker', false)
    if (holder !== undefined) {
      const holderName = holder.constructor?.name || 'another plugin'
      if (holderName !== waitingFor) ctx.logger.info('waiting for %s to release directoryPicker', holderName)
      waitingFor = holderName
      return
    }
    backend = ctx.plugin(BrowseDirectoryPicker, config)
  }
  ctx.on('internal/service', (service) => {
    if (service !== 'directoryPicker') return
    // Leave the releasing provider's teardown before registering the next one.
    queueMicrotask(() => {
      try {
        mount()
      } catch (error) {
        // This run started unloading (disabled, or reloaded for a config change) after the check
        // was queued, and Cordis refuses new children then. It must not mount anything: a reload
        // mounts the backend itself. Uncaught, the error would surface as a Host uncaught exception.
        if (error?.code !== 'INACTIVE_EFFECT') ctx.logger.error(error)
      }
    })
  })
  mount()
  // A backend that cannot start fails this row, where the plugin list shows it.
  if (backend !== undefined) await backend
}
