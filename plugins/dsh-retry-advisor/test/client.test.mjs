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

/** Load the module and apply it to a stand-in browser context. */
function mount() {
  const registrations = []
  const dictionaries = {}
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
    slots: {
      inject: (_name, register) => register(),
      register: (options, Component) => { registrations.push({ options, Component }); return () => {} },
    },
  })
  const row = registrations.find(entry => entry.options.name === 'conversation.chat.node')
  const renderRow = (data) => {
    const dictionary = dictionaries[row.options.locale].zh
    const translate = (key, params = {}) => dictionary[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name]))
    return renderToStaticMarkup(React.createElement(row.Component, { node: { data }, t: translate }))
  }
  return { plugin, registrations, row, dictionaries, conversationEvents, renderRow }
}

describe('browser half', { skip: primitivesDir === undefined && 'no built deepseek-harness checkout with ui-primitives' }, () => {
  it('registers the Chat rows and nothing on the plugin page', () => {
    const m = mount()
    assert.deepEqual(m.plugin.inject, ['slots', 'locale', 'uiConversation'])
    assert.equal(m.conversationEvents.length, 1)
    assert.deepEqual(m.registrations.map(entry => entry.options.name), ['conversation.chat.node'])
    const { zh, en } = m.dictionaries[m.row.options.locale]
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  })

  it('titles retries by their delay', () => {
    const m = mount()
    const base = { id: 'r', outcome: 'retry', granted: 0, maxRetries: 3, delayMs: 0 }
    assert.match(m.renderRow(base), /立即重试（第 1\/3 次）/)
    assert.match(m.renderRow({ ...base, granted: 1, delayMs: 4000 }), /4 秒后重试（第 2\/3 次）/)
  })

  it('shows a retry recorded by the removed drop-invalid-thinking repair as an immediate retry', () => {
    const m = mount()
    const html = m.renderRow({ id: 'r', outcome: 'retry', granted: 0, maxRetries: 3, delayMs: 0, fix: 'drop-invalid-thinking', cause: '思考无效' })
    assert.match(html, /立即重试（第 1\/3 次）/)
    assert.match(html, /思考无效/)
  })
})
