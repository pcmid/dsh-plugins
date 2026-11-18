/**
 * Browser half of @pcmid/dsh-worktree-repos.
 *
 * - In the new-session row of a workspace that is not a Git checkout, a
 *   repository picker sits before Harness's worktree option. Picking a
 *   repository moves the new session into it; Harness then offers its own
 *   branch menu and worktree checkbox, which read after the picker as one
 *   path: `repository / branch`. "Stay in the workspace root" moves it back.
 *   The picker opens a searchable list in Harness's menu material, each row
 *   showing the repository's checked-out branch.
 * - The plugin's page in Plugins edits the scan depth.
 *
 * The settings form comes from Harness's component library, as in
 * @pcmid/dsh-todo-guard; the picker draws its own controls, and icons
 * reference the theme's shared icon sprite.
 */
window.__ModuleLoader__.load({
  id: '@pcmid/dsh-worktree-repos',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const { SettingsForm, SettingsFormModel, SettingsValueField } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } = React

    const NS = 'worktreeRepos'
    /** Settings namespace: the row id in cordis.patch.yml. */
    const ENTRY = 'worktree-repos'
    /** Key of this bundle's page in Plugins. */
    const PACKAGE = '@pcmid/dsh-worktree-repos'
    const PREFIX = 'dsh-wr'
    /** Connection RPC channel and endpoint prefix of the Host half's routes. */
    const HOST_CHANNEL = '/api'
    const HOST_API = 'pcmid/worktree-repos'
    /** Below this much room under the trigger, the list opens above it when there is more room there. */
    const MIN_ROOM_BELOW = 240

    const zh = {
      choose: '选择仓库',
      search: '搜索仓库',
      root: '留在工作区根目录',
      noMatch: '没有匹配的仓库',
      list: '仓库',
      pickerLabel: '仓库：{name}',
      chooseFailed: '无法切换仓库：{reason}',
      loadFailed: '无法读取仓库列表：{reason}',
      withdrawn: '换了仓库，之前勾选的工作树已取消',
      'error.busy': '会话正忙，请稍后再试',
      'error.not-found': '这个仓库已不在工作区里',
      'error.unavailable': '这个会话已经不能切换仓库',
      description: '工作区本身不是 Git 仓库时，新会话可以先选工作区里的一个仓库，再切出工作树。',
      depth: '扫描深度',
      depthHint: '在工作区下往里找几层目录。1 表示只找工作区的直接子目录。找到仓库后不再进入它的子目录。默认 1。',
      overridden: '已覆盖',
      reset: '恢复默认',
      invalidNumber: '请填写不小于 1 的整数；留空表示使用默认值。',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
    }
    const en = {
      choose: 'Choose repository',
      search: 'Search repositories',
      root: 'Stay in the workspace root',
      noMatch: 'No matching repositories',
      list: 'Repositories',
      pickerLabel: 'Repository: {name}',
      chooseFailed: 'Could not switch the repository: {reason}',
      loadFailed: 'Could not read the repositories: {reason}',
      withdrawn: 'The repository changed, so the worktree you had checked was cleared',
      'error.busy': 'The session is busy. Try again in a moment',
      'error.not-found': 'The repository is no longer in this workspace',
      'error.unavailable': 'This session can no longer change its repository',
      description: 'When a workspace is not a Git repository itself, a new session can pick one of its repositories and then cut a worktree.',
      depth: 'Scan depth',
      depthHint: 'How many directory levels under the workspace are searched. 1 searches only its direct subdirectories. A repository is not searched for repositories inside it. Default 1.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      invalidNumber: 'Enter a whole number of at least 1, or leave blank to use the default.',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
    }

    /* The trigger copies the 28px chip of Harness's worktree option beside it;
       the list copies Harness's menu material, rows, and separators. */
    const CSS = `
.${PREFIX}-trigger {
  display: inline-flex; flex: none; align-items: center; gap: 5px; min-width: 0; max-width: 220px;
  height: 28px; padding: 0 4px 0 8px; border: none; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; font-weight: 500; line-height: 20px; white-space: nowrap; cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}
.${PREFIX}-trigger[data-empty] { color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-trigger[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-hover); }
@media (hover: hover) { .${PREFIX}-trigger:hover:not([aria-busy="true"]) { background: var(--dsw-alias-interactive-bg-hover); } }
.${PREFIX}-trigger:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.${PREFIX}-trigger[aria-busy="true"] { color: var(--dsw-alias-label-dimmed); cursor: progress; }
.${PREFIX}-trigger > svg { flex: none; }
.${PREFIX}-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.${PREFIX}-code { font-family: var(--ds-font-family-code); font-size: 12.5px; font-weight: 400; }
.${PREFIX}-chevron { color: var(--dsw-alias-label-caption); transition: transform 160ms cubic-bezier(.2, 0, 0, 1); }
.${PREFIX}-trigger[aria-expanded="true"] .${PREFIX}-chevron { transform: rotate(180deg); }
.${PREFIX}-slash { flex: none; margin: 0 -1px; color: var(--dsw-alias-label-caption); font-size: 15px; font-weight: 300; line-height: 20px; user-select: none; }
.${PREFIX}-menu {
  position: fixed; z-index: 1100; box-sizing: border-box; display: flex; flex-direction: column;
  width: max-content; min-width: min(288px, calc(100vw - 24px)); max-width: min(380px, calc(100vw - 24px)); padding: 4px;
  border-radius: var(--dsw-radius-lg); background: var(--dsw-menu-surface-fill); backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); box-shadow: var(--dsw-elevation-prominent);
  animation: ${PREFIX}-in 140ms cubic-bezier(.2, 0, 0, 1);
}
.${PREFIX}-menu[data-side="top"] { animation-name: ${PREFIX}-in-up; }
@keyframes ${PREFIX}-in { from { opacity: 0; transform: translateY(-4px); } }
@keyframes ${PREFIX}-in-up { from { opacity: 0; transform: translateY(4px); } }
@media (prefers-reduced-motion: reduce) { .${PREFIX}-menu { animation: none; } }
.${PREFIX}-search {
  display: flex; flex: none; align-items: center; gap: 6px; height: 32px; margin: 0 0 4px; padding: 0 10px;
  border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-caption);
}
.${PREFIX}-search > svg { flex: none; }
.${PREFIX}-input {
  flex: 1; min-width: 0; height: 100%; padding: 0; border: none; outline: none; background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px;
}
.${PREFIX}-input::placeholder { color: var(--dsw-alias-label-caption); }
.${PREFIX}-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.${PREFIX}-item {
  display: flex; align-items: center; gap: 8px; min-height: 30px; padding: 4px 8px; border-radius: var(--dsw-radius-md);
  color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; cursor: pointer; user-select: none;
}
.${PREFIX}-item[data-active] { background: var(--dsw-alias-interactive-bg-hover); }
.${PREFIX}-item > svg { flex: none; color: var(--dsw-alias-menu-icon); }
.${PREFIX}-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${PREFIX}-hit { font-weight: 600; }
.${PREFIX}-meta {
  display: inline-flex; flex: none; align-items: center; gap: 3px; max-width: 140px; color: var(--dsw-alias-label-tertiary);
  font-family: var(--ds-font-family-code); font-size: 12px;
}
.${PREFIX}-meta > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${PREFIX}-meta > svg { flex: none; }
.${PREFIX}-check { flex: none; width: 14px; height: 14px; color: var(--dsw-alias-label-primary); }
.${PREFIX}-none { padding: 5px 8px; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }
.${PREFIX}-separator { flex: none; height: 0.5px; margin: 3px 8px; background: var(--dsw-alias-border-l2); }
@media (max-width: 600px) { .${PREFIX}-trigger { max-width: 104px; } }
`

    function fill(template, values) {
      return template.replace(/\{(\w+)\}/gu, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match)
    }

    /** Same comparison as the Host half: trailing separators are ignored. */
    function normalizePath(path) {
      const trimmed = path.replace(/[\\/]+$/u, '')
      return trimmed === '' || /^[A-Za-z]:$/u.test(trimmed) ? path : trimmed
    }

    function baseName(path) {
      const parts = normalizePath(path).split(/[\\/]/u)
      return parts.at(-1) || path
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

    /** A repository: a book with a spine and a ribbon, in the sprite's one-pixel stroke. */
    function RepoGlyph({ size = 14 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
      h('path', { d: 'M4.75 2.25h7.25a.75.75 0 0 1 .75.75v8.25H4.9a1.4 1.4 0 0 0 0 2.75h7.85' }),
      h('path', { d: 'M3.5 12.6V3.5c0-.69.56-1.25 1.25-1.25' }),
      h('path', { d: 'M6.25 2.25v4.5l1.25-.9 1.25.9v-4.5' }))
    }

    /** The name with the first match of the query in bold. */
    function Highlighted({ text, query }) {
      const at = query === '' ? -1 : text.toLowerCase().indexOf(query.toLowerCase())
      if (at < 0) return text
      return h(React.Fragment, null, text.slice(0, at), h('span', { className: `${PREFIX}-hit` }, text.slice(at, at + query.length)), text.slice(at + query.length))
    }

    /** The scan depth field: a whole number of at least 1, as the Host Config requires; empty clears it to the default. */
    const DEPTH_FIELD = {
      field: 'depth',
      format: value => typeof value === 'number' ? String(value) : '',
      parse: (text) => {
        const trimmed = text.trim()
        if (trimmed === '') return { kind: 'clear' }
        if (!/^\d+$/u.test(trimmed)) return undefined
        const value = Number(trimmed)
        return Number.isSafeInteger(value) && value >= 1 ? { kind: 'set', value } : undefined
      },
    }

    /** The plugin's page in Plugins: the scan depth. */
    function WorktreeReposSettings(props) {
      const { t } = props
      const state = props.useWorktreeReposForm(snapshot => snapshot)
      if (props.view === 'summary') return t('description')
      const labels = { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
      return h(SettingsForm, { labels, state, onSave: props.save, onDiscard: props.discard },
        h(SettingsValueField, {
          id: 'plugin-config-worktree-repos-depth',
          label: t('depth'),
          hint: t('depthHint'),
          overriddenLabel: t('overridden'),
          resetLabel: t('reset'),
          invalidLabel: t('invalidNumber'),
          numeric: true,
          disabled: !state.writable,
          ...state.depth,
          onEdit: (text) => { props.edit('depth', text) },
          onReset: () => { props.resetField('depth') },
        }))
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

        const scope = ctx.configForms.get(ENTRY)
        const model = new SettingsFormModel(scope, [DEPTH_FIELD])
        const formStore = model.bind(() => ({ ...model.shell(), depth: model.field('depth') }))
        ctx.effect(() => () => { model.dispose() }, 'worktree-repos: settings form')
        ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: PACKAGE, locale: NS,
          inject: () => ({ hooks: { worktreeReposForm: formStore }, ...model.actions() }),
        }, WorktreeReposSettings))), 'worktree-repos: plugin page section')

        const subscribeDepth = listener => scope.subscribe(listener)
        const readDepth = () => scope.getSnapshot().value?.depth

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

        /**
         * Where the list opens: under the trigger with right edges aligned, or
         * above it when the room below is short and the room above is larger.
         */
        function placement(anchor) {
          const rect = anchor.getBoundingClientRect()
          const below = window.innerHeight - rect.bottom - 16
          const above = rect.top - 16
          const right = Math.max(12, window.innerWidth - rect.right)
          return below < MIN_ROOM_BELOW && above > below
            ? { side: 'top', style: { bottom: window.innerHeight - rect.top + 4, right, maxHeight: above } }
            : { side: 'bottom', style: { top: rect.bottom + 4, right, maxHeight: below } }
        }

        /**
         * The open list: a search field, the matching repositories, and the
         * workspace root pinned last. The field keeps focus; arrows move the
         * highlighted row, Enter picks it, Escape closes, Tab closes and moves
         * on from the trigger. A click outside, a page scroll, a resize, or
         * leaving the window closes it.
         */
        function RepoMenu({ anchor, state, selected, pick, close }) {
          const card = useRef(null)
          const input = useRef(null)
          const id = useId()
          const [query, setQuery] = useState('')
          const [where] = useState(() => placement(anchor))
          const matches = state.repositories.filter(repository => repository.name.toLowerCase().includes(query.trim().toLowerCase()))
          const options = [...matches.map(repository => ({ key: repository.path, path: repository.path, repository })), { key: 'root', path: null }]
          // -1 highlights nothing: a search without matches does not fall through to the workspace root.
          const [active, setActive] = useState(() => Math.max(0, options.findIndex(option => option.path === (selected?.path ?? null))))
          const current = Math.min(active, options.length - 1)
          const optionId = index => `${id}-option-${index}`

          useEffect(() => {
            input.current?.focus()
            const outside = (event) => {
              if (!card.current?.contains(event.target) && !anchor.contains(event.target)) close(false)
            }
            // The list is placed once, so moving the page under it closes it; scrolling the list itself does not.
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
          useLayoutEffect(() => {
            if (current >= 0) document.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' })
          }, [current])

          const keyDown = (event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const from = current < 0 && event.key === 'ArrowUp' ? 0 : current
              setActive((from + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
            } else if (event.key === 'Enter') {
              event.preventDefault()
              if (current >= 0) pick(options[current].path)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              close(true)
            } else if (event.key === 'Tab') {
              // Focus returns to the trigger first, so Tab goes on to the control after it.
              close(true)
            }
          }
          const row = (option, index, content) => h('div', {
            key: option.key,
            id: optionId(index),
            role: 'option',
            'aria-selected': index === current,
            'data-active': index === current ? '' : undefined,
            className: `${PREFIX}-item`,
            onPointerMove: () => { if (index !== current) setActive(index) },
            onPointerDown: (event) => { event.preventDefault() },
            onClick: () => { pick(option.path) },
          }, ...content, option.path === (selected?.path ?? null)
            ? h(Glyph, { name: 'check-outline', size: 14, className: `${PREFIX}-check` })
            : h('span', { className: `${PREFIX}-check` }))

          return ReactDOM.createPortal(h('div', {
            ref: card,
            className: `${PREFIX}-menu`,
            'data-side': where.side,
            'data-menu-material': '',
            style: where.style,
          },
          h('label', { className: `${PREFIX}-search` },
            h(Glyph, { name: 'search-outline', size: 14 }),
            h('input', {
              ref: input,
              className: `${PREFIX}-input`,
              type: 'text',
              role: 'combobox',
              'aria-expanded': true,
              'aria-controls': `${id}-list`,
              'aria-activedescendant': current >= 0 ? optionId(current) : undefined,
              'aria-autocomplete': 'list',
              'aria-label': t('search'),
              placeholder: t('search'),
              spellCheck: false,
              autoComplete: 'off',
              value: query,
              onChange: (event) => {
                const next = event.target.value
                setQuery(next)
                setActive(state.repositories.some(repository => repository.name.toLowerCase().includes(next.trim().toLowerCase())) ? 0 : -1)
              },
              onKeyDown: keyDown,
            })),
          h('div', { id: `${id}-list`, role: 'listbox', 'aria-label': t('list'), className: `${PREFIX}-list` },
            matches.length === 0
              ? h('div', { className: `${PREFIX}-none`, role: 'presentation' }, t('noMatch'))
              : matches.map((repository, index) => row(options[index], index, [
                h(RepoGlyph, { key: 'glyph' }),
                h('span', { key: 'name', className: `${PREFIX}-name ${PREFIX}-code`, title: repository.name }, h(Highlighted, { text: repository.name, query: query.trim() })),
                repository.branch === null ? null : h('span', { key: 'branch', className: `${PREFIX}-meta` }, h(Glyph, { name: 'branch-outline', size: 12 }), h('span', null, repository.branch)),
              ])),
            h('div', { className: `${PREFIX}-separator`, role: 'separator' }),
            row(options.at(-1), options.length - 1, [
              h(Glyph, { key: 'glyph', name: 'folder-open', size: 14 }),
              h('span', { key: 'name', className: `${PREFIX}-name` }, t('root')),
              h('span', { key: 'meta', className: `${PREFIX}-meta` }, h('span', null, baseName(state.workspace))),
            ])),
          ), document.body)
        }

        /** The repository picker of one new session; nothing while the Host says it does not apply. */
        function RepoPicker({ sessionId }) {
          const depth = useSyncExternalStore(subscribeDepth, readDepth)
          const [state, setState] = useState(null)
          const [busy, setBusy] = useState(false)
          const [open, setOpen] = useState(false)
          const trigger = useRef(null)
          useEffect(() => {
            let live = true
            callHost('repositories', { sessionId }).then(
              (value) => { if (live) setState(value) },
              () => { if (live) setState(null) },
            )
            return () => { live = false }
          }, [sessionId, depth])

          if (state === null) return null
          const current = normalizePath(state.current)
          const selected = state.repositories.find(repository => normalizePath(repository.path) === current)

          /** Opening scans again, so a repository cloned meanwhile shows up. */
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

          const label = selected?.name ?? t('choose')
          return h(React.Fragment, null,
            h('button', {
              ref: trigger,
              type: 'button',
              className: `${PREFIX}-trigger`,
              'data-empty': selected === undefined ? '' : undefined,
              'aria-haspopup': 'listbox',
              'aria-expanded': open,
              'aria-label': fill(t('pickerLabel'), { name: label }),
              // Busy keeps focus on the trigger, which a disabled button would drop.
              'aria-busy': busy,
              title: selected?.name,
              onClick: () => { void show() },
            },
            h(RepoGlyph, { size: 14 }),
            h('span', { className: `${PREFIX}-label${selected === undefined ? '' : ` ${PREFIX}-code`}` }, label),
            h(Glyph, { name: 'chevron-down-outline', size: 12, className: `${PREFIX}-chevron` })),
            // The branch control Harness shows after a repository reads as the path's next segment.
            selected === undefined ? null : h('span', { className: `${PREFIX}-slash`, 'aria-hidden': true }, '/'),
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
