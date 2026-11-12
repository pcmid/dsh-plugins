/**
 * Browser half of @pcmid/dsh-workspace-agent-preset: an "Agent preset" entry
 * in the workspace menu (right-click on a workspace header, or its "…"
 * button). Its submenu lists the roster; the workspace's choice carries a
 * trailing check, and "Global default" clears it.
 *
 * The choice is the Host row's volatile `workspaces` Config, written through
 * the shared configuration form. When the new-session screen shows a blank
 * session of that workspace, the choice is applied to it right away, as the
 * Models page does for the global default.
 */
window.__ModuleLoader__.load({
  id: '@pcmid/dsh-workspace-agent-preset',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'workspaceAgentPreset'
    /** Settings namespace: the row id in cordis.patch.yml. */
    const ENTRY = 'workspace-agent-preset'
    /** The preset registry's settings namespace; its updates move the global default. */
    const REGISTRY_NS = 'agent-preset-registry'
    /** Harness dictionary carrying the shipped presets' names. */
    const PRESET_NS = 'settings.agentPreset'
    const PREFIX = 'dsh-wap'
    const ICONS = {
      agent: `${ENTRY}.agent`,
      checked: `${ENTRY}.checked`,
      unchecked: `${ENTRY}.unchecked`,
    }
    /** Shipped presets publish no name; Harness dictionaries carry it under these keys. */
    const BUILT_IN_NAMES = {
      standard: 'presetStandardName',
      ptc: 'presetPtcName',
      minimal: 'presetMinimalName',
      cordis: 'presetCordisName',
    }
    /** Shipped presets Harness hides while Developer tools are off. */
    const CODING_TOOL_PRESETS = new Set(['ptc', 'minimal'])
    /** How long a first opening waits for the roster before showing "Loading". */
    const ROSTER_WAIT_MS = 700
    /** A roster read this recent is reused without a background refresh. */
    const ROSTER_FRESH_MS = 3000

    const zh = {
      menu: 'Agent 预设',
      useDefault: '跟随全局默认',
      useDefaultNamed: '跟随全局默认（{preset}）',
      loading: '正在读取预设…',
      loadFailed: '无法读取预设列表',
      unavailable: '{preset}（不可用）',
      saved: '「{workspace}」中的新会话将使用{preset}',
      savedDefault: '「{workspace}」中的新会话将跟随全局默认',
      saveFailed: '无法保存工作区的 Agent 预设',
      blankSyncFailed: '已保存，但当前的新会话没有切换：{reason}',
    }
    const en = {
      menu: 'Agent preset',
      useDefault: 'Global default',
      useDefaultNamed: 'Global default ({preset})',
      loading: 'Loading presets…',
      loadFailed: 'Could not read the presets',
      unavailable: '{preset} (unavailable)',
      saved: 'New sessions in {workspace} will use {preset}',
      savedDefault: 'New sessions in {workspace} will use the global default',
      saveFailed: 'Could not save the workspace agent preset',
      blankSyncFailed: 'Saved, but the current new session did not switch: {reason}',
    }

    /* The menu draws a data action's icon before its label. The marks move
       their own icon cell after the label, where Harness menus put the check
       of a selected row; without :has() support they stay in front. */
    const CSS = `
[role="menuitem"] > span:has(> .${PREFIX}-mark) { order: 1; color: var(--dsw-alias-label-primary); }
.${PREFIX}-mark { display: block; flex: none; width: 14px; height: 14px; }
`

    function fill(template, values) {
      return template.replace(/\{(\w+)\}/gu, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match)
    }

    /** Read another plugin's dictionary, falling back when it does not carry the key. */
    function hostText(t, key, fallback) {
      try {
        const text = t(key)
        return typeof text === 'string' && text !== '' && text !== key ? text : fallback
      } catch {
        return fallback
      }
    }

    /** Same comparison as the Host half: trailing separators are ignored. */
    function normalizePath(path) {
      const trimmed = path.replace(/[\\/]+$/u, '')
      return trimmed === '' || /^[A-Za-z]:$/u.test(trimmed) ? path : trimmed
    }

    /** @returns the stored key and preset configured for one directory, if any. */
    function lookup(workspaces, path) {
      if (workspaces === null || typeof workspaces !== 'object' || Array.isArray(workspaces)) return undefined
      const wanted = normalizePath(path)
      for (const [key, preset] of Object.entries(workspaces)) {
        if (typeof preset === 'string' && preset !== '' && normalizePath(key) === wanted) return { key, preset }
      }
      return undefined
    }

    function requiresCodingTools(preset) {
      return preset.name === undefined && CODING_TOOL_PRESETS.has(preset.id)
    }

    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set(next) {
          snapshot = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    function svg(className, children) {
      return h('svg', {
        className, width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1, 'aria-hidden': true,
      }, children)
    }

    /** Harness's agent-preset glyph, so the row matches the preset chip. */
    function AgentIcon() {
      return svg(undefined, [
        h('path', { key: 'a', fill: 'currentColor', d: 'M6.51867 12.3282C7.29816 12.6011 8.16475 12.6514 9.02269 12.4216C9.57879 12.2726 10.0784 12.0185 10.5087 11.6888C10.7819 12.0555 11.1606 12.3304 11.5913 12.4805C10.9688 13.029 10.2149 13.4478 9.35911 13.6771C8.13946 14.0038 6.90632 13.8971 5.82126 13.4533C6.15821 13.1562 6.4021 12.7652 6.51867 12.3282ZM9.17629 2.89409C11.1101 3.34433 12.739 4.81872 13.2889 6.87043C13.4219 7.3665 13.4811 7.8649 13.4774 8.35466C13.0924 8.13213 12.6422 8.01837 12.1741 8.05276L12.1711 8.05257C12.1539 7.77199 12.109 7.48889 12.0334 7.20684C11.6363 5.72533 10.5048 4.6372 9.13549 4.22844C9.25559 3.87667 9.29214 3.49087 9.22309 3.09892C9.2108 3.02922 9.19451 2.96108 9.17629 2.89409ZM4.7311 3.89107L4.78302 4.11879C4.87648 4.4488 5.04146 4.74263 5.25579 4.98896C3.98078 6.01355 3.35848 7.72904 3.8089 9.41059C3.81828 9.44559 3.82866 9.48025 3.83885 9.51479C3.38217 9.61268 2.98548 9.84137 2.68107 10.1556C2.63414 10.022 2.5897 9.88632 2.55244 9.74726C1.93301 7.43489 2.86717 5.07173 4.71504 3.76697L4.7311 3.89107Z' }),
        h('circle', { key: 'b', cx: 7.99, cy: 3.68, r: 1.6, stroke: 'currentColor' }),
        h('circle', { key: 'c', cx: 3.94, cy: 11.34, r: 1.6, stroke: 'currentColor' }),
        h('circle', { key: 'd', cx: 12.09, cy: 11.34, r: 1.6, stroke: 'currentColor' }),
      ])
    }

    /** The trailing check of the workspace's choice, in Harness's check glyph. */
    function CheckedMark() {
      return svg(`${PREFIX}-mark`, h('path', {
        stroke: 'currentColor',
        d: 'M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4',
      }))
    }

    /** Keeps unchecked rows' labels aligned with the checked one. */
    function UncheckedMark() {
      return h('span', { className: `${PREFIX}-mark` })
    }

    return {
      inject: ['slots', 'locale', 'sessions', 'remote', 'remote.agentPresets', 'configForms', 'contextMenus'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        const presetT = ctx.locale.bind(PRESET_NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'workspace-agent-preset: dictionaries')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = ENTRY
          style.textContent = CSS
          document.head.append(style)
          return () => { style.remove() }
        }, 'workspace-agent-preset: check placement')

        const form = ctx.configForms.get(ENTRY)
        const developerTools = ctx.configForms.developerTools.enabled
        const roster = createStore({ status: 'idle', presets: [] })
        let generation = 0
        let loadedAt = 0
        let disposed = false

        /** Latest read wins; a failed read keeps the last good roster. */
        const loadRoster = async () => {
          const mine = ++generation
          let response
          try {
            response = await ctx.remote.agentPresets.list()
          } catch {
            response = { ok: false }
          }
          if (disposed || mine !== generation) return
          loadedAt = Date.now()
          const previous = roster.getSnapshot()
          if (response.ok) {
            const presets = response.value.presets
            if (previous.status !== 'ready' || JSON.stringify(previous.presets) !== JSON.stringify(presets)) {
              roster.set({ status: 'ready', presets })
            }
          } else if (previous.status !== 'ready') {
            roster.set({ status: 'error', presets: [] })
          }
        }

        /** A first opening waits briefly; later openings show the cached roster and refresh behind it. */
        const rosterReady = async () => {
          const { status } = roster.getSnapshot()
          if (status === 'ready') {
            if (Date.now() - loadedAt > ROSTER_FRESH_MS) void loadRoster()
            return
          }
          let timer
          await Promise.race([
            loadRoster(),
            new Promise((resolve) => { timer = setTimeout(resolve, ROSTER_WAIT_MS) }),
          ])
          clearTimeout(timer)
        }

        ctx.effect(() => {
          const disposers = [
            ctx.remote.$on('settings/document-updated', (ns) => { if (ns === REGISTRY_NS) void loadRoster() }),
            ctx.on('connection/reset', () => { void loadRoster() }),
          ]
          return () => {
            disposed = true
            for (const dispose of disposers) dispose()
          }
        }, 'workspace-agent-preset: roster invalidations')

        const presetLabel = (preset) => {
          const key = preset.name === undefined ? BUILT_IN_NAMES[preset.id] : undefined
          return key === undefined ? preset.name ?? preset.id : hostText(presetT, key, preset.id)
        }

        /** Hand the new choice to the blank session the new-session screen shows for this workspace. */
        const syncBlank = async (path, presetId) => {
          const wanted = normalizePath(path)
          const blank = Object.values(ctx.sessions.list.getSnapshot().byId).find(session => session.blank
            && (session.retainedBy?.mainView ?? 0) > 0
            && typeof session.cwd === 'string' && normalizePath(session.cwd) === wanted)
          if (blank === undefined || blank.projectionValues?.agentPreset === presetId) return undefined
          try {
            const result = await ctx.remote.agentPresets.select(blank.id, presetId)
            if (result.ok) return undefined
            const reason = result.error?.details?.reason
            return typeof reason === 'string' ? reason : result.error?.message ?? ''
          } catch (error) {
            return error instanceof Error ? error.message : String(error)
          }
        }

        /**
         * Store one workspace's choice (or clear it), then report it.
         * @param target - the captured workspace.
         * @param entry - the stored entry when the menu opened.
         * @param preset - the chosen roster row; undefined clears the choice.
         * @param fallback - the global default row, for the blank-session sync.
         */
        const choose = async ({ path, displayTitle }, entry, preset, fallback) => {
          const ops = []
          if (entry !== undefined && entry.key !== path) ops.push({ op: 'unset', path: ['workspaces', entry.key] })
          if (preset !== undefined) {
            if (entry === undefined || entry.key !== path || entry.preset !== preset.id) {
              ops.push({ op: 'set', path: ['workspaces', path], value: preset.id })
            }
          } else if (entry !== undefined && entry.key === path) {
            ops.push({ op: 'unset', path: ['workspaces', path] })
          }
          if (ops.length > 0 && !(await form.mutate(ops))) throw new Error(t('saveFailed'))
          const effective = preset ?? fallback
          const reason = effective === undefined ? undefined : await syncBlank(path, effective.id)
          if (reason !== undefined) {
            ctx.contextMenus.notify(fill(t('blankSyncFailed'), { reason }), false)
            return
          }
          ctx.contextMenus.notify(preset === undefined
            ? fill(t('savedDefault'), { workspace: displayTitle })
            : fill(t('saved'), { workspace: displayTitle, preset: presetLabel(preset) }), true)
        }

        const mark = checked => ({ key: checked ? ICONS.checked : ICONS.unchecked })

        /** @returns the "Agent preset" row and its submenu for one workspace. */
        const action = (target) => {
          const snapshot = form.getSnapshot()
          const entry = lookup(snapshot.value?.workspaces, target.path)
          const chosen = entry?.preset
          const disabled = !(snapshot.status === 'ready' && snapshot.writable)
          const { status, presets } = roster.getSnapshot()
          const parent = { id: 'agent-preset', label: t('menu'), icon: { key: ICONS.agent } }
          if (status !== 'ready') {
            return { ...parent, children: [{ id: 'status', label: t(status === 'error' ? 'loadFailed' : 'loading'), disabled: true }] }
          }
          const usable = presets.filter(preset => preset.broken === undefined)
          const tools = developerTools.getSnapshot()
          const shown = usable.filter(preset => tools || !requiresCodingTools(preset) || preset.id === chosen)
          const fallback = usable.find(preset => preset.isDefault)
          const failureLabel = t('saveFailed')
          const children = [
            {
              id: 'default',
              label: fallback === undefined ? t('useDefault') : fill(t('useDefaultNamed'), { preset: presetLabel(fallback) }),
              icon: mark(chosen === undefined),
              disabled,
              failureLabel,
              run: () => choose(target, entry, undefined, fallback),
            },
            ...shown.map((preset, index) => ({
              id: `preset.${preset.id}`,
              label: presetLabel(preset),
              icon: mark(preset.id === chosen),
              separatorBefore: index === 0,
              disabled,
              failureLabel,
              run: () => choose(target, entry, preset, fallback),
            })),
          ]
          if (chosen !== undefined && !shown.some(preset => preset.id === chosen)) {
            const known = presets.find(preset => preset.id === chosen)
            children.push({
              id: 'unavailable',
              label: fill(t('unavailable'), { preset: known === undefined ? chosen : presetLabel(known) }),
              icon: mark(true),
              separatorBefore: shown.length === 0,
              disabled: true,
            })
          }
          return { ...parent, children }
        }

        ctx.slots.inject('contextMenu.icon', function* () {
          yield ctx.slots.register({ name: 'contextMenu.icon', key: ICONS.agent }, AgentIcon)
          yield ctx.slots.register({ name: 'contextMenu.icon', key: ICONS.checked }, CheckedMark)
          yield ctx.slots.register({ name: 'contextMenu.icon', key: ICONS.unchecked }, UncheckedMark)
        })

        // Present only while the Host serves the row: without it, a choice would change nothing.
        ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => {
          void loadRoster()
          return ctx.contextMenus.register({
            id: ENTRY,
            target: 'workspace',
            // After "Show in Finder" (200), before the separated "Delete" (300).
            order: 250,
            observe: () => [form, roster, developerTools],
            resolve: async (target, signal) => {
              await rosterReady()
              signal.throwIfAborted()
              return [action(target)]
            },
          })
        }), 'workspace-agent-preset: workspace menu')
      },
    }
  },
})
