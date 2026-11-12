/**
 * Browser half of @pcmid/dsh-retry-advisor: shows each retry decision in the
 * Chat view, and draws the settings form on the plugin's page in Plugins.
 *
 * The Host appends one `plugin:retry-advisor/decision` record when an analysis
 * starts and another with the outcome; both carry the same `id` and the
 * complete current state, so the latest loaded record wins. One Chat row per
 * id stands in the failed Turn outside its process disclosure, so a folded
 * Turn still shows it. A row still analyzing when its Step or Turn closes
 * reads as cancelled. Record data comes from the Session log, so every field
 * is checked before use.
 *
 * The settings form edits the `retry-advisor` entry's volatile
 * `dropInvalidThinking` switch through the shared configuration form, staged
 * until Save like the official plugin cards. It appears only while the Host
 * serves the entry.
 */
window.__ModuleLoader__.load({
  id: '@pcmid/dsh-retry-advisor',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { SettingsForm, SettingsFormModel, StateDot, Switch, Tag, TextShimmer } = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'retryAdvisor'
    /** Chat Node kind and keyed renderer key. */
    const KIND = 'retry-advisor'
    /** Session record type written by the Host half. */
    const RECORD = 'plugin:retry-advisor/decision'
    const PREFIX = 'dsh-ra'
    /** `fix` of a retry that switched the conversation to dropping invalid thinking. */
    const DROP_THINKING_FIX = 'drop-invalid-thinking'
    /** Locale namespace of the settings form. */
    const SETTINGS_NS = 'settings.retryAdvisor'
    /** Settings namespace: the row id in cordis.patch.yml. */
    const NAMESPACE = 'retry-advisor'
    /** Key of this bundle's page in Plugins. */
    const PACKAGE = '@pcmid/dsh-retry-advisor'

    const OUTCOMES = new Set(['analyzing', 'retry', 'give-up', 'analysis-failed', 'budget-exhausted'])
    const DOTS = {
      'analyzing': 'ongoing',
      'retry': 'done',
      'give-up': 'warning',
      'analysis-failed': 'error',
      'budget-exhausted': 'warning',
      'cancelled': 'idle',
    }

    const zh = {
      'title.analyzing': '重试顾问正在分析失败原因…',
      'title.retry': '重试顾问：{seconds} 秒后重试（第 {retry}/{maximum} 次）',
      'title.retryNow': '重试顾问：立即重试（第 {retry}/{maximum} 次）',
      'title.dropThinking': '重试顾问：丢弃无效思考后立即重试（第 {retry}/{maximum} 次）',
      'title.giveUp': '重试顾问：判断重发无效，不重试',
      'title.analysisFailed': '重试顾问：分析失败，不重试',
      'title.budgetExhausted': '重试顾问：本步已重试 {granted} 次，不再重试',
      'title.cancelled': '重试顾问：分析已取消',
      'cause': '原因',
      'reason': '判断',
      'error': '错误',
      'details': '详情',
      'failure': '失败',
      'model': '分析模型',
    }
    const en = {
      'title.analyzing': 'Retry advisor is analyzing the failure…',
      'title.retry': 'Retry advisor: retrying in {seconds}s (attempt {retry}/{maximum})',
      'title.retryNow': 'Retry advisor: retrying now (attempt {retry}/{maximum})',
      'title.dropThinking': 'Retry advisor: retrying now with invalid thinking dropped (attempt {retry}/{maximum})',
      'title.giveUp': 'Retry advisor: a resend would fail the same way, not retrying',
      'title.analysisFailed': 'Retry advisor: the analysis failed, not retrying',
      'title.budgetExhausted': 'Retry advisor: {granted} retries already used in this step, not retrying',
      'title.cancelled': 'Retry advisor: analysis cancelled',
      'cause': 'Cause',
      'reason': 'Reason',
      'error': 'Error',
      'details': 'Details',
      'failure': 'Failure',
      'model': 'Analysis model',
    }

    const CSS = `
.${PREFIX}-row { display: grid; grid-template-columns: 10px minmax(0, 1fr); gap: 8px; align-items: start; padding: 2px 0; font-size: var(--dsh-content-font-size-secondary, 13px); line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px)); }
.${PREFIX}-dot { margin-top: 5px; }
.${PREFIX}-copy { min-width: 0; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-title { font-weight: 600; color: var(--dsw-alias-label-primary); }
.${PREFIX}-row[data-outcome="give-up"] .${PREFIX}-title,
.${PREFIX}-row[data-outcome="budget-exhausted"] .${PREFIX}-title { color: var(--dsw-alias-state-warn-primary); }
.${PREFIX}-row[data-outcome="analysis-failed"] .${PREFIX}-title { color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-row[data-outcome="cancelled"] .${PREFIX}-title { color: var(--dsw-alias-label-tertiary); font-weight: 500; }
.${PREFIX}-label { margin-right: 6px; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-more { margin-top: 2px; }
.${PREFIX}-more > summary { width: fit-content; color: var(--dsw-alias-label-tertiary); cursor: pointer; list-style: none; user-select: none; }
.${PREFIX}-more > summary::-webkit-details-marker { display: none; }
.${PREFIX}-more > summary:focus-visible { outline: 1.5px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; border-radius: var(--dsw-radius-sm); }
@media (hover: hover) { .${PREFIX}-more > summary:hover { color: var(--dsw-alias-label-secondary); } }
.${PREFIX}-detail { padding-left: 12px; }
.${PREFIX}-code { margin-right: 6px; color: var(--dsw-alias-label-tertiary); font: var(--dsw-font-markdown-code-block-small); }
.${PREFIX}-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.${PREFIX}-head { display: flex; align-items: center; gap: 8px; }
.${PREFIX}-name { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.${PREFIX}-badges { display: inline-flex; align-items: center; gap: 8px; }
.${PREFIX}-reset { border: none; background: none; padding: 0; font: inherit; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); cursor: pointer; }
@media (hover: hover) { .${PREFIX}-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); } }
.${PREFIX}-reset:disabled { cursor: default; }
.${PREFIX}-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
`

    const settingsZh = {
      description: '模型请求失败且内置机制不再重试时，分析原因并决定是否重发。',
      dropInvalidThinking: '丢弃无效思考',
      dropInvalidThinkingHint: '模型服务认为对话历史里的思考无效而拒绝请求时（例如分叉会话带来的、绑定在另一段对话上的思考块），立即按该 API 的方式丢弃这些思考后重发，这个会话之后的请求也照此处理。被丢弃的思考不再进入模型上下文。各 API 的丢弃方式不同，目前支持 Anthropic Messages。默认关闭。',
      overridden: '已覆盖',
      reset: '恢复默认',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
    }
    const settingsEn = {
      description: 'When a model request fails and no built-in handler retries it, analyzes the cause and decides whether to resend.',
      dropInvalidThinking: 'Drop invalid thinking',
      dropInvalidThinkingHint: 'When the provider rejects thinking in the conversation history as invalid (for example thinking blocks bound to a different conversation after a fork), resend at once with that thinking dropped the way the API allows, and keep doing so for the rest of the conversation. Dropped thinking no longer reaches the model\'s context. Each API drops thinking differently; Anthropic Messages is supported. Off by default.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
    }

    /** A switch field, staged as the text `true` or `false`; empty clears it back to the default. */
    function switchField(field) {
      return {
        field,
        format: value => value === true ? 'true' : value === false ? 'false' : '',
        parse: (text) => {
          if (text === 'true') return { kind: 'set', value: true }
          if (text === 'false') return { kind: 'set', value: false }
          return text === '' ? { kind: 'clear' } : undefined
        },
      }
    }

    function createSettingsController(scope) {
      const model = new SettingsFormModel(scope, [switchField('dropInvalidThinking')])
      const store = model.bind(() => ({ ...model.shell(), dropInvalidThinking: model.field('dropInvalidThinking') }))
      return {
        face: { hooks: { retryAdvisorForm: store }, ...model.actions() },
        dispose: () => { model.dispose() },
      }
    }

    /** A switch row: label, override badge and reset, switch, hint. */
    function SwitchField(props) {
      const { state } = props
      return h('div', { className: `${PREFIX}-field` },
        h('div', { className: `${PREFIX}-head` },
          h('span', { id: `${props.id}-label`, className: `${PREFIX}-name` }, props.label),
          state.overridden
            ? h('span', { className: `${PREFIX}-badges` },
              h(Tag, { tone: 'neutral' }, props.overriddenLabel),
              h('button', { type: 'button', className: `${PREFIX}-reset`, disabled: props.disabled, onClick: props.onReset }, props.resetLabel))
            : null,
          h(Switch, { checked: state.text === 'true', label: props.label, disabled: props.disabled, onChange: next => { props.onEdit(next ? 'true' : 'false') } })),
        h('p', { className: `${PREFIX}-hint` }, props.hint))
    }

    function RetryAdvisorSettings(props) {
      const { t } = props
      const state = props.useRetryAdvisorForm(snapshot => snapshot)
      if (props.view === 'summary') return t('description')
      const labels = { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
      return h(SettingsForm, { labels, state, onSave: props.save, onDiscard: props.discard },
        h(SwitchField, {
          id: 'plugin-config-retry-advisor-dropInvalidThinking',
          label: t('dropInvalidThinking'),
          hint: t('dropInvalidThinkingHint'),
          overriddenLabel: t('overridden'),
          resetLabel: t('reset'),
          disabled: !state.writable,
          state: state.dropInvalidThinking,
          onEdit: (text) => { props.edit('dropInvalidThinking', text) },
          onReset: () => { props.resetField('dropInvalidThinking') },
        }))
    }

    function text(value) {
      return typeof value === 'string' && value !== '' ? value : undefined
    }

    function count(value) {
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
    }

    /**
     * Read one record payload.
     * @returns the displayed state, or undefined when the payload is unusable.
     */
    function readRecord(data) {
      if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
      if (text(data.id) === undefined || !OUTCOMES.has(data.outcome)) return undefined
      return {
        outcome: data.outcome,
        code: text(data.code),
        failure: text(data.failure),
        analysisModel: text(data.analysisModel),
        reasoningEffort: text(data.reasoningEffort),
        delayMs: count(data.delayMs) ?? 0,
        cause: text(data.cause),
        reason: text(data.reason),
        error: text(data.error),
        granted: count(data.granted) ?? 0,
        maxRetries: count(data.maxRetries),
        fix: text(data.fix),
      }
    }

    function contextLocation(context) {
      return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
    }

    function isClosed(location) {
      return (location.kind === 'step' && location.step.status === 'closed')
        || ((location.kind === 'step' || location.kind === 'turn') && location.turn.status === 'closed')
    }

    const definition = {
      kind: KIND,
      target: 'chat',
      match: {
        [RECORD]: (event) => {
          const id = event.data?.id
          return typeof id === 'string' && id !== '' ? { id, role: 'start' } : null
        },
      },
      start: (_context, match) => readRecord(match.event.data),
      update: (context, match) => readRecord(match.event.data) ?? context.state,
      buildViewNode: (context) => {
        const state = context.state
        if (state === undefined) return null
        const location = contextLocation(context)
        const data = state.outcome === 'analyzing' && isClosed(location) ? { ...state, outcome: 'cancelled' } : state
        return {
          key: context.key,
          kind: KIND,
          id: context.id,
          target: 'chat',
          anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
          location,
          visibility: 'visible',
          groupTree: 'turn',
          data,
        }
      },
    }

    function title(data, t) {
      switch (data.outcome) {
        case 'analyzing': return t('title.analyzing')
        case 'retry': {
          const params = { retry: data.granted + 1, maximum: data.maxRetries ?? '?' }
          if (data.fix === DROP_THINKING_FIX) return t('title.dropThinking', params)
          return data.delayMs > 0
            ? t('title.retry', { ...params, seconds: Math.max(1, Math.round(data.delayMs / 1000)) })
            : t('title.retryNow', params)
        }
        case 'give-up': return t('title.giveUp')
        case 'analysis-failed': return t('title.analysisFailed')
        case 'budget-exhausted': return t('title.budgetExhausted', { granted: data.granted })
        default: return t('title.cancelled')
      }
    }

    function line(key, label, value) {
      return h('div', { key }, h('span', { className: `${PREFIX}-label` }, label), value)
    }

    const RetryAdvisorNodeView = React.memo(function RetryAdvisorNodeView({ node, t }) {
      const data = node.data
      const heading = title(data, t)
      const model = data.analysisModel === undefined
        ? undefined
        : data.reasoningEffort === undefined ? data.analysisModel : `${data.analysisModel} · ${data.reasoningEffort}`
      const details = [
        data.failure === undefined && data.code === undefined
          ? null
          : h('div', { key: 'failure', className: `${PREFIX}-detail` },
            h('span', { className: `${PREFIX}-label` }, t('failure')),
            data.code === undefined ? null : h('code', { className: `${PREFIX}-code` }, data.code),
            data.failure ?? null),
        model === undefined ? null : h('div', { key: 'model', className: `${PREFIX}-detail` },
          h('span', { className: `${PREFIX}-label` }, t('model')), model),
      ].filter(Boolean)
      return h('div', { className: `${PREFIX}-row`, role: 'status', 'data-outcome': data.outcome },
        h(StateDot, { state: DOTS[data.outcome] ?? 'idle', className: `${PREFIX}-dot` }),
        h('div', { className: `${PREFIX}-copy` },
          h('div', { className: `${PREFIX}-title` },
            data.outcome === 'analyzing' ? h(TextShimmer, { active: true }, heading) : heading),
          data.cause === undefined ? null : line('cause', t('cause'), data.cause),
          data.reason === undefined ? null : line('reason', t('reason'), data.reason),
          data.error === undefined ? null : line('error', t('error'), data.error),
          details.length === 0 ? null : h('details', { className: `${PREFIX}-more` },
            h('summary', null, t('details')),
            ...details)))
    })

    return {
      inject: ['slots', 'locale', 'uiConversation', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'retry-advisor: dictionaries')
        ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh: settingsZh, en: settingsEn }), 'retry-advisor: settings dictionaries')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.dshRetryAdvisor = ''
          style.textContent = CSS
          document.head.append(style)
          return () => { style.remove() }
        }, 'retry-advisor: styles')
        ctx.uiConversation.events.register(definition)
        ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
          name: 'conversation.chat.node', key: KIND, locale: NS,
        }, RetryAdvisorNodeView))
        const settings = createSettingsController(ctx.configForms.get(NAMESPACE))
        ctx.effect(() => () => { settings.dispose() }, 'retry-advisor: settings form')
        ctx.effect(() => ctx.configForms.whileServed([NAMESPACE], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: PACKAGE, locale: SETTINGS_NS, inject: () => settings.face,
        }, RetryAdvisorSettings))), 'retry-advisor: plugin page section')
      },
    }
  },
})
