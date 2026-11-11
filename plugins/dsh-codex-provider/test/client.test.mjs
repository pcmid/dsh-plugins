import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

// Reuse the Harness checkout's UI test packages, or an explicitly supplied package anchor.
const anchor = process.env.DSH_CLIENT_TEST_PACKAGE ?? ['../../deepseek-harness', '../../../../deepseek-harness']
  .map(root => fileURLToPath(new URL(`${root}/node_modules/@testing-library/react/package.json`, import.meta.url)))
  .find(existsSync) ?? fileURLToPath(new URL('../package.json', import.meta.url))
const require = createRequire(realpathSync(anchor))
const { JSDOM } = require('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const React = require('react')
const { render, fireEvent, waitFor, cleanup } = require('@testing-library/react')

test('provider card starts collapsed, enables only on save and persists advanced options', async () => {
  let plugin, component, registration, dictionary
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { plugin = value.factory(require) } } },
  })
  let snapshot = { status: 'ready', value: { providers: {} }, writable: true, revision: 1 }
  const listeners = new Set()
  const mutations = []
  let accepted = true
  const scope = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async mutate(ops, revision) {
      mutations.push(JSON.parse(JSON.stringify({ ops, revision })))
      if (!accepted) return false
      snapshot = { ...snapshot, revision: revision + 1, value: { providers: { 'codex-provider': { advanced: ops[0].value } } } }
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
  const view = render(React.createElement(component, { ...registration.inject(), configured: false }))
  try {
    assert.equal(view.container.querySelector('details').open, false)
    assert.equal(view.getByRole('textbox', { hidden: true }).value, '')
    assert.equal(view.getByRole('checkbox', { hidden: true }).checked, false)
    assert.equal(mutations.length, 0, 'Viewing/selecting the card must not start Codex')
    fireEvent.click(view.getByRole('button', { name: '使用 Codex Provider' }))
    await waitFor(() => assert.equal(view.getByRole('status').textContent, '已保存'))
    assert.deepEqual(mutations[0], { revision: 1, ops: [{ op: 'set',
      path: ['providers', 'codex-provider', 'advanced'], value: { interceptNativeTools: false } }] })
    view.rerender(React.createElement(component, { ...registration.inject(), configured: true }))
    fireEvent.click(view.getByText('高级设置（选填）'))
    fireEvent.change(view.getByRole('textbox'), { target: { value: '  /opt/Codex CLI/codex  ' } })
    fireEvent.click(view.getByRole('checkbox'))
    fireEvent.click(view.getByRole('button', { name: '保存' }))
    await waitFor(() => assert.equal(view.getByRole('status').textContent, '已保存'))
    assert.deepEqual(mutations.at(-1).ops[0].value, { command: '/opt/Codex CLI/codex', interceptNativeTools: true })
    accepted = false
    fireEvent.click(view.getByRole('button', { name: '保存' }))
    await waitFor(() => assert.equal(view.getByRole('status').textContent, '保存失败，请重试。'))
  } finally { cleanup() }
})
