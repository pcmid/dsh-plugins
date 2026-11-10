/**
 * Browser half of @pcmid/dsh-todo-guard: the settings form on the plugin's
 * page in Plugins.
 *
 * The form edits the `todo-guard` entry's volatile Config fields through the
 * shared configuration form, with the same staged editing as the official
 * plugin cards: edits are drafts until Save, an overridden field shows a badge
 * and a reset to its default, and a value the Host would refuse blocks the
 * save. The section appears only while the Host serves the entry.
 */
window.__ModuleLoader__.load({
  id: '@pcmid/dsh-todo-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { SettingsForm, SettingsFormModel, SettingsValueField, Switch, Tag } = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'settings.todoGuard'
    /** Settings namespace: the row id in cordis.patch.yml. */
    const NAMESPACE = 'todo-guard'
    /** Key of this bundle's page in Plugins. */
    const PACKAGE = '@pcmid/dsh-todo-guard'
    const PREFIX = 'dsh-tg'

    const zh = {
      description: '任务列表连续多步没有更新时，提醒 agent 更新。',
      stepThreshold: '提醒前的步数',
      stepThresholdHint: '任务列表还有未完成项时，连续这么多步没有更新列表就提醒一次。默认 5。',
      callThreshold: '提醒前的工具调用次数',
      callThresholdHint: '连续这么多次工具调用没有更新列表也会提醒，两个条件先满足哪个就按哪个提醒。默认 10。',
      autoCompleteOnTurnEnd: '回合结束时完成剩余任务',
      autoCompleteOnTurnEndHint: '回合正常结束时，把仍是进行中或待处理的任务标为已完成。回合结束不等于任务做完：agent 停下来报告失败或提问时，没做完的任务也会被标为完成。默认关闭。',
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
      description: 'Reminds the agent to update its task list after several steps without an update.',
      stepThreshold: 'Steps before a reminder',
      stepThresholdHint: 'While the task list has unfinished items, remind after this many steps without an update. Default 5.',
      callThreshold: 'Tool calls before a reminder',
      callThresholdHint: 'Also remind after this many tool calls without an update, whichever comes first. Default 10.',
      autoCompleteOnTurnEnd: 'Complete leftover tasks at turn end',
      autoCompleteOnTurnEndHint: 'When a turn ends normally, mark tasks still in progress or pending as completed. A finished turn is not finished work: if the agent stops to report a failure or ask a question, its unfinished tasks are marked completed too. Off by default.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      invalidNumber: 'Enter a whole number of at least 1, or leave blank to use the default.',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
    }

    /**
     * A threshold field: a whole number of at least 1, as the Host Config
     * requires. An empty draft clears the field back to its default.
     */
    function thresholdField(field) {
      return {
        field,
        format: value => typeof value === 'number' ? String(value) : '',
        parse: (text) => {
          const trimmed = text.trim()
          if (trimmed === '') return { kind: 'clear' }
          if (!/^\d+$/.test(trimmed)) return undefined
          const value = Number(trimmed)
          return Number.isSafeInteger(value) && value >= 1 ? { kind: 'set', value } : undefined
        },
      }
    }

    /** A switch field, staged as the text `true` or `false`. */
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

    const FIELDS = ['stepThreshold', 'callThreshold', 'autoCompleteOnTurnEnd']

    function createController(scope) {
      const model = new SettingsFormModel(scope, [
        thresholdField('stepThreshold'),
        thresholdField('callThreshold'),
        switchField('autoCompleteOnTurnEnd'),
      ])
      const store = model.bind(() => ({
        ...model.shell(),
        ...Object.fromEntries(FIELDS.map(field => [field, model.field(field)])),
      }))
      return {
        face: { hooks: { todoGuardForm: store }, ...model.actions() },
        dispose: () => { model.dispose() },
      }
    }

    const CSS = `
.${PREFIX}-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.${PREFIX}-head { display: flex; align-items: center; gap: 8px; }
.${PREFIX}-label { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.${PREFIX}-badges { display: inline-flex; align-items: center; gap: 8px; }
.${PREFIX}-reset { border: none; background: none; padding: 0; font: inherit; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); cursor: pointer; }
@media (hover: hover) { .${PREFIX}-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); } }
.${PREFIX}-reset:disabled { cursor: default; }
.${PREFIX}-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
`

    /** A switch row laid out like the form's value fields: label, override badge and reset, hint. */
    function SwitchField(props) {
      const { state } = props
      return h('div', { className: `${PREFIX}-field` },
        h('div', { className: `${PREFIX}-head` },
          h('span', { id: `${props.id}-label`, className: `${PREFIX}-label` }, props.label),
          state.overridden
            ? h('span', { className: `${PREFIX}-badges` },
              h(Tag, { tone: 'neutral' }, props.overriddenLabel),
              h('button', { type: 'button', className: `${PREFIX}-reset`, disabled: props.disabled, onClick: props.onReset }, props.resetLabel))
            : null,
          h(Switch, { checked: state.text === 'true', label: props.label, disabled: props.disabled, onChange: next => { props.onEdit(next ? 'true' : 'false') } })),
        h('p', { className: `${PREFIX}-hint` }, props.hint))
    }

    function TodoGuardSettings(props) {
      const { t } = props
      const state = props.useTodoGuardForm(snapshot => snapshot)
      if (props.view === 'summary') return t('description')
      const labels = { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
      const disabled = !state.writable
      const threshold = field => h(SettingsValueField, {
        key: field,
        id: `plugin-config-todo-guard-${field}`,
        label: t(field),
        hint: t(`${field}Hint`),
        overriddenLabel: t('overridden'),
        resetLabel: t('reset'),
        invalidLabel: t('invalidNumber'),
        numeric: true,
        disabled,
        ...state[field],
        onEdit: (text) => { props.edit(field, text) },
        onReset: () => { props.resetField(field) },
      })
      return h(SettingsForm, { labels, state, onSave: props.save, onDiscard: props.discard },
        h('style', null, CSS),
        threshold('stepThreshold'),
        threshold('callThreshold'),
        h(SwitchField, {
          id: 'plugin-config-todo-guard-autoCompleteOnTurnEnd',
          label: t('autoCompleteOnTurnEnd'),
          hint: t('autoCompleteOnTurnEndHint'),
          overriddenLabel: t('overridden'),
          resetLabel: t('reset'),
          disabled,
          state: state.autoCompleteOnTurnEnd,
          onEdit: (text) => { props.edit('autoCompleteOnTurnEnd', text) },
          onReset: () => { props.resetField('autoCompleteOnTurnEnd') },
        }))
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'todo-guard: dictionaries')
        const controller = createController(ctx.configForms.get(NAMESPACE))
        ctx.effect(() => () => { controller.dispose() }, 'todo-guard: settings form')
        ctx.effect(() => ctx.configForms.whileServed([NAMESPACE], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: PACKAGE, locale: NS, inject: () => controller.face,
        }, TodoGuardSettings))), 'todo-guard: plugin page section')
      },
    }
  },
})
