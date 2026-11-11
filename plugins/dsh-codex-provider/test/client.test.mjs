import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

// Reuse the Harness checkout's UI test packages, or an explicitly supplied package anchor.
const testPackage = process.env.DSH_CLIENT_TEST_PACKAGE ?? ['../../deepseek-harness', '../../../../deepseek-harness']
  .map(root => fileURLToPath(new URL(`${root}/node_modules/@testing-library/react/package.json`, import.meta.url)))
  .find(existsSync) ?? fileURLToPath(new URL('../package.json', import.meta.url))
const require = createRequire(realpathSync(testPackage))
const { JSDOM } = require('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const React = require('react')
const { render, fireEvent, waitFor, cleanup } = require('@testing-library/react')

function load() {
  let plugin, component, registration, dictionary
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { plugin = value.factory(require) } } },
  })
  const state = { snapshot: { status: 'ready', value: { providers: {} }, writable: true, revision: 1 }, accepted: true, mutations: [] }
  const listeners = new Set()
  const scope = {
    getSnapshot: () => state.snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async mutate(ops, revision) {
      state.mutations.push(JSON.parse(JSON.stringify({ ops, revision })))
      if (!state.accepted) return false
      state.snapshot = { ...state.snapshot, revision: revision + 1, value: { providers: { 'codex-provider': ops[0].value } } }
      for (const listener of listeners) listener()
      return true
    },
  }
  plugin.apply({
    effect: callback => callback(),
    locale: { register(_ns, values) { dictionary = values.zh }, bind: () => key => dictionary[key] },
    configForms: { get: () => scope, whileServed: (_names, callback) => callback() },
    slots: { inject: (_name, callback) => callback(), register(spec, Component) { registration = spec; component = Component } },
  })
  return { state, card: () => React.createElement(component, { ...registration.inject(), configured: false }) }
}

// The Models page markup around the slot: the generic editor, ending in its Cancel/Apply row.
const h = React.createElement
const pageEditor = onCancel => h('div', { className: 'editor' }, h('p', null, 'generic hint'),
  h('div', null, h('button', { type: 'button', onClick: onCancel }, 'page cancel'), h('button', { type: 'button', disabled: true }, 'page apply')))
const anchor = card => h('div', { 'data-slot': 'settings.models.provider-card', style: { display: 'contents' } }, card)

test('on a saved row the card edits the Codex path and closes the page editor', async () => {
  const { state, card } = load()
  let closed = 0
  const view = render(h('ul', null, h('li', null, h('div', null, 'Codex Provider'), anchor(card()), pageEditor(() => closed++))))
  try {
    assert.equal(view.getByRole('textbox', { name: 'codex 路径' }).value, '')
    fireEvent.click(view.getByRole('button', { name: '取消' }))
    assert.equal(closed, 1, 'Cancel closes through the page editor')
    assert.equal(state.mutations.length, 0, 'Viewing the card must not start Codex')
    fireEvent.change(view.getByRole('textbox'), { target: { value: '  /opt/Codex CLI/codex  ' } })
    fireEvent.click(view.getByRole('button', { name: '保存' }))
    await waitFor(() => assert.equal(closed, 2))
    assert.deepEqual(state.mutations[0], { revision: 1, ops: [{ op: 'set', path: ['providers', 'codex-provider'], value: { codexPath: '/opt/Codex CLI/codex' } }] })
    assert.equal(view.getByRole('textbox').value, '/opt/Codex CLI/codex')
    state.accepted = false
    fireEvent.click(view.getByRole('button', { name: '保存' }))
    await waitFor(() => assert.equal(view.getByRole('alert').textContent, '保存失败，请重试。'))
    assert.equal(closed, 2, 'A failed save keeps the editor open')
  } finally { cleanup() }
})

test('on the add card an empty path enables the provider with codex from PATH', async () => {
  const { state, card } = load()
  let closed = 0
  const view = render(h('div', null, h('div', null, 'provider select'), pageEditor(() => closed++), anchor(card())))
  try {
    fireEvent.click(view.getByRole('button', { name: '保存' }))
    await waitFor(() => assert.equal(closed, 1))
    assert.deepEqual(state.mutations[0].ops[0], { op: 'set', path: ['providers', 'codex-provider'], value: {} })
  } finally { cleanup() }
})
