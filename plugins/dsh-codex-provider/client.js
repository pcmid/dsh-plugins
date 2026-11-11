window.__ModuleLoader__.load({
  id: '@pcmid/dsh-codex-provider',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useSyncExternalStore } = React
    const NS = 'settings.codexProvider'
    const PATH = ['providers', 'codex-provider', 'advanced']
    const zh = {
      intro: '使用本机 Codex 的登录和模型。添加后，仅 Codex Provider 的请求会交给 Codex。',
      advanced: '高级设置（选填）', command: 'Codex 命令行路径',
      commandHint: '留空时执行 codex，从 PATH 查找。', intercept: '拦截 Codex 原生工具',
      interceptHint: '默认关闭。开启后禁用原生工具，模型会继续尝试 DSH 工具，不会因原生工具调用而中断对话。',
      enable: '使用 Codex Provider', save: '保存', saving: '保存中…', saved: '已保存', failed: '保存失败，请重试。',
    }
    const en = {
      intro: 'Use your local Codex login and models. After adding this provider, only Codex Provider requests use Codex.',
      advanced: 'Advanced settings (optional)', command: 'Codex executable path',
      commandHint: 'Leave empty to run codex from PATH.', intercept: 'Intercept native Codex tools',
      interceptHint: 'Off by default. When enabled, native tools are disabled and the model can continue with DSH tools without failing the conversation.',
      enable: 'Use Codex Provider', save: 'Save', saving: 'Saving…', saved: 'Saved', failed: 'Could not save. Please retry.',
    }
    const css = `
.dsh-codex-provider { display: grid; gap: 12px; padding: 12px 0; font-size: 14px; color: var(--dsw-alias-label-primary); }
.dsh-codex-provider p { margin: 0; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.dsh-codex-provider summary { cursor: pointer; }
.dsh-codex-provider details > div { display: grid; gap: 12px; padding-top: 12px; }
.dsh-codex-provider label { display: grid; gap: 6px; }
.dsh-codex-provider label:has(input[type=checkbox]) { display: flex; align-items: center; gap: 8px; }
.dsh-codex-provider input[type=text] { box-sizing: border-box; width: 100%; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; }
.dsh-codex-provider button { justify-self: start; padding: 6px 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; cursor: pointer; }
.dsh-codex-provider button:disabled { opacity: .5; cursor: default; }
.dsh-codex-provider :is(input, button, summary):focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
/* shortcut: Models has an extras slot but no editor replacement slot; hide its unsupported generic editor until it gains one. */
div > div:has(+ [data-slot="settings.models.provider-card"] .dsh-codex-provider),
[data-slot="settings.models.provider-card"]:has(.dsh-codex-provider) + div { display: none; }
`

    function ProviderCard({ form, t, configured }) {
      const snapshot = useSyncExternalStore(form.subscribe, form.getSnapshot)
      const advanced = snapshot.value?.providers?.['codex-provider']?.advanced
      const [command, setCommand] = useState(advanced?.command ?? '')
      const [intercept, setIntercept] = useState(advanced?.interceptNativeTools ?? false)
      const [busy, setBusy] = useState(false)
      const [status, setStatus] = useState('')
      useEffect(() => {
        setCommand(advanced?.command ?? '')
        setIntercept(advanced?.interceptNativeTools ?? false)
      }, [advanced?.command, advanced?.interceptNativeTools])
      const disabled = busy || snapshot.status !== 'ready' || !snapshot.writable
      const save = async () => {
        setBusy(true)
        setStatus('')
        try {
          const ok = await form.mutate([{ op: 'set', path: PATH, value: {
            ...(command.trim() ? { command: command.trim() } : {}), interceptNativeTools: intercept,
          } }], snapshot.revision)
          setStatus(ok ? 'saved' : 'failed')
        } catch { setStatus('failed') }
        finally { setBusy(false) }
      }
      return h('div', { className: 'dsh-codex-provider' },
        h('style', null, css),
        h('p', null, t('intro')),
        h('details', null,
          h('summary', null, t('advanced')),
          h('div', null,
            h('label', null, t('command'),
              h('input', { type: 'text', value: command, placeholder: 'codex', disabled,
                onChange: event => setCommand(event.target.value) }),
              h('small', null, t('commandHint'))),
            h('label', null,
              h('input', { type: 'checkbox', checked: intercept, disabled,
                onChange: event => setIntercept(event.target.checked) }), t('intercept')),
            h('p', null, t('interceptHint')))),
        h('button', { type: 'button', disabled, onClick: save }, t(busy ? 'saving' : configured ? 'save' : 'enable')),
        status ? h('p', { role: 'status', 'aria-live': 'polite' }, t(status)) : null)
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }))
        const scope = ctx.configForms.get('codex-provider')
        const form = { subscribe: listener => scope.subscribe(listener), getSnapshot: () => scope.getSnapshot(),
          mutate: (ops, revision) => scope.mutate(ops, revision) }
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.configForms.whileServed(['codex-provider'], () =>
          ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
            name: 'settings.models.provider-card', key: 'codex-provider', locale: NS,
            inject: () => ({ form, t }),
          }, ProviderCard))))
      },
    }
  },
})
