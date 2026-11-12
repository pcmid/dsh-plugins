/**
 * Host half of @pcmid/dsh-edit-prompt.
 *
 * The edit button, the editor, and the resend flow run in the Web client
 * (`client.js`) on top of existing Session Remote methods: fork at the event
 * just before the edited message's Turn, clear the input the fork inherited
 * as pending, prompt the edited text, open the fork, and optionally archive
 * the original conversation. Session logs are append-only, so "dropping"
 * the later messages means continuing in the fork.
 *
 * This row only declares the volatile `archiveSource` setting, which the
 * client reads through the settings form of this entry.
 *
 * @module @pcmid/dsh-edit-prompt
 */

import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'edit-prompt'

export const Config = z.object({
  archiveSource: z.boolean().default(true).volatile()
    .description('Archive the original conversation after an edited prompt is resent, so the conversation appears to restart in place. When off, the original stays in the list next to the new conversation.'),
})

/** The client half does the work; the Host row only serves the setting. */
export function apply() {}
