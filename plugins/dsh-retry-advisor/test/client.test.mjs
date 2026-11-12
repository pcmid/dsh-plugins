// Renders the browser half (client.js) with the real React and
// @deepseek-ai/dsh-client-ui-primitives from a built deepseek-harness checkout
// beside this plugin or its repository (or UI_PRIMITIVES_DIR); skipped without one.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { before, describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const primitivesDir = process.env.UI_PRIMITIVES_DIR ?? ['../../deepseek-harness', '../../../../deepseek-harness']
  .map(root => fileURLToPath(new URL(`${root}/packages/client/ui-primitives`, import.meta.url)))
  .find(dir => existsSync(`${dir}/lib/index.js`) && existsSync(`${dir}/node_modules/react`))

let React, renderToStaticMarkup, primitives, definition

before(async () => {
  if (primitivesDir === undefined) return
  // The primitives bundle imports CSS modules; class names are not under test.
  registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: 'export default new Proxy({}, { get: (_, key) => String(key) })', shortCircuit: true }
      return nextLoad(url, context)
    },
  })
  const require = createRequire(`${primitivesDir}/package.json`)
  React = require('react')
  renderToStaticMarkup = require('react-dom/server').renderToStaticMarkup
  primitives = await import(pathToFileURL(`${primitivesDir}/lib/index.js`).href)
  globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value } } }
  globalThis.document = { createElement: () => ({ dataset: {}, remove() {} }), head: { append() {} } }
  await import('../client.js')
})

const BASE = { dropInvalidThinking: false }

/** The shared configuration form of one namespace, applying mutations to its user layer. */
function fakeScope({ user = {}, writable = true } = {}) {
  let snapshot = { status: 'ready', writable, revision: 1, base: BASE, user, value: { ...BASE, ...user } }
  const listeners = new Set()
  const writes = []
  return {
    writes,
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async mutate(ops, revision) {
      writes.push({ ops, revision })
      const next = { ...snapshot.user }
      for (const op of ops) {
        if (op.op === 'set') next[op.path[0]] = op.value
        else delete next[op.path[0]]
      }
      snapshot = { ...snapshot, user: next, value: { ...BASE, ...next }, revision: snapshot.revision + 1 }
      for (const listener of listeners) listener()
      return true
    },
  }
}

/** Load the module, apply it to a stand-in browser context, and bind its components. */
function mount(scopeOptions) {
  const scope = fakeScope(scopeOptions)
  const registrations = []
  const dictionaries = {}
  const served = []
  const conversationEvents = []
  const plugin = definition.factory((id) => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected module request ${id}`)
  })
  plugin.apply({
    effect: (effect) => { effect() },
    locale: { register: (ns, value) => { dictionaries[ns] = value; return () => {} } },
    uiConversation: { events: { register: (value) => { conversationEvents.push(value) } } },
    configForms: {
      get: (ns) => { assert.equal(ns, 'retry-advisor'); return scope },
      whileServed: (namespaces, register) => { served.push(namespaces); return register(new Set(namespaces)) },
    },
    slots: {
      inject: (_name, register) => register(),
      register: (options, Component) => { registrations.push({ options, Component }); return () => {} },
    },
  })
  const settings = registrations.find(entry => entry.options.name === 'plugins.bundle.config')
  const row = registrations.find(entry => entry.options.name === 'conversation.chat.node')
  const { hooks, ...actions } = settings.options.inject()
  const t = key => dictionaries[settings.options.locale].zh[key]
  const render = (view = 'page') => renderToStaticMarkup(React.createElement(settings.Component, {
    view, t, ...actions, useRetryAdvisorForm: select => select(hooks.retryAdvisorForm.getSnapshot()),
  }))
  const renderRow = (data) => {
    const dictionary = dictionaries[row.options.locale].zh
    const translate = (key, params = {}) => dictionary[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name]))
    return renderToStaticMarkup(React.createElement(row.Component, { node: { data }, t: translate }))
  }
  return { plugin, scope, settings, row, dictionaries, served, conversationEvents, actions, render, renderRow, t }
}

const saveDisabled = html => /<button[^>]*disabled=""[^>]*>保存<\/button>/.test(html)

describe('browser half', { skip: primitivesDir === undefined && 'no built deepseek-harness checkout with ui-primitives' }, () => {
  it('registers the Chat rows and, while the Host serves the entry, the settings on this bundle\'s page', () => {
    const m = mount()
    assert.deepEqual(m.plugin.inject, ['slots', 'locale', 'uiConversation', 'configForms'])
    assert.equal(m.conversationEvents.length, 1)
    assert.deepEqual(m.served, [['retry-advisor']])
    assert.equal(m.settings.options.key, '@pcmid/dsh-retry-advisor')
    for (const ns of [m.settings.options.locale, m.row.options.locale]) {
      const { zh, en } = m.dictionaries[ns]
      assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), ns)
    }
  })

  it('shows one switch, labeled 丢弃无效思考 and off by default, with nothing to save', () => {
    const html = mount().render()
    assert.match(html, /丢弃无效思考/)
    assert.match(html, /不再进入模型上下文/)
    assert.equal(html.match(/role="switch"/g).length, 1)
    assert.match(html, /role="switch" aria-checked="false"/)
    assert.doesNotMatch(html, /已覆盖/)
    assert.ok(saveDisabled(html))
  })

  it('stages the switch and writes a boolean on save', async () => {
    const m = mount()
    m.actions.edit('dropInvalidThinking', 'true')
    const html = m.render()
    assert.match(html, /role="switch" aria-checked="true"/)
    assert.equal(m.scope.writes.length, 0, 'nothing is written before save')
    m.actions.save()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(m.scope.writes, [{ ops: [{ op: 'set', path: ['dropInvalidThinking'], value: true }], revision: 1 }])
  })

  it('resets an override back to the default', async () => {
    const m = mount({ user: { dropInvalidThinking: true } })
    assert.match(m.render(), /已覆盖/)
    m.actions.resetField('dropInvalidThinking')
    assert.match(m.render(), /role="switch" aria-checked="false"/)
    m.actions.save()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(m.scope.writes[0].ops, [{ op: 'unset', path: ['dropInvalidThinking'] }])
  })

  it('disables the switch when settings are read-only', () => {
    const html = mount({ writable: false }).render()
    assert.match(html, /本部署的设置为只读/)
    assert.match(html, /role="switch" aria-checked="false"[^>]*disabled=""/)
  })

  it('answers the summary view with its one-liner', () => {
    const m = mount()
    assert.equal(m.render('summary'), m.t('description'))
  })

  it('titles a retry that dropped invalid thinking', () => {
    const m = mount()
    const base = { outcome: 'retry', granted: 0, maxRetries: 3, delayMs: 0 }
    assert.match(m.renderRow({ ...base, fix: 'drop-invalid-thinking' }), /丢弃无效思考后立即重试（第 1\/3 次）/)
    assert.match(m.renderRow({ ...base, granted: 1, fix: 'drop-thinking-fallback' }), /带参数仍失败，回退为普通请求重试（第 2\/3 次）/)
    assert.match(m.renderRow(base), /立即重试（第 1\/3 次）/)
    assert.doesNotMatch(m.renderRow(base), /丢弃无效思考/)
  })
})
