/**
 * Browser half of @pcmid/dsh-web-search-native: the search provider's page on
 * the Plugins page, which replaces the shipped web search page.
 *
 * The page is the shipped one — a search provider menu, a fetch provider menu,
 * and one save — plus each provider's search model under the search menu, a
 * seat the shipped page cannot offer because it keeps provider settings in
 * their own plugins. It registers under the shipped page's slot id at a lower
 * priority, so disabling this bundle restores the shipped page. The two menus
 * write the `web` namespace; the search models write this bundle's own entry.
 */
window.__ModuleLoader__.load({
  id: '@pcmid/dsh-web-search-native',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useId, useRef, useState } = React

    const NS = 'settings.nativeSearch'
    /** Sections under a plugin detail page's own content. */
    const DETAIL_SLOT = 'plugins.detail.section'
    /** This section's own cell key; a fresh id adds beside other contributions. */
    const SLOT_ID = 'native-search'
    /** The shipped plugin whose page hosts this section; it owns the provider menus. */
    const HOSTED_ITEM = 'web-search'
    /** This bundle's entry id, which holds the search channel. */
    const ENTRY = 'web-search-native'
    /** Route protocols whose providers can run native search. */
    const SUPPORTED_APIS = new Set(['anthropic-messages', 'openai-responses'])
    /** Config field holding the pinned channel's provider. */
    const CHANNEL_PROVIDER = 'searchProvider'
    /** The route protocol whose providers also choose a request form. */
    const RESPONSES_API = 'openai-responses'
    const PREFIX = 'dsh-native-search'
    /** How long a saved notice stays on screen. */
    const SAVED_MS = 1600

    const zh = {
      channelLabel: '搜索渠道',
      missing: '{id}（未加载）',
      channelAria: '搜索渠道',
      follow: '跟随会话',
      modelLabel: '模型',
      effortLabel: '思考等级',
      transportLabel: '接口',
      chooseModel: '选择模型',
      effortDefault: '默认',
      modelUnavailable: '{model}（不可用）',
      transportAuto: '自动',
      transportAlpha: 'Alpha Search',
      transportResponses: 'Responses',
      modelsFailed: '无法读取模型列表',
      retry: '重试',
      readOnly: '本部署的设置为只读。',
      saving: '保存中…',
      saved: '已保存',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      transportAria: '{provider}的接口',
      effortAria: '{provider}的思考等级',
      modelAria: '{provider}的搜索模型',
    }
    const en = {
      channelLabel: 'Search channel',
      missing: '{id} (not loaded)',
      channelAria: 'Search channel',
      follow: 'Follow session',
      modelLabel: 'Model',
      effortLabel: 'Reasoning effort',
      transportLabel: 'Interface',
      chooseModel: 'Choose a model',
      effortDefault: 'Default',
      modelUnavailable: '{model} (unavailable)',
      transportAuto: 'Automatic',
      transportAlpha: 'Alpha Search',
      transportResponses: 'Responses',
      modelsFailed: 'Couldn\u2019t load the model list.',
      retry: 'Retry',
      readOnly: 'This deployment stores settings read-only.',
      saving: 'Saving\u2026',
      saved: 'Saved',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      transportAria: 'Interface for {provider}',
      effortAria: 'Reasoning effort for {provider}',
      modelAria: 'Search model for {provider}',
    }

    const CHEVRON = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")"
    const CSS = `
/* Under the shipped page's content: one hairline above, then the channel field. */
.${PREFIX} { display: flex; flex-direction: column; padding-top: 20px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.${PREFIX}-field { display: flex; flex-direction: column; gap: 6px; }
.${PREFIX}-notice { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-failure { color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-trigger { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; height: 34px; padding: 0 30px 0 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md, 8px); background-color: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2)); background-image: ${CHEVRON}; background-repeat: no-repeat; background-position: right 10px center; background-size: 12px 12px; font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); text-align: start; cursor: pointer; anchor-name: var(--${PREFIX}-anchor); }
.${PREFIX}-trigger:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }
.${PREFIX}-trigger:disabled { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); cursor: default; }
@media (hover: hover) { .${PREFIX}-trigger:hover:not(:disabled) { background-color: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); } }
.${PREFIX}-triggerText { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${PREFIX}-menu { box-sizing: border-box; position: fixed; position-anchor: var(--${PREFIX}-anchor); inset: auto; top: calc(anchor(bottom) + 4px); left: anchor(left); position-try-fallbacks: flip-block; margin: 0; width: max-content; min-width: anchor-size(width); max-width: min(360px, calc(100vw - 24px)); max-height: min(320px, calc(100vh - 24px)); overflow-y: auto; padding: 4px; border: 0; border-radius: var(--dsw-radius-lg, 10px); background: linear-gradient(var(--dsw-menu-surface-fill, transparent), var(--dsw-menu-surface-fill, transparent)), var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay)); box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgb(0 0 0 / 0.24)); color: var(--dsw-alias-label-primary); }
.${PREFIX}-menu:popover-open { animation: ${PREFIX}-fade 100ms ease-out; }
.${PREFIX}-option { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 30px; padding: 4px 8px; border-radius: var(--dsw-radius-md, 8px); font-size: 13px; line-height: 20px; white-space: nowrap; cursor: pointer; outline: none; }
.${PREFIX}-option:focus-visible, .${PREFIX}-option:focus { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1)); }
@media (hover: hover) { .${PREFIX}-option:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1)); } }
.${PREFIX}-check { flex: none; width: 14px; height: 14px; }
/* Fields follow the Models page: a 12px label above a full-width control, with
   a hairline between them, so nothing here is boxed inside anything else. */
.${PREFIX}-fieldtitle { display: block; margin: 0; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-fields { display: flex; flex-direction: column; }
.${PREFIX}-fieldrow { display: flex; flex-direction: column; gap: 6px; padding: 12px 0 0; }
.${PREFIX}-fieldrow + .${PREFIX}-fieldrow { margin-top: 4px; border-top: 0.5px solid var(--dsw-alias-border-l1); }
.${PREFIX}-fieldlabel { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-fieldcontrol { min-width: 0; }
.${PREFIX}-status { margin: 10px 0 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-status[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-button { flex: none; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 6px); padding: 3px 9px; background: transparent; font: inherit; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-primary); cursor: pointer; }

@keyframes ${PREFIX}-fade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .${PREFIX}-menu:popover-open { animation: none; } }
`

    function fill(template, name, value) {
      return template.replace(`{${name}}`, () => value)
    }

    function safeId(raw) {
      return raw.replace(/[^a-zA-Z0-9_-]/g, '')
    }

    /** Walk a settings value along a provider's `settingsPath`. */
    function atPath(value, path) {
      let node = value
      for (const key of path) {
        if (typeof node !== 'object' || node === null) return undefined
        node = node[key]
      }
      return node
    }

    /** Which providers run native search, and with which protocol. */
    function supportedApis(directory, valueOf) {
      const rows = new Map()
      for (const entry of directory) {
        const value = valueOf(entry.settingsNs)
        if (value === undefined) continue
        const profile = entry.settingsPath.length === 0 ? value : atPath(value, entry.settingsPath)
        const api = typeof profile === 'object' && profile !== null ? profile.api : undefined
        if (typeof api === 'string' && SUPPORTED_APIS.has(api)) rows.set(entry.provider, api)
      }
      return rows
    }

    /**
     * The section state: the search channel staged over this bundle's entry and
     * the one save that writes it. The provider menus above belong to the
     * shipped page and are not read or written here. Following the conversation
     * is the empty channel; a pinned channel keeps the model, effort, and
     * interface chosen with it, so going back to it restores them. Leaving the
     * page drops every staged edit.
     */
    function createController(ctx) {
      const own = ctx.configForms.get(ENTRY)
      /** The staged channel, undefined until the stored values are readable. */
      let channel
      let write = { saving: false, failed: false, saved: false }
      let served = false
      let requested = false
      let generation = 0
      let savedTimer
      let disposed = false
      const listeners = new Set()
      const models = { status: 'idle', groups: [], generation: 0 }
      const directory = { status: 'idle', rows: [], generation: 0 }

      /**
       * This bundle's stored search channel.
       * @returns whether it follows the conversation, and the pinned provider,
       * model, effort, and interface.
       */
      const storedChannel = () => {
        const value = own.getSnapshot().value ?? {}
        return {
          follow: value.followSession !== false,
          provider: value.searchProvider ?? '',
          model: value.searchModel ?? '',
          effort: value.searchReasoningEffort ?? '',
          transport: value.searchTransport ?? 'auto',
        }
      }

      /** The staged channel, seeded from the stored one the first time it is readable. */
      const stagedChannel = () => {
        channel ??= storedChannel()
        return channel
      }

      const projection = () => {
        const saved = storedChannel()
        const picking = stagedChannel()
        return {
          served,
          readOnly: !own.getSnapshot().writable,
          write: { ...write },
          dirty: JSON.stringify(picking) !== JSON.stringify(saved),
          modelsFailed: models.status === 'error',
          modelsLoading: models.status === 'idle' || models.status === 'loading',
          groups: models.groups,
          // The providers a channel can name, which the shipped page above already lists.
          apis: supportedApis(directory.rows, ns => ctx.configForms.get(ns).getSnapshot().value),
          channel: picking,
        }
      }

      let snapshot = projection()
      const publish = () => {
        if (disposed) return
        snapshot = projection()
        for (const listener of [...listeners]) listener()
      }
      const unsubscribe = [own.subscribe(publish)]

      /**
       * Latest read wins per resource; a failed read keeps what the last good
       * one showed and is reported.
       */
      const read = async (resource, call, accept) => {
        const current = ++resource.generation
        resource.status = 'loading'
        publish()
        let response
        try {
          response = await call()
        } catch {
          response = { ok: false }
        }
        if (disposed || current !== resource.generation) return
        if (response.ok) {
          accept(response.value)
          resource.status = 'ready'
        } else {
          resource.status = 'error'
        }
        publish()
      }

      const loadModels = () => read(models,
        () => ctx.remote.session.modelCatalog(),
        value => { models.groups = value.groups })
      const loadDirectory = () => read(directory,
        () => ctx.remote.llm.listConfigurableProviders(),
        value => { directory.rows = value })

      const load = () => {
        loadModels()
        loadDirectory()
      }

      const reset = () => {
        channel = undefined
        write = { saving: false, failed: false, saved: false }
        publish()
      }

      /**
       * The staged channel as operations against the stored one. Following the
       * conversation clears the pinned fields, so a later pin starts from the
       * deployment default rather than resurrecting what this save removed.
       */
      const channelOps = () => {
        const saved = storedChannel()
        const next = stagedChannel()
        if (JSON.stringify(next) === JSON.stringify(saved)) return []
        if (next.follow) {
          return ['followSession', CHANNEL_PROVIDER, 'searchModel', 'searchReasoningEffort', 'searchTransport']
            .filter(field => own.getSnapshot().user?.[field] !== undefined || own.getSnapshot().value?.[field] !== undefined)
            .map(field => ({ op: 'unset', path: [field] }))
        }
        return [
          { op: 'set', path: ['followSession'], value: false },
          { op: 'set', path: [CHANNEL_PROVIDER], value: next.provider },
          { op: 'set', path: ['searchModel'], value: next.model },
          ...next.effort === '' ? [{ op: 'unset', path: ['searchReasoningEffort'] }] : [{ op: 'set', path: ['searchReasoningEffort'], value: next.effort }],
          ...next.transport === 'auto' ? [{ op: 'unset', path: ['searchTransport'] }] : [{ op: 'set', path: ['searchTransport'], value: next.transport }],
        ]
      }

      /**
       * Whether the staged channel can be stored as it is: following the
       * conversation always can, a pinned channel once its model is chosen.
       */
      const complete = () => {
        const next = stagedChannel()
        return next.follow || (next.provider !== '' && next.model !== '')
      }

      /** A choice made while a save is running, written once that save settles. */
      let queued = false

      /** Store each complete choice as soon as it is made; the section has no save button. */
      const commit = () => {
        publish()
        if (!complete()) return
        if (write.saving) {
          queued = true
          return
        }
        void save()
      }

      const save = async () => {
        if (write.saving) return
        clearTimeout(savedTimer)
        write = { saving: true, failed: false, saved: false }
        publish()
        const ops = channelOps()
        let ok = true
        if (ops.length > 0) {
          try {
            ok = await own.mutate(ops) !== false
          } catch {
            ok = false
          }
        }
        if (disposed) return
        write = { saving: false, failed: !ok, saved: ok }
        if (queued) {
          // A later choice supersedes this one: write it rather than resetting the draft.
          queued = false
          publish()
          void save()
          return
        }
        // A rejected write keeps its draft so the person can correct it.
        if (ok) channel = undefined
        publish()
        if (ok) {
          savedTimer = setTimeout(() => {
            write = { ...write, saved: false }
            publish()
          }, SAVED_MS)
        }
      }

      return {
        face: {
          hooks: {
            nativeSearchChannel: {
              getSnapshot: () => snapshot,
              subscribe(listener) {
                listeners.add(listener)
                if (!requested) {
                  requested = true
                  load()
                }
                return () => { listeners.delete(listener) }
              },
            },
          },
          retry() { load() },
          /**
           * Choose the search channel: following the conversation, or one
           * provider whose model, effort, and interface then apply everywhere.
           * @param provider - provider id, or the empty string to follow.
           */
          pickChannel(provider) {
            if (snapshot.readOnly) return
            const before = stagedChannel()
            if (provider === '') {
              channel = { ...before, follow: true, provider: '' }
            } else {
              // A different provider starts from its first model; the same one keeps what was chosen.
              const kept = before.provider === provider ? before : { ...before, model: '', effort: '', transport: 'auto' }
              channel = { ...kept, follow: false, provider }
            }
            commit()
          },
          /** Choose the pinned channel's model; the effort follows the model's own list. */
          pickModel(model) {
            if (snapshot.readOnly) return
            const before = stagedChannel()
            channel = { ...before, model, ...before.model === model ? {} : { effort: '' } }
            commit()
          },
          pickEffort(effort) {
            if (snapshot.readOnly) return
            channel = { ...stagedChannel(), effort }
            commit()
          },
          pickTransport(transport) {
            if (snapshot.readOnly) return
            channel = { ...stagedChannel(), transport }
            commit()
          },
          discard() { reset() },
        },
        /** Follow whether the Host serves both namespaces this page edits. */
        setServed(next) {
          if (served === next) return
          served = next
          publish()
          if (next && !requested) {
            requested = true
            load()
          }
        },
        dispose() {
          disposed = true
          generation += 1
          clearTimeout(savedTimer)
          for (const off of unsubscribe) off()
          listeners.clear()
        },
      }
    }

    /** A listbox in a light-dismiss popover; the platform handles outside clicks, Esc, and focus return. */
    function Dropdown({ label, valueLabel, options, selected, disabled, onSelect }) {
      const id = safeId(useId())
      const list = useRef(null)
      const [open, setOpen] = useState(false)
      useEffect(() => {
        const element = list.current
        if (element === null) return undefined
        const onToggle = (event) => {
          const next = event.newState === 'open'
          setOpen(next)
          if (next) (element.querySelector('[aria-selected="true"]') ?? element.querySelector('[role="option"]'))?.focus()
        }
        element.addEventListener('toggle', onToggle)
        return () => { element.removeEventListener('toggle', onToggle) }
      }, [])
      const choose = (value) => {
        list.current?.hidePopover()
        if (value !== selected) onSelect(value)
      }
      const onListKey = (event) => {
        const choices = [...list.current.querySelectorAll('[role="option"]')]
        const index = choices.indexOf(document.activeElement)
        const focus = (next) => { event.preventDefault(); choices[next]?.focus() }
        if (event.key === 'ArrowDown') focus(Math.min(index + 1, choices.length - 1))
        else if (event.key === 'ArrowUp') focus(Math.max(index - 1, 0))
        else if (event.key === 'Home') focus(0)
        else if (event.key === 'End') focus(choices.length - 1)
        else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          document.activeElement?.click()
        } else if (event.key === 'Tab') list.current.hidePopover()
      }
      const anchor = { [`--${PREFIX}-anchor`]: `--${PREFIX}-menu-${id}` }
      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: `${PREFIX}-trigger`,
          style: anchor,
          disabled,
          popovertarget: `${PREFIX}-list-${id}`,
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          'aria-label': `${label}: ${valueLabel}`,
          onKeyDown: (event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            list.current?.showPopover()
          },
        }, h('span', { className: `${PREFIX}-triggerText` }, valueLabel)),
        h('div', {
          id: `${PREFIX}-list-${id}`,
          ref: list,
          popover: 'auto',
          role: 'listbox',
          'aria-label': label,
          className: `${PREFIX}-menu`,
          style: anchor,
          onKeyDown: onListKey,
        }, options.map(option => h('div', {
          key: option.value,
          role: 'option',
          tabIndex: -1,
          'aria-selected': option.value === selected,
          className: `${PREFIX}-option`,
          onClick: () => { choose(option.value) },
        }, option.label, option.value === selected
          ? h('svg', { className: `${PREFIX}-check`, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: 'M3.5 8.5l3 3 6-7' }))
          : null))))
    }

    /**
     * The pinned channel's model, its effort, and — on OpenAI routes — its
     * request form. Only shown while a channel is chosen, so following the
     * conversation costs no controls.
     */
    function ChannelFields({ t, state, provider, api, onModel, onEffort, onTransport }) {
      // Choices made during a save are queued, so a save does not lock the menus.
      const disabled = state.readOnly
      const channel = state.channel
      const group = state.groups.find(candidate => candidate.id === provider)
      const available = group?.models ?? []
      const known = available.find(candidate => candidate.id === channel.model)
      const modelLabel = known?.name ?? fill(t('modelUnavailable'), 'model', channel.model)
      const modelOptions = [
        ...channel.model === '' ? [] : [known === undefined
          ? { value: channel.model, label: fill(t('modelUnavailable'), 'model', channel.model) }
          : { value: channel.model, label: known.name }],
        ...available.map(candidate => ({ value: candidate.id, label: candidate.name })),
      ]
      const efforts = known?.reasoning?.efforts ?? []
      const effortOptions = [
        { value: '', label: t('effortDefault') },
        ...channel.effort !== '' && !efforts.some(option => option.id === channel.effort)
          ? [{ value: channel.effort, label: channel.effort }]
          : [],
        ...efforts.map(option => ({ value: option.id, label: option.name })),
      ]
      const transportLabel = channel.transport === 'alpha-search'
        ? t('transportAlpha')
        : channel.transport === 'responses' ? t('transportResponses') : t('transportAuto')
      return h('div', { className: `${PREFIX}-fields` },
        h('div', { className: `${PREFIX}-fieldrow` },
          h('span', { className: `${PREFIX}-fieldlabel` }, t('modelLabel')),
          h('div', { className: `${PREFIX}-fieldcontrol` },
            h(Dropdown, {
              label: fill(t('modelAria'), 'provider', provider),
              valueLabel: channel.model === '' ? t('chooseModel') : modelLabel,
              options: modelOptions,
              selected: channel.model,
              disabled: disabled || state.modelsLoading,
              onSelect: onModel,
            }))),
        channel.model === '' || effortOptions.length === 1
          ? null
          : h('div', { className: `${PREFIX}-fieldrow` },
            h('span', { className: `${PREFIX}-fieldlabel` }, t('effortLabel')),
            h('div', { className: `${PREFIX}-fieldcontrol` },
              h(Dropdown, {
                label: fill(t('effortAria'), 'provider', provider),
                valueLabel: effortOptions.find(option => option.value === channel.effort)?.label ?? t('effortDefault'),
                options: effortOptions,
                selected: channel.effort,
                disabled,
                onSelect: onEffort,
              }))),
        api !== RESPONSES_API
          ? null
          : h('div', { className: `${PREFIX}-fieldrow` },
            h('span', { className: `${PREFIX}-fieldlabel` }, t('transportLabel')),
            h('div', { className: `${PREFIX}-fieldcontrol` },
              h(Dropdown, {
                label: fill(t('transportAria'), 'provider', provider),
                valueLabel: transportLabel,
                options: [
                  { value: 'auto', label: t('transportAuto') },
                  { value: 'alpha-search', label: t('transportAlpha') },
                  { value: 'responses', label: t('transportResponses') },
                ],
                selected: channel.transport,
                disabled,
                onSelect: onTransport,
              }))))
    }

    /**
     * The search channel, drawn as a section under the shipped page's own
     * content. The page above owns the provider menus and their save; this
     * section owns one channel and its own save, and renders on that page only.
     */
    function WebSearchSection(props) {
      const { t, subject } = props
      const state = props.useNativeSearchChannel(snapshot => snapshot)
      const id = safeId(useId())
      // Another plugin's page, or a bundle and row: nothing to add there.
      if (subject?.kind !== 'item' || subject.id !== HOSTED_ITEM) return null
      // Choices made during a save are queued, so a save does not lock the menus.
      const disabled = state.readOnly
      const channels = state.groups.map(group => group.id).filter(provider => state.apis.has(provider))
      for (const provider of state.apis.keys()) {
        if (!channels.includes(provider)) channels.push(provider)
      }
      const channelOptions = [
        { value: '', label: t('follow') },
        ...channels.map(provider => ({
          value: provider,
          label: state.groups.find(group => group.id === provider)?.name ?? provider,
        })),
        // A stored channel the catalog no longer offers still shows what is stored.
        ...state.channel.follow || channels.includes(state.channel.provider)
          ? []
          : [{ value: state.channel.provider, label: fill(t('missing'), 'id', state.channel.provider) }],
      ]
      const channelLabel = channelOptions.find(option => option.value === (state.channel.follow ? '' : state.channel.provider))?.label ?? t('follow')
      const status = state.write.saving
        ? t('saving')
        : state.write.saved ? t('saved') : null
      return h('section', { className: PREFIX, 'aria-labelledby': `${PREFIX}-${id}` },
        h('style', null, CSS),
        h('div', { className: `${PREFIX}-field` },
          h('span', { id: `${PREFIX}-${id}`, className: `${PREFIX}-fieldtitle` }, t('channelLabel')),
          h(Dropdown, {
            label: t('channelAria'),
            valueLabel: channelLabel,
            options: channelOptions,
            selected: state.channel.follow ? '' : state.channel.provider,
            disabled: disabled || state.modelsLoading,
            onSelect: props.pickChannel,
          })),
        // Following the conversation needs nothing else: it uses that conversation's model and effort.
        state.channel.follow
          ? null
          : state.modelsFailed
            ? h('p', { className: `${PREFIX}-notice`, role: 'alert' },
              h('span', { className: `${PREFIX}-failure` }, t('modelsFailed')),
              h('button', { type: 'button', className: `${PREFIX}-button`, onClick: props.retry }, t('retry')))
            : h(ChannelFields, {
              t,
              state,
              provider: state.channel.provider,
              api: state.apis.get(state.channel.provider),
              onModel: props.pickModel,
              onEffort: props.pickEffort,
              onTransport: props.pickTransport,
            }),
        // Choices save as they are made, so only their outcome shows here.
        state.readOnly
          ? h('p', { className: `${PREFIX}-status` }, t('readOnly'))
          : state.write.failed
            ? h('p', { className: `${PREFIX}-status`, 'data-tone': 'error', role: 'alert' }, t('saveFailed'))
            : status === null ? null : h('p', { className: `${PREFIX}-status`, role: 'status' }, status))
    }

    return {
      inject: ['slots', 'locale', 'configForms', 'remote', 'remote.session', 'remote.llm'],
      // The section's own state machine, so its tests can drive it without React.
      __page: { createController, supportedApis, atPath },
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'native-search: dictionaries')
        const controller = createController(ctx)
        ctx.effect(() => () => { controller.dispose() }, 'native-search: page state')
        ctx.effect(() => {
          const disposers = [
            ctx.remote.$on('web/providers-changed', () => { controller.face.retry() }),
            ctx.remote.$on('llm/adapters-updated', () => { controller.face.retry() }),
            ctx.remote.$on('settings/document-updated', () => { controller.face.retry() }),
            ctx.on('connection/reset', () => { controller.face.retry() }),
          ]
          return () => { for (const off of disposers) off() }
        }, 'native-search: invalidations')
        ctx.effect(() => ctx.configForms.whileServed([ENTRY], (served) => {
          controller.setServed(served.has(ENTRY))
          // A section under the shipped page's own content. That page keeps its title, icon,
          // provider menus, and save button; this bundle only adds the search channel, and
          // only on its page, so the Plugins list still shows one entry.
          return ctx.slots.inject(DETAIL_SLOT, () => ctx.slots.register({
            name: DETAIL_SLOT,
            id: SLOT_ID,
            order: 50,
            locale: NS,
            inject: () => controller.face,
          }, WebSearchSection))
        }), 'native-search: plugin detail section')
      },
    }
  },
})
