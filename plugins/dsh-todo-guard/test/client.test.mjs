// Renders the settings form of client.js with the real React and
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
  await import('../client.js')
})

const BASE = { autoCompleteOnTurnEnd: false }

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

/** Load the module, apply it to a stand-in browser context, and bind its form component. */
function mount(scopeOptions) {
  const scope = fakeScope(scopeOptions)
  const registrations = []
  const dictionaries = {}
  const served = []
  const plugin = definition.factory((id) => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected module request ${id}`)
  })
  plugin.apply({
    effect: (effect) => { effect() },
    locale: { register: (ns, value) => { dictionaries[ns] = value; return () => {} } },
    configForms: {
      get: (ns) => { assert.equal(ns, 'todo-guard'); return scope },
      whileServed: (namespaces, register) => { served.push(namespaces); return register(new Set(namespaces)) },
    },
    slots: {
      inject: (_name, register) => register(),
      register: (options, Component) => { registrations.push({ options, Component }); return () => {} },
    },
  })
  const [{ options, Component }] = registrations
  const { hooks, ...actions } = options.inject()
  const t = key => dictionaries[options.locale].zh[key]
  const render = (view = 'page') => renderToStaticMarkup(React.createElement(Component, {
    view, t, ...actions, useTodoGuardForm: select => select(hooks.todoGuardForm.getSnapshot()),
  }))
  return { plugin, scope, options, dictionaries, served, actions, render, t }
}

const saveDisabled = html => /<button[^>]*disabled=""[^>]*>保存<\/button>/.test(html)

describe('settings form', { skip: primitivesDir === undefined && 'no built deepseek-harness checkout with ui-primitives' }, () => {
  it('registers on this bundle\'s page while the Host serves the todo-guard entry', () => {
    const m = mount()
    assert.deepEqual(m.plugin.inject, ['slots', 'locale', 'configForms'])
    assert.deepEqual(m.served, [['todo-guard']])
    assert.equal(m.options.name, 'plugins.bundle.config')
    assert.equal(m.options.key, '@pcmid/dsh-todo-guard')
    const { zh, en } = m.dictionaries[m.options.locale]
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  })

  it('shows the switch with nothing to save, and no threshold fields', () => {
    const html = mount().render()
    assert.match(html, /回合结束时完成剩余任务/)
    assert.doesNotMatch(html, /提醒前|Threshold/)
    assert.match(html, /role="switch" aria-checked="false"/)
    assert.doesNotMatch(html, /已覆盖/)
    assert.ok(saveDisabled(html))
  })

  it('stages the switch and writes a boolean on save', async () => {
    const m = mount()
    m.actions.edit('autoCompleteOnTurnEnd', 'true')
    let html = m.render()
    assert.match(html, /role="switch" aria-checked="true"/)
    assert.match(html, /已覆盖/)
    assert.ok(!saveDisabled(html))
    assert.equal(m.scope.writes.length, 0, 'nothing is written before save')
    m.actions.save()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(m.scope.writes, [{ ops: [{ op: 'set', path: ['autoCompleteOnTurnEnd'], value: true }], revision: 1 }])
    html = m.render()
    assert.match(html, /role="switch" aria-checked="true"/)
    assert.ok(saveDisabled(html), 'clean after the Host accepted the write')
  })

  it('resets an overridden field to its default', async () => {
    const m = mount({ user: { autoCompleteOnTurnEnd: true } })
    let html = m.render()
    assert.match(html, /role="switch" aria-checked="true"/)
    assert.equal(html.match(/恢复默认/g).length, 1)
    m.actions.resetField('autoCompleteOnTurnEnd')
    html = m.render()
    assert.match(html, /role="switch" aria-checked="false"/)
    m.actions.save()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(m.scope.writes[0].ops, [{ op: 'unset', path: ['autoCompleteOnTurnEnd'] }])
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
})
