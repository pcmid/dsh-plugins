window.__ModuleLoader__.load({
  id: '@pcmid/dsh-codex-provider',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState, useSyncExternalStore } = React
    const NS = 'settings.codexProvider'
    const PATH = ['providers', 'codex-provider']
    const SLOT = '[data-slot="settings.models.provider-card"]'
    // Action labels follow the built-in Models editor (取消 / 保存).
    const zh = { codexPath: 'codex 路径', cancel: '取消', apply: '保存', applying: '保存中…', failed: '保存失败，请重试。' }
    const en = { codexPath: 'Codex path', cancel: 'Cancel', apply: 'Apply', applying: 'Applying…', failed: 'Could not save. Please retry.' }
    // The Models page renders a generic editor for providers it does not know, which can only point
    // at cordis.patch.yml. Its slot has no way to replace that editor, so this card takes its place:
    // it is shown only while the page shows that editor (Edit on the saved row, or the add card) and
    // hides it. The values mirror the page's own editor styles.
    const css = `
.dsh-codex-provider { display: none; flex-direction: column; gap: 14px; padding: 14px 16px; border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; }
${SLOT}:has(+ div) .dsh-codex-provider, div > div + ${SLOT} .dsh-codex-provider { display: flex; }
div > div + ${SLOT} .dsh-codex-provider { padding: 0; background: none; }
${SLOT}:has(.dsh-codex-provider) + div, div > div:has(+ ${SLOT} .dsh-codex-provider) { display: none; }
.dsh-codex-provider .dcp-error { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.dsh-codex-provider label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.dsh-codex-provider input { box-sizing: border-box; width: 100%; height: 32px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); font: inherit; font-size: 14px; line-height: 22px; font-weight: 400; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dsh-codex-provider input:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.dsh-codex-provider input::placeholder { color: var(--dsw-alias-label-dimmed); }
.dsh-codex-provider input:disabled { opacity: 0.6; cursor: default; }
.dsh-codex-provider .dcp-actions { display: flex; justify-content: flex-end; gap: 8px; }
.dsh-codex-provider button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; height: 36px; padding: 0 14px; border: none; border-radius: var(--dsw-radius-md); font: inherit; font-size: 14px; line-height: 22px; cursor: pointer; }
.dsh-codex-provider .dcp-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dsh-codex-provider .dcp-secondary { border: 0.5px solid var(--dsw-alias-border-l3); background: transparent; color: var(--dsw-alias-label-primary); }
@media (hover: hover) {
  .dsh-codex-provider .dcp-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
  .dsh-codex-provider .dcp-secondary:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid); }
}
.dsh-codex-provider button:disabled { opacity: 0.4; cursor: default; }
.dsh-codex-provider button:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
`

    // Close the page's own editor through its Cancel button, the page's only close action. The
    // generic editor follows this slot on a saved row and precedes it on the add card.
    function closePageEditor(root) {
      const anchor = root?.closest(SLOT)
      const editor = anchor?.nextElementSibling?.tagName === 'DIV' ? anchor.nextElementSibling
        : anchor?.parentElement?.tagName === 'DIV' && anchor.previousElementSibling?.tagName === 'DIV' ? anchor.previousElementSibling
          : undefined
      editor?.querySelector(':scope > :last-child > button')?.click()
    }

    function ProviderCard({ form, t }) {
      const snapshot = useSyncExternalStore(form.subscribe, form.getSnapshot)
      const saved = snapshot.value?.providers?.['codex-provider']?.codexPath ?? ''
      const root = useRef(null)
      const [codexPath, setCodexPath] = useState(saved)
      const [busy, setBusy] = useState(false)
      const [failed, setFailed] = useState(false)
      useEffect(() => { setCodexPath(saved) }, [saved])
      const disabled = busy || snapshot.status !== 'ready' || !snapshot.writable
      const cancel = () => {
        setCodexPath(saved)
        setFailed(false)
        closePageEditor(root.current)
      }
      const save = async () => {
        setBusy(true)
        setFailed(false)
        let ok = false
        try {
          ok = await form.mutate([{ op: 'set', path: PATH, value: codexPath.trim() ? { codexPath: codexPath.trim() } : {} }],
            snapshot.revision)
        } catch {
          // The settings write failed; the card reports it and keeps the draft for a retry.
        } finally {
          setBusy(false)
        }
        if (ok) closePageEditor(root.current)
        else setFailed(true)
      }
      return h('div', { className: 'dsh-codex-provider', ref: root },
        h('style', null, css),
        h('label', null, t('codexPath'),
          h('input', { type: 'text', value: codexPath, placeholder: 'codex', disabled, 'aria-label': t('codexPath'),
            onChange: event => setCodexPath(event.target.value) })),
        failed ? h('p', { className: 'dcp-error', role: 'alert' }, t('failed')) : null,
        h('div', { className: 'dcp-actions' },
          h('button', { type: 'button', className: 'dcp-secondary', disabled: busy, onClick: cancel }, t('cancel')),
          h('button', { type: 'button', className: 'dcp-primary', disabled, onClick: save }, t(busy ? 'applying' : 'apply'))))
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
