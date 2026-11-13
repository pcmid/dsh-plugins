/**
 * Browser half of @pcmid/dsh-retry-advisor: shows each retry decision in the
 * Chat view.
 *
 * The Host appends one `plugin:retry-advisor/decision` record when an analysis
 * starts and another with the outcome; both carry the same `id` and the
 * complete current state, so the latest loaded record wins. One Chat row per
 * id stands in the failed Turn outside its process disclosure, so a folded
 * Turn still shows it. A row still analyzing when its Step or Turn closes
 * reads as cancelled. Record data comes from the Session log, so every field
 * is checked before use.
 */
window.__ModuleLoader__.load({
  id: '@pcmid/dsh-retry-advisor',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { StateDot, TextShimmer } = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'retryAdvisor'
    /** Chat Node kind and keyed renderer key. */
    const KIND = 'retry-advisor'
    /** Session record type written by the Host half. */
    const RECORD = 'plugin:retry-advisor/decision'
    const PREFIX = 'dsh-ra'

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
`

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
      inject: ['slots', 'locale', 'uiConversation'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'retry-advisor: dictionaries')
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
      },
    }
  },
})
