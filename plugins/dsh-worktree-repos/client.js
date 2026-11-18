/**
 * Browser half of @pcmid/dsh-worktree-repos.
 *
 * - The workspace menu (right-click on a workspace header, or its "…"
 *   button) of a workspace that is not a Git checkout gets "Scan Git
 *   repositories", or "Stop scanning Git repositories" while it is on. The
 *   switch is the Host row's volatile `workspaces` Config, written through
 *   the shared configuration form.
 * - While it is on, the new-session row of that workspace shows a repository
 *   picker before Harness's worktree option. Picking a repository moves the
 *   new session into it; Harness then offers its own base branch menu and
 *   worktree checkbox for that repository. "No repository" moves it back.
 *
 * Controls are drawn here rather than taken from Harness's component library;
 * icons reference the theme's shared icon sprite.
 */
window.__ModuleLoader__.load({
  id: '@pcmid/dsh-worktree-repos',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useEffect, useRef, useState, useSyncExternalStore } = React

    const NS = 'worktreeRepos'
    /** Settings namespace: the row id in cordis.patch.yml. */
    const ENTRY = 'worktree-repos'
    const PREFIX = 'dsh-wr'
    /** Connection RPC channel and endpoint prefix of the Host half's routes. */
    const HOST_CHANNEL = '/api'
    const HOST_API = 'pcmid/worktree-repos'
    const ICON = `${ENTRY}.scan`

    const zh = {
      scan: '扫描 Git 仓库',
      stopScan: '取消扫描 Git 仓库',
      turnedOn: '「{workspace}」中的新会话可以选择 Git 仓库了',
      turnedOff: '已取消扫描「{workspace}」中的 Git 仓库',
      saveFailed: '无法保存扫描 Git 仓库的设置',
      heading: '仓库',
      choose: '选择仓库',
      none: '不选仓库',
      empty: '工作区下没有 Git 仓库',
      pickerLabel: '仓库：{name}',
      chooseFailed: '无法切换仓库：{reason}',
      loadFailed: '无法读取仓库列表：{reason}',
      withdrawn: '换了仓库，之前勾选的 worktree 已取消',
      'error.busy': '会话正忙，请稍后再试',
      'error.not-found': '这个仓库已不在工作区里',
      'error.unavailable': '这个会话已经不能切换仓库',
    }
    const en = {
      scan: 'Scan Git repositories',
      stopScan: 'Stop scanning Git repositories',
      turnedOn: 'New sessions in {workspace} can now pick a Git repository',
      turnedOff: 'Stopped scanning Git repositories in {workspace}',
      saveFailed: 'Could not save the Git repository scanning setting',
      heading: 'Repository',
      choose: 'Choose repository',
      none: 'No repository',
      empty: 'No Git repositories in this workspace',
      pickerLabel: 'Repository: {name}',
      chooseFailed: 'Could not switch the repository: {reason}',
      loadFailed: 'Could not read the repositories: {reason}',
      withdrawn: 'The repository changed, so the worktree you had checked was cleared',
      'error.busy': 'The session is busy. Try again in a moment',
      'error.not-found': 'The repository is no longer in this workspace',
      'error.unavailable': 'This session can no longer change its repository',
    }

    /* The trigger copies the 28px chip of Harness's worktree option beside it;
       the card copies Harness's dropdown menus. */
    const CSS = `
.${PREFIX}-trigger {
  display: inline-flex; flex: none; align-items: center; gap: 4px; min-width: 0; max-width: 200px;
  height: 28px; padding: 0 4px 0 8px; border: none; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 13px; font-weight: 500; line-height: 20px; white-space: nowrap; cursor: pointer;
}
@media (hover: hover) { .${PREFIX}-trigger:hover:not([aria-busy="true"]) { background: var(--dsw-alias-interactive-bg-hover); } }
.${PREFIX}-trigger:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.${PREFIX}-trigger[aria-busy="true"] { color: var(--dsw-alias-label-dimmed); cursor: progress; }
.${PREFIX}-trigger > svg { flex: none; }
.${PREFIX}-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.${PREFIX}-chevron { color: var(--dsw-alias-label-tertiary); transition: transform 120ms ease; }
.${PREFIX}-chevron[data-open] { transform: rotate(180deg); }
.${PREFIX}-menu {
  position: fixed; z-index: 1100; box-sizing: border-box; display: flex; flex-direction: column;
  min-width: 160px; max-width: min(360px, calc(100vw - 24px)); padding: 4px; overflow-y: auto;
  border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-overlay);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); box-shadow: var(--dsw-elevation-prominent);
}
.${PREFIX}-heading { padding: 6px 8px; font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-item {
  display: flex; flex: none; align-items: center; gap: 6px; width: 100%; min-height: 30px; padding: 4px 8px;
  border: none; border-radius: var(--dsw-radius-md); background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; line-height: 20px; text-align: left; cursor: pointer;
}
@media (hover: hover) { .${PREFIX}-item:hover { background: var(--dsw-alias-interactive-bg-hover); } }
.${PREFIX}-item:focus-visible { background: var(--dsw-alias-interactive-bg-hover); outline: none; }
.${PREFIX}-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${PREFIX}-check { flex: none; color: var(--dsw-alias-label-primary); }
.${PREFIX}-separator { flex: none; height: 0.5px; margin: 3px 8px; background: var(--dsw-alias-border-l2); }
.${PREFIX}-empty { padding: 4px 8px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); outline: none; }
@media (max-width: 600px) { .${PREFIX}-trigger { max-width: 96px; } }
`

    function fill(template, values) {
      return template.replace(/\{(\w+)\}/gu, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match)
    }

    /** Same comparison as the Host half: trailing separators are ignored. */
    function normalizePath(path) {
      const trimmed = path.replace(/[\\/]+$/u, '')
      return trimmed === '' || /^[A-Za-z]:$/u.test(trimmed) ? path : trimmed
    }

    /** @returns the string entries of the `workspaces` Config value. */
    function entries(workspaces) {
      return Array.isArray(workspaces) ? workspaces.filter(entry => typeof entry === 'string') : []
    }

    function listed(workspaces, path) {
      const wanted = normalizePath(path)
      return entries(workspaces).some(entry => normalizePath(entry) === wanted)
    }

    /** A Host refusal carrying its failure code. */
    class HostFailure extends Error {
      constructor(code, message) {
        super(message)
        this.code = code
      }
    }

    /** A glyph of the theme's icon sprite, the artwork Harness's own icons use. */
    function Glyph({ name, size, className }) {
      return h('svg', { width: size, height: size, className, 'aria-hidden': true }, h('use', { href: `#dsw-icon-${name}-regular` }))
    }

    function ScanIcon() {
      return h(Glyph, { name: 'branch-outline', size: 14 })
    }

    return {
      inject: ['slots', 'locale', 'configForms', 'contextMenus', 'connection'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'worktree-repos: dictionaries')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = ENTRY
          style.textContent = CSS
          document.head.append(style)
          return () => { style.remove() }
        }, 'worktree-repos: styles')

        const form = ctx.configForms.get(ENTRY)
        const subscribeForm = listener => form.subscribe(listener)
        const readForm = () => form.getSnapshot()

        /** Call one operation of the Host half; a refusal throws a {@link HostFailure}. */
        async function callHost(operation, payload) {
          const result = await ctx.connection.rpc.call(HOST_CHANNEL, `${HOST_API}/${operation}`, payload)
          if (!result.ok) throw new HostFailure(result.error?.code, result.error?.message || result.error?.code || 'request failed')
          return result.value
        }

        /** The reader-facing reason of a failure: this plugin's own wording for the Host's known refusals. */
        function reasonOf(error) {
          const key = `error.${error?.code}`
          if (Object.hasOwn(zh, key)) return t(key)
          return error instanceof Error ? error.message : String(error)
        }

        /** Whether a workspace directory is a Git checkout, by path; the menu answers from here and refreshes behind it. */
        const probes = new Map()
        async function probeGit(path) {
          const fresh = callHost('probe', { path }).then((value) => {
            probes.set(path, value.git)
            return value.git
          })
          if (probes.has(path)) {
            fresh.catch(() => {})
            return probes.get(path)
          }
          return await fresh
        }

        /** Turn scanning on or off for one workspace, then report it. */
        const toggle = async ({ path, displayTitle }, on) => {
          const current = entries(form.getSnapshot().value?.workspaces)
          const wanted = normalizePath(path)
          const next = on ? current.filter(entry => normalizePath(entry) !== wanted) : [...current, path]
          if (!(await form.mutate([{ op: 'set', path: ['workspaces'], value: next }]))) throw new Error(t('saveFailed'))
          ctx.contextMenus.notify(fill(t(on ? 'turnedOff' : 'turnedOn'), { workspace: displayTitle }), true)
        }

        ctx.slots.inject('contextMenu.icon', function* () {
          yield ctx.slots.register({ name: 'contextMenu.icon', key: ICON }, ScanIcon)
        })

        // Present only while the Host serves the row: without it, the switch would change nothing.
        ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => ctx.contextMenus.register({
          id: ENTRY,
          target: 'workspace',
          // After "Agent preset" (250) of @pcmid/dsh-workspace-agent-preset, before the separated "Delete" (300).
          order: 260,
          observe: () => [form],
          resolve: async (target, signal) => {
            let git
            try {
              git = await probeGit(target.path)
            } catch {
              // Without an answer the menu leaves the switch out rather than offer one that may do nothing.
              return []
            }
            signal.throwIfAborted()
            if (git) return []
            const snapshot = form.getSnapshot()
            const on = listed(snapshot.value?.workspaces, target.path)
            return [{
              id: 'scan',
              label: t(on ? 'stopScan' : 'scan'),
              icon: { key: ICON },
              disabled: !(snapshot.status === 'ready' && snapshot.writable),
              failureLabel: t('saveFailed'),
              run: () => toggle(target, on),
            }]
          },
        })), 'worktree-repos: workspace menu')

        /** Rows the arrow keys move through, the empty-list notice included. */
        const ROWS = '[role="menuitemradio"], [role="menuitem"]'

        /** The open card: rows below the trigger, right edges aligned, closed by a click outside, Escape, Tab, a scroll, or a resize. */
        function RepoMenu({ anchor, state, selected, pick, close }) {
          const card = useRef(null)
          const rect = anchor.getBoundingClientRect()
          const top = rect.bottom + 4
          useEffect(() => {
            const rows = [...card.current.querySelectorAll(ROWS)]
            ;(rows.find(row => row.getAttribute('aria-checked') === 'true') ?? rows[0])?.focus()
            const outside = (event) => {
              if (!card.current?.contains(event.target) && !anchor.contains(event.target)) close(false)
            }
            // The card is placed once, so moving the page under it closes it; scrolling the card itself does not.
            const scrolled = (event) => {
              if (!card.current?.contains(event.target)) close(false)
            }
            const dismiss = () => { close(false) }
            document.addEventListener('pointerdown', outside, true)
            document.addEventListener('scroll', scrolled, true)
            window.addEventListener('resize', dismiss)
            window.addEventListener('blur', dismiss)
            return () => {
              document.removeEventListener('pointerdown', outside, true)
              document.removeEventListener('scroll', scrolled, true)
              window.removeEventListener('resize', dismiss)
              window.removeEventListener('blur', dismiss)
            }
          }, [])
          const keyDown = (event) => {
            const rows = [...card.current.querySelectorAll(ROWS)]
            const index = rows.indexOf(document.activeElement)
            let next
            if (event.key === 'ArrowDown') next = rows[(index + 1) % rows.length]
            else if (event.key === 'ArrowUp') next = rows[(index - 1 + rows.length) % rows.length]
            else if (event.key === 'Home') next = rows[0]
            else if (event.key === 'End') next = rows.at(-1)
            else if (event.key === 'Escape') {
              event.preventDefault()
              close(true)
              return
            } else if (event.key === 'Tab') {
              // Focus returns to the trigger first, so Tab goes on to the control after it.
              close(true)
              return
            } else return
            event.preventDefault()
            next?.focus()
          }
          const row = (key, label, path, checked) => h('button', {
            key,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': checked,
            className: `${PREFIX}-item`,
            onClick: () => { pick(path) },
          }, h('span', { className: `${PREFIX}-name` }, label), checked ? h(Glyph, { name: 'check-outline', size: 14, className: `${PREFIX}-check` }) : null)
          return ReactDOM.createPortal(h('div', {
            ref: card,
            role: 'menu',
            'aria-label': t('heading'),
            className: `${PREFIX}-menu`,
            style: { top, right: Math.max(12, window.innerWidth - rect.right), maxHeight: Math.max(120, window.innerHeight - top - 12) },
            onKeyDown: keyDown,
          },
          h('div', { className: `${PREFIX}-heading`, role: 'presentation' }, t('heading')),
          row('none', t('none'), null, selected === undefined),
          h('div', { className: `${PREFIX}-separator`, role: 'separator' }),
          state.repositories.length === 0
            ? h('div', { className: `${PREFIX}-empty`, role: 'menuitem', 'aria-disabled': true, tabIndex: -1 }, t('empty'))
            : state.repositories.map(repository => row(repository.path, repository.name, repository.path, repository === selected)),
          ), document.body)
        }

        /** The repository picker of one new session; nothing while the Host says it does not apply. */
        function RepoPicker({ sessionId }) {
          const snapshot = useSyncExternalStore(subscribeForm, readForm)
          const workspaces = entries(snapshot.value?.workspaces)
          const scanned = workspaces.length > 0
          const [state, setState] = useState(null)
          const [busy, setBusy] = useState(false)
          const [open, setOpen] = useState(false)
          const trigger = useRef(null)
          useEffect(() => {
            if (!scanned) {
              setState(null)
              return undefined
            }
            let live = true
            callHost('repositories', { sessionId }).then(
              (value) => { if (live) setState(value) },
              () => { if (live) setState(null) },
            )
            return () => { live = false }
          }, [sessionId, JSON.stringify(workspaces)])

          if (state === null) return null
          const current = normalizePath(state.current)
          const selected = state.repositories.find(repository => normalizePath(repository.path) === current)
          const label = selected?.name ?? t('choose')

          /** Opening reads the repositories again, so a repository cloned meanwhile shows up. */
          const show = async () => {
            if (busy) return
            if (open) {
              setOpen(false)
              return
            }
            setBusy(true)
            try {
              const value = await callHost('repositories', { sessionId })
              setState(value)
              if (value !== null) setOpen(true)
            } catch (error) {
              ctx.contextMenus.notify(fill(t('loadFailed'), { reason: reasonOf(error) }), false)
            } finally {
              setBusy(false)
            }
          }
          const close = (refocus) => {
            setOpen(false)
            if (refocus) trigger.current?.focus()
          }
          const pick = async (path) => {
            close(true)
            if (path === (selected?.path ?? null)) return
            setBusy(true)
            try {
              const { state: next, withdrawn } = await callHost('choose', { sessionId, path })
              setState(next)
              if (withdrawn) ctx.contextMenus.notify(t('withdrawn'), true)
            } catch (error) {
              ctx.contextMenus.notify(fill(t('chooseFailed'), { reason: reasonOf(error) }), false)
            } finally {
              setBusy(false)
            }
          }

          return h(React.Fragment, null,
            h('button', {
              ref: trigger,
              type: 'button',
              className: `${PREFIX}-trigger`,
              'aria-haspopup': 'menu',
              'aria-expanded': open,
              'aria-label': fill(t('pickerLabel'), { name: label }),
              // Busy keeps focus on the trigger, which a disabled button would drop.
              'aria-disabled': busy,
              'aria-busy': busy,
              title: selected?.name,
              onClick: () => { void show() },
            },
            h(Glyph, { name: 'folder-close', size: 14 }),
            h('span', { className: `${PREFIX}-label` }, label),
            h('svg', { width: 12, height: 12, className: `${PREFIX}-chevron`, 'data-open': open ? '' : undefined, 'aria-hidden': true },
              h('use', { href: '#dsw-icon-chevron-down-outline-regular' })),
            ),
            open && trigger.current !== null ? h(RepoMenu, { anchor: trigger.current, state, selected, pick, close }) : null,
          )
        }

        ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
          name: 'conversation.hero.options',
          id: `${ENTRY}.picker`,
          // Before Harness's worktree option (order 0): repository first, then its branch.
          order: -1,
          inject: sessionId => ({ sessionId }),
        }, RepoPicker))
      },
    }
  },
})
