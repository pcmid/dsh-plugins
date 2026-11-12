/**
 * Browser half of @pcmid/dsh-edit-prompt.
 *
 * Replaces the Chat renderer of ordinary user messages (keyed `user`
 * renderer, registered below ui-chat's priority so it shadows the shipped
 * one) with an equivalent bubble whose action row gains an edit button after
 * copy. The content keeps rendering through the shared
 * `conversation.chat.user.content` Factory, so text, images, files, and
 * mentions look exactly as before. If this renderer crashes, the slot retires
 * it and the shipped renderer comes back.
 *
 * Edit opens an inline editor (Cancel / Send). Send restarts the
 * conversation from the edited prompt. Session logs are append-only, so the
 * restart is a fork:
 *   1. find the `turn/start` of the edited message's Turn and fork at the
 *      event just before it (the fork inherits nothing of that Turn);
 *   2. remove the input the fork inherited as still pending (the edited
 *      message itself when it was queued, or any other queued message), and
 *      keep the original's current model when the fork recorded another;
 *   3. prompt the fork with the edited text plus the original images;
 *   4. open the fork and, unless the `archiveSource` setting is off, archive
 *      the original conversation (stopping it when it is running).
 * The original conversation is never modified, so nothing is lost.
 *
 * Steering messages (sent while a Turn was running) keep the shipped
 * renderer: they sit inside a Turn, so there is no clean restart point.
 */
window.__ModuleLoader__.load({
  id: '@pcmid/dsh-edit-prompt',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React

    const NS = 'editPrompt'
    const PREFIX = 'dsh-ep'
    /** Host row id, which is also this entry's settings namespace. */
    const ENTRY = 'edit-prompt'
    /** Lower than ui-chat's default 0: the lowest priority renders. */
    const PRIORITY = -10
    /** Shared product glyphs from the theme's icon sprite. */
    const GLYPH_COPY = 'dsw-icon-copy-outline-regular'
    const GLYPH_CHECK = 'dsw-icon-check-outline-regular'
    const GLYPH_EDIT = 'dsw-icon-edit-outline-regular'

    const zh = {
      'copy': '复制',
      'copied': '已复制',
      'edit': '编辑',
      'clock.md': '{m}月{d}日',
      'clock.ymd': '{y}年{m}月{d}日',
      'editor.label': '编辑消息',
      'editor.cancel': '取消',
      'editor.send': '发送',
      'editor.sending': '发送中…',
      'editor.shortcut': '{mod}+Enter 发送，Esc 取消',
      'editor.dropsFiles': '文件附件无法重新发送，会被丢弃。',
      'error.noBoundary': '找不到这条消息所在轮次的起点，无法回退。',
      'error.failed': '发送失败：{message}',
    }
    const en = {
      'copy': 'Copy',
      'copied': 'Copied',
      'edit': 'Edit',
      'clock.md': '{m}/{d}',
      'clock.ymd': '{y}-{m}-{d}',
      'editor.label': 'Edit message',
      'editor.cancel': 'Cancel',
      'editor.send': 'Send',
      'editor.sending': 'Sending…',
      'editor.shortcut': '{mod}+Enter to send, Esc to cancel',
      'editor.dropsFiles': 'File attachments cannot be sent again and will be dropped.',
      'error.noBoundary': 'Could not find where this message\'s turn starts, so it cannot be rewound.',
      'error.failed': 'Could not send: {message}',
    }

    // Layout, type sizes, and colors follow ui-chat's user row and message
    // IconActions; the editor follows the user bubble surface.
    const CSS = `
.${PREFIX}-row { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.${PREFIX}-actions { display: flex; align-items: center; gap: 8px; height: calc(28px + var(--dsh-content-font-delta, 0px)); }
.${PREFIX}-time { padding-right: 12px; font-size: var(--dsh-content-font-size-secondary, 13px); line-height: calc(24px + var(--dsh-content-font-delta, 0px)); color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
@media (hover: hover) {
  :is([data-chat-flow-kind='user'], [data-chat-flow-kind='steering']):has(~ :is([data-chat-flow-kind='user'], [data-chat-flow-kind='steering'])) .${PREFIX}-actions { opacity: 0; transition: opacity 80ms ease; }
  :is([data-chat-flow-kind='user'], [data-chat-flow-kind='steering']):has(~ :is([data-chat-flow-kind='user'], [data-chat-flow-kind='steering'])):hover .${PREFIX}-actions,
  :is([data-chat-flow-kind='user'], [data-chat-flow-kind='steering']):has(~ :is([data-chat-flow-kind='user'], [data-chat-flow-kind='steering'])):focus-within .${PREFIX}-actions { opacity: 1; }
}
.${PREFIX}-tip { display: inline-flex; }
.${PREFIX}-action { display: inline-flex; align-items: center; justify-content: center; width: calc(28px + var(--dsh-content-font-delta, 0px)); height: calc(28px + var(--dsh-content-font-delta, 0px)); padding: 6px; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.${PREFIX}-action svg { width: calc(15px + var(--dsh-content-font-delta, 0px)); height: calc(15px + var(--dsh-content-font-delta, 0px)); }
@media (hover: hover) { .${PREFIX}-action:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); } }
.${PREFIX}-action:focus-visible, .${PREFIX}-button:focus-visible { outline: 1.5px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.${PREFIX}-bubble { position: fixed; z-index: 100; transform: translateX(-50%); width: max-content; max-width: min(50vw, calc(100vw - 24px)); box-sizing: border-box; padding: 3px 7px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-tooltip-bg); color: var(--dsw-static-neutral-bluish-00); font-size: 13px; line-height: 20px; white-space: nowrap; pointer-events: none; animation: ${PREFIX}-tip-in 150ms ease-in-out; }
@keyframes ${PREFIX}-tip-in { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .${PREFIX}-bubble { animation: none; } }
.${PREFIX}-editor { align-self: stretch; display: flex; flex-direction: column; align-items: stretch; gap: 8px; }
.${PREFIX}-editor-time { align-self: center; font-size: var(--dsh-content-font-size-secondary, 13px); line-height: calc(20px + var(--dsh-content-font-delta, 0px)); color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-editor-media { align-self: flex-end; }
.${PREFIX}-card { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px 12px; border-radius: var(--dsw-radius-xl); background: var(--dsw-specific-bubble); }
.${PREFIX}-input { display: block; box-sizing: border-box; width: 100%; min-height: calc(3 * (22px + var(--dsh-content-font-delta, 0px))); max-height: 50vh; margin: 0; padding: 0; border: none; outline: none; resize: none; overflow-y: auto; background: transparent; font: inherit; font-size: var(--dsh-content-font-size, 14px); line-height: calc(22px + var(--dsh-content-font-delta, 0px)); color: var(--dsw-alias-label-primary); }
.${PREFIX}-input:disabled { opacity: 0.6; }
.${PREFIX}-footer { display: flex; align-items: flex-end; gap: 8px; }
.${PREFIX}-notes { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-error { color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.${PREFIX}-buttons { display: flex; align-items: center; gap: 8px; flex: none; }
.${PREFIX}-button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; height: 32px; padding: 0 14px; border: none; border-radius: var(--dsw-radius-md); font: inherit; font-size: 14px; line-height: 22px; white-space: nowrap; cursor: pointer; }
.${PREFIX}-button:disabled { cursor: not-allowed; opacity: 0.4; }
.${PREFIX}-cancel { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); box-shadow: inset 0 0 0 var(--dsh-hairline-width, 0.5px) var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); }
.${PREFIX}-send { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
@media (hover: hover) {
  .${PREFIX}-cancel:hover:not(:disabled) { background-image: linear-gradient(var(--dsw-alias-interactive-bg-hover), var(--dsw-alias-interactive-bg-hover)); }
  .${PREFIX}-send:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill)); }
}
`

    const EMPTY_FACTS = Object.freeze({})
    const EMPTY_BLOCKS = Object.freeze([])

    /** Split durable user content the way ui-chat's user row does. */
    function contentParts(content) {
      const texts = []
      const attachments = []
      const rest = []
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
        else if (block?.type === 'image' && block.attachment !== undefined) attachments.push({ type: 'image', image: { attachment: block.attachment } })
        else if (block?.type === 'file' && block.attachment !== undefined) attachments.push({ type: 'file', file: block.attachment })
        else rest.push(block)
      }
      return { text: texts.join(''), attachments, rest }
    }

    function pad2(n) {
      return String(n).padStart(2, '0')
    }

    /** Same-day `HH:mm`, otherwise the localized date plus the clock (ui-chat's format). */
    function formatClock(time, t, now) {
      const d = new Date(time)
      const n = new Date(now)
      const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
      if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return clock
      const params = { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }
      return `${d.getFullYear() === n.getFullYear() ? t('clock.md', params) : t('clock.ymd', params)} ${clock}`
    }

    function startOfLocalDay(ms) {
      const d = new Date(ms)
      d.setHours(0, 0, 0, 0)
      return d.getTime()
    }

    function msUntilNextLocalMidnight(ms) {
      const next = new Date(ms)
      next.setHours(24, 0, 0, 0)
      return Math.max(next.getTime() - ms, 1)
    }

    /** Local calendar day that advances at midnight, so same-day clocks gain their date. */
    function useCalendarDay() {
      const [day, setDay] = useState(() => startOfLocalDay(Date.now()))
      useEffect(() => {
        let timer
        const arm = () => {
          const now = Date.now()
          setDay(startOfLocalDay(now))
          timer = setTimeout(arm, msUntilNextLocalMidnight(now))
        }
        timer = setTimeout(arm, msUntilNextLocalMidnight(Date.now()))
        return () => { clearTimeout(timer) }
      }, [])
      return day
    }

    /** Write text to the clipboard; true only when the host accepted it. */
    async function writeClipboard(text) {
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text)
          return true
        } catch {
          // Denied permission: do not claim success.
          return false
        }
      }
      if (typeof document.execCommand !== 'function') return false
      const el = document.createElement('textarea')
      el.value = text
      el.setAttribute('readonly', '')
      el.style.position = 'fixed'
      el.style.left = '-9999px'
      document.body.appendChild(el)
      el.select()
      try {
        return document.execCommand('copy')
      } catch {
        // The legacy command is unavailable: report failure.
        return false
      } finally {
        el.remove()
      }
    }

    /** Copy action with one second of success feedback. */
    function useClipboardCopy(text) {
      const [copied, setCopied] = useState(false)
      const pending = useRef(false)
      const timer = useRef(null)
      const epoch = useRef(0)
      useEffect(() => () => {
        epoch.current += 1
        pending.current = false
        if (timer.current !== null) clearTimeout(timer.current)
      }, [])
      const onCopy = useCallback(() => {
        if (copied || pending.current) return
        const current = epoch.current
        pending.current = true
        void writeClipboard(text).then((ok) => {
          if (current !== epoch.current) return
          pending.current = false
          if (!ok) return
          setCopied(true)
          timer.current = setTimeout(() => {
            timer.current = null
            setCopied(false)
          }, 1000)
        })
      }, [copied, text])
      return { copied, onCopy }
    }

    function Glyph({ id }) {
      return h('svg', { width: 16, height: 16, 'aria-hidden': 'true', 'data-icon': id }, h('use', { href: `#${id}` }))
    }

    /** Hover/focus tooltip below its anchor, matching the host tooltip's look. */
    function Tip({ label, children }) {
      const [at, setAt] = useState(null)
      const show = (event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        setAt({ left: rect.left + rect.width / 2, top: rect.bottom + 8 })
      }
      const hide = () => { setAt(null) }
      return h('span', {
        className: `${PREFIX}-tip`,
        onPointerEnter: (event) => { if (event.pointerType !== 'touch') show(event) },
        onPointerLeave: hide,
        onFocus: show,
        onBlur: hide,
        onClick: hide,
      },
      children,
      at === null ? null : h('span', { role: 'tooltip', className: `${PREFIX}-bubble`, style: at }, label))
    }

    function ActionButton({ label, glyph, onClick }) {
      return h(Tip, { label },
        h('button', { type: 'button', className: `${PREFIX}-action`, 'aria-label': label, onClick }, h(Glyph, { id: glyph })))
    }

    /** Clock, copy, and edit: ui-chat's user IconActions row plus the edit action. */
    function Actions({ text, time, t, onEdit }) {
      const day = useCalendarDay()
      const { copied, onCopy } = useClipboardCopy(text)
      return h('div', { className: `${PREFIX}-actions`, 'data-clock': 'start' },
        typeof time === 'number' ? h('span', { className: `${PREFIX}-time` }, formatClock(time, t, day)) : null,
        h(ActionButton, { label: copied ? t('copied') : t('copy'), glyph: copied ? GLYPH_CHECK : GLYPH_COPY, onClick: onCopy }),
        onEdit === undefined ? null : h(ActionButton, { label: t('edit'), glyph: GLYPH_EDIT, onClick: onEdit }))
    }

    const MOD_KEY = /Mac|iPhone|iPad/.test(navigator.platform ?? '') ? '⌘' : 'Ctrl'

    function Editor({ initialText, time, t, media, hasImages, dropsFiles, onCancel, onSend, onSent }) {
      const day = useCalendarDay()
      const [draft, setDraft] = useState(initialText)
      const [sending, setSending] = useState(false)
      const [error, setError] = useState(null)
      const input = useRef(null)
      const mounted = useRef(true)
      useEffect(() => () => { mounted.current = false }, [])
      useEffect(() => {
        const node = input.current
        if (node === null) return
        node.focus()
        node.setSelectionRange(node.value.length, node.value.length)
      }, [])
      // Grow with the text; max-height then scrolls.
      useLayoutEffect(() => {
        const node = input.current
        if (node === null) return
        node.style.height = 'auto'
        node.style.height = `${node.scrollHeight}px`
      }, [draft])

      const canSend = !sending && (draft.trim() !== '' || hasImages)
      const send = () => {
        if (!canSend) return
        setSending(true)
        setError(null)
        void onSend(draft).then((result) => {
          if (!mounted.current) return
          if (result.ok) {
            onSent()
            return
          }
          setSending(false)
          setError(result.code === 'noBoundary' ? t('error.noBoundary') : t('error.failed', { message: result.detail }))
        })
      }
      const onKeyDown = (event) => {
        const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
        if (composing) return
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (!sending) onCancel()
          return
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          event.stopPropagation()
          send()
        }
      }

      return h('div', { className: `${PREFIX}-editor` },
        typeof time === 'number' ? h('div', { className: `${PREFIX}-editor-time` }, formatClock(time, t, day)) : null,
        media === null ? null : h('div', { className: `${PREFIX}-editor-media` }, media),
        h('div', { className: `${PREFIX}-card` },
          h('textarea', {
            ref: input,
            className: `${PREFIX}-input`,
            rows: 3,
            'aria-label': t('editor.label'),
            value: draft,
            disabled: sending,
            onChange: (event) => { setDraft(event.currentTarget.value) },
            onKeyDown,
          }),
          h('div', { className: `${PREFIX}-footer` },
            h('div', { className: `${PREFIX}-notes` },
              dropsFiles ? h('span', null, t('editor.dropsFiles')) : null,
              error === null
                ? h('span', null, t('editor.shortcut', { mod: MOD_KEY }))
                : h('span', { className: `${PREFIX}-error`, role: 'alert' }, error)),
            h('div', { className: `${PREFIX}-buttons` },
              h('button', { type: 'button', className: `${PREFIX}-button ${PREFIX}-cancel`, disabled: sending, onClick: onCancel }, t('editor.cancel')),
              h('button', { type: 'button', className: `${PREFIX}-button ${PREFIX}-send`, disabled: !canSend, onClick: send },
                sending ? t('editor.sending') : t('editor.send'))))))
    }

    /** Keyed `user` Chat renderer: ui-chat's user bubble with an edit action. */
    const EditableUserMessage = React.memo(function EditableUserMessage(props) {
      const { node, t, renderFactorySlot, loadImage, useAccess, resendEdited } = props
      const data = node.data
      const parts = useMemo(() => contentParts(data.content), [data.content])
      const prepared = useMemo(() => ({
        text: parts.text,
        attachments: parts.attachments,
        extraBlocks: parts.rest,
        ...(data.referenceLabels === undefined ? {} : { referenceLabels: data.referenceLabels }),
      }), [parts, data.referenceLabels])
      const facts = useMemo(() => ({
        ...(data.referenceLabels === undefined ? {} : { sessionLabels: data.referenceLabels }),
        ...(data.skillNames === undefined ? {} : { skillNames: data.skillNames }),
      }), [data.referenceLabels, data.skillNames])
      const mediaContent = useMemo(() => ({ text: '', attachments: parts.attachments, extraBlocks: EMPTY_BLOCKS }), [parts])
      const forkAllowed = useAccess('session/fork')
      const [editing, setEditing] = useState(false)

      if (editing) {
        return h('div', { className: `${PREFIX}-row` },
          h(Editor, {
            initialText: parts.text,
            time: data.time,
            t,
            media: parts.attachments.length === 0
              ? null
              : renderFactorySlot('conversation.chat.user.content', { content: mediaContent, loadImage, facts: EMPTY_FACTS, interactive: false }),
            hasImages: parts.attachments.some(attachment => attachment.type === 'image'),
            dropsFiles: parts.attachments.some(attachment => attachment.type === 'file') || parts.rest.length > 0,
            onCancel: () => { setEditing(false) },
            onSend: text => resendEdited({ seq: data.seq, location: node.location, content: data.content, text }),
            onSent: () => { setEditing(false) },
          }))
      }
      return h('div', { className: `${PREFIX}-row` },
        renderFactorySlot('conversation.chat.user.content', { content: prepared, loadImage, facts, interactive: true }),
        h(Actions, {
          text: prepared.text,
          time: data.time,
          t,
          onEdit: forkAllowed && typeof data.seq === 'number' ? () => { setEditing(true) } : undefined,
        }))
    })

    /** Seq of the `turn/start` that opened a Chat node's Turn, when loaded. */
    function turnStartSeq(location) {
      if (location?.kind !== 'step' && location?.kind !== 'turn') return undefined
      const seq = location.turn?.start?.seq
      return typeof seq === 'number' ? seq : undefined
    }

    /** Unwrap a Remote result; a refusal throws its RemoteError. */
    function expectOk(result) {
      if (!result.ok) throw result.error
      return result.value
    }

    /** The selection a `modelSelection` projection view names for the next request. */
    function modelOf(view) {
      const next = view?.next
      if (typeof next?.provider !== 'string' || typeof next?.model !== 'string') return undefined
      return {
        provider: next.provider,
        model: next.model,
        ...(typeof next.reasoningEffort === 'string' ? { reasoningEffort: next.reasoningEffort } : {}),
      }
    }

    function sameModel(a, b) {
      return a?.provider === b?.provider && a?.model === b?.model && a?.reasoningEffort === b?.reasoningEffort
    }

    function describeError(error) {
      const remote = error?.error ?? error
      if (typeof remote?.message === 'string' && remote.message !== '') return remote.message
      return String(error)
    }

    return {
      inject: ['slots', 'locale', 'sessions', 'uiWorkspace', 'remote', 'remote.session', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'edit-prompt: dictionaries')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.dshEditPrompt = ''
          style.textContent = CSS
          document.head.append(style)
          return () => { style.remove() }
        }, 'edit-prompt: styles')

        const settingsForm = ctx.configForms.get(ENTRY)
        const archiveSource = () => settingsForm.getSnapshot().value?.archiveSource !== false

        /** Locate the edited message's Turn start from the Host log when the loaded window lacks it. */
        async function fetchTurnStart(sessionId, seq) {
          const page = expectOk(await ctx.remote.session.events({
            address: { kind: 'session', sessionId },
            beforeSeq: seq,
            maxMessages: 50,
            turnWindow: { minMessages: 1, minTurns: 1 },
          }))
          let found
          for (const record of page.records) {
            const event = record?.event
            if (event?.type === 'turn/start' && event.seq < seq) found = event.seq
          }
          return found
        }

        /** The model the next request of a Session would use, or undefined when it cannot be read. */
        async function nextModel(sessionId) {
          try {
            const projections = expectOk(await ctx.remote.session.projections({ sessionId }))
            return modelOf(projections?.values?.modelSelection)
          } catch (error) {
            console.warn('[edit-prompt] could not read the model selection of', sessionId, error)
            return undefined
          }
        }

        /**
         * Remove every input the fork inherited as pending, so the new Turn sees only the edited prompt.
         * @returns the fork's projection values read for the purpose.
         */
        async function clearInheritedInbox(childId) {
          const projections = expectOk(await ctx.remote.session.projections({ sessionId: childId }))
          const inbox = projections?.values?.inbox
          const pending = [...(inbox?.['next-step'] ?? []), ...(inbox?.['next-turn'] ?? [])]
          for (const message of pending) {
            const removed = await ctx.remote.session.updateQueue({ sessionId: childId, itemId: message.id, action: { kind: 'remove' } })
            if (!removed.ok && removed.error?.code !== 'session/queue-item-not-found') throw removed.error
          }
          return projections?.values
        }

        /**
         * The fork records the model selected at the cut; keep the original's current choice instead.
         * A refusal only leaves the inherited model in place.
         */
        async function carryModel(childId, wanted, childValues) {
          if (wanted === undefined || sameModel(wanted, modelOf(childValues?.modelSelection))) return
          const selected = await ctx.remote.session.selectModel({ sessionId: childId, ...wanted })
          if (!selected.ok) console.warn('[edit-prompt] could not keep the original model on the fork', selected.error)
        }

        /**
         * Restart a conversation from an edited user message.
         * @returns `{ ok: true }` once the fork received the prompt and opened, or the failure for the editor to show.
         */
        async function resendEdited(sessionId, request) {
          try {
            const turnStart = turnStartSeq(request.location) ?? await fetchTurnStart(sessionId, request.seq)
            if (turnStart === undefined || turnStart < 1) return { ok: false, code: 'noBoundary' }

            // Images are read back before forking, so a failed read leaves nothing behind.
            const content = []
            for (const block of request.content) {
              if (block?.type !== 'image' || block.attachment === undefined) continue
              const image = expectOk(await ctx.remote.session.attachment({ sessionId, attachment: block.attachment }))
              content.push({
                type: 'image',
                mediaType: image.attachment.mediaType,
                data: image.data,
                ...(typeof image.attachment.name === 'string' ? { name: image.attachment.name } : {}),
              })
            }
            if (request.text.trim() !== '') content.push({ type: 'text', text: request.text })

            const wantedModel = await nextModel(sessionId)
            const archive = archiveSource()
            const childId = await ctx.sessions.fork({ sessionId, atSeq: turnStart - 1, increaseTitle: !archive })
            try {
              const childValues = await clearInheritedInbox(childId)
              await carryModel(childId, wantedModel, childValues)
              expectOk(await ctx.remote.session.prompt({
                requestId: crypto.randomUUID(),
                sessionId: childId,
                mode: 'queue',
                content,
                clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              }))
            } catch (error) {
              // The fork never received the prompt: archive it instead of leaving a stray copy.
              void ctx.uiWorkspace.archiveSession(childId).catch((archiveError) => {
                console.warn('[edit-prompt] could not archive the unused fork', childId, archiveError)
              })
              throw error
            }
            ctx.uiWorkspace.openSession(childId)
            if (archive) {
              void ctx.uiWorkspace.archiveSession(sessionId, { stopActivity: true }).catch((error) => {
                console.warn('[edit-prompt] could not archive the original conversation', sessionId, error)
              })
            }
            return { ok: true }
          } catch (error) {
            return { ok: false, code: 'failed', detail: describeError(error) }
          }
        }

        ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
          name: 'conversation.chat.node',
          key: 'user',
          priority: PRIORITY,
          locale: NS,
          inject: sessionId => ({
            resendEdited: request => resendEdited(sessionId, request),
          }),
        }, EditableUserMessage))
      },
    }
  },
})
