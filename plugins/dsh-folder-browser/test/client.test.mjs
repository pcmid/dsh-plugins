// Loads the browser half (client.js) against stand-in Client services and drives the
// folder dialog in jsdom with the real React from a built deepseek-harness checkout
// beside this plugin or its repository (or REACT_DIR). Skipped without React/jsdom.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { after, before, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const harness = process.env.HARNESS_DIR ?? ['../../deepseek-harness', '../../../../deepseek-harness']
  .map(root => fileURLToPath(new URL(root, import.meta.url)))
  .find(dir => existsSync(`${dir}/packages/client/ui-primitives/node_modules/react`) && existsSync(`${dir}/node_modules/jsdom`))
const skip = harness === undefined ? 'needs a built deepseek-harness checkout (React and jsdom)' : false

const HOME = '/home/me'
/** In-memory Host disk: directory → child directory names (names starting with "." are hidden). */
function makeDisk() {
  return new Map([
    ['/', ['home', 'srv']],
    ['/home', ['me']],
    [HOME, ['.config', 'Developer', 'Documents', 'dev-notes']],
    [`${HOME}/.config`, []],
    [`${HOME}/Developer`, ['dsh', 'website']],
    [`${HOME}/Developer/dsh`, ['deepseek-harness', 'dsh-plugins']],
    [`${HOME}/Developer/dsh/deepseek-harness`, []],
    [`${HOME}/Developer/dsh/dsh-plugins`, []],
    [`${HOME}/Developer/website`, []],
    [`${HOME}/Documents`, []],
    [`${HOME}/dev-notes`, []],
    ['/srv', []],
  ])
}
const join = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`)
function crumbsOf(path) {
  const crumbs = [{ name: '/', path: '/', hidden: false }]
  let at = ''
  for (const part of path.split('/').filter(Boolean)) {
    at += `/${part}`
    crumbs.push({ name: part, path: at, hidden: part.startsWith('.') })
  }
  return crumbs
}

let React, ReactDOMClient, JSDOM, definition, dom
const mounts = []

before(async () => {
  if (skip) return
  const reactRequire = createRequire(`${harness}/packages/client/ui-primitives/package.json`)
  JSDOM = createRequire(`${harness}/package.json`)('jsdom').JSDOM
  dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true })
  const { window } = dom
  // jsdom has no modal dialogs or media queries.
  window.HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', '') }
  window.HTMLDialogElement.prototype.close = function close() { this.removeAttribute('open') }
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {}
  window.matchMedia = () => ({ matches: false })
  window.__ModuleLoader__ = { load: (value) => { definition = value } }
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'KeyboardEvent', 'Event', 'MouseEvent']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? window : window[key], configurable: true, writable: true })
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // react-dom samples the DOM globals when it loads, so it comes after them.
  React = reactRequire('react')
  ReactDOMClient = reactRequire('react-dom/client')
  await import('../client.js')
})

after(() => { dom?.window.close() })
beforeEach(async () => {
  while (mounts.length > 0) await mounts.pop()()
})

/** Apply the module to stand-in services, render one directory-flow occupant, and return handles. */
async function mount({ workspaces = [], disk = makeDisk(), busy = false, gate, truncated = new Set() } = {}) {
  const registrations = []
  let dictionaries
  const calls = []
  const ctx = {
    effect: (callback) => { callback() },
    locale: {
      register: (_ns, dicts) => { dictionaries = dicts; return () => {} },
      bind: () => key => dictionaries.en[key] ?? key,
    },
    uiWorkspace: {
      listDirectory: async (path = HOME, signal) => {
        calls.push(['list', path])
        if (gate !== undefined && path !== HOME) await gate.promise
        if (signal?.aborted) throw signal.reason
        const children = disk.get(path)
        if (children === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { rpcError: { message: `no such directory: ${path}` } })
        return {
          path,
          home: HOME,
          crumbs: crumbsOf(path),
          entries: children.map(name => ({ name, path: join(path, name), hidden: name.startsWith('.') })),
          truncated: truncated.has(path),
        }
      },
      createDirectory: async (path, name) => {
        calls.push(['create', path, name])
        const created = join(path, name)
        disk.set(path, [...disk.get(path), name].sort())
        disk.set(created, [])
        return created
      },
    },
    slots: {
      inject: (_name, callback) => {
        const result = callback()
        if (result && typeof result[Symbol.iterator] === 'function') for (const _ of result) { /* drain */ }
      },
      register: (options, Component) => { registrations.push({ options, Component }); return () => {} },
    },
  }
  const plugin = definition.factory((id) => {
    assert.equal(id, 'react')
    return React
  })
  plugin.apply(ctx)
  assert.deepEqual(registrations.map(r => r.options.name), [
    'conversation.hero.workspace.directoryFlow',
    'sidebar.workspaces.directoryFlow',
    'workspace.picker.directoryFlow',
  ])
  const { Component, options } = registrations[1]
  const container = document.createElement('div')
  document.body.append(container)
  const root = ReactDOMClient.createRoot(container)
  const outcome = { picked: [], cancelled: 0 }
  const props = {
    open: true,
    busy,
    onPicked: (path) => { outcome.picked.push(path) },
    onCancel: () => { outcome.cancelled += 1 },
    onError: (message) => { throw new Error(`unexpected onError: ${message}`) },
    useWorkspaces: selector => selector({ items: workspaces }),
    ...options.inject(),
  }
  await act(() => { root.render(React.createElement(Component, props)) })
  await settle()
  mounts.push(async () => { await act(() => { root.unmount() }); container.remove() })
  return { container, outcome, calls }
}

async function act(callback) {
  await React.act(async () => { await callback() })
}
async function settle() {
  for (let i = 0; i < 5; i += 1) await act(() => new Promise(resolve => setTimeout(resolve, 0)))
}

const field = () => document.querySelector('.dsh-fb-input')
const rowNames = () => [...document.querySelectorAll('.dsh-fb-row')].map(row => row.querySelector('.dsh-fb-row-name').textContent)
const activeRow = () => document.querySelector('.dsh-fb-row[aria-selected="true"] .dsh-fb-row-name')?.textContent ?? null
const primary = () => document.querySelector('.dsh-fb-btn[data-variant="primary"]')

async function type(text) {
  const input = field()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  await act(() => {
    setter.call(input, text)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await settle()
}
async function press(key, init = {}) {
  const input = field()
  if (key === 'Backspace') input.setSelectionRange(input.value.length, input.value.length)
  await act(() => { input.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })
  await settle()
}
async function click(element) {
  await act(() => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })) })
  await settle()
}

describe('folder browser dialog', { skip }, () => {
  it('opens at the Host home and hides dot folders until asked', async () => {
    await mount()
    assert.equal(field().value, '~/')
    assert.deepEqual(rowNames(), ['Developer', 'Documents', 'dev-notes'])
    assert.equal(activeRow(), null)
    assert.match(primary().textContent, /^Openme$/)
    await click(document.querySelector('.dsh-fb-icon-btn[aria-pressed]'))
    assert.deepEqual(rowNames(), ['.config', 'Developer', 'Documents', 'dev-notes'])
  })

  it('filters by the typed segment, prefix matches first, and Enter goes in', async () => {
    await mount()
    await type('~/dev')
    assert.deepEqual(rowNames(), ['Developer', 'dev-notes', 'New folder "dev"'])
    assert.equal(activeRow(), 'Developer')
    assert.equal(document.querySelector('.dsh-fb-row[aria-selected="true"] mark').textContent, 'Dev')
    await press('ArrowDown')
    assert.equal(activeRow(), 'dev-notes')
    await press('ArrowUp')
    await press('Enter')
    assert.equal(field().value, '~/Developer/')
    assert.deepEqual(rowNames(), ['dsh', 'website'])
  })

  it('Tab completes into the highlighted folder and Backspace on an empty segment goes up', async () => {
    await mount()
    await type('~/Developer/ds')
    await press('Tab')
    assert.equal(field().value, '~/Developer/dsh/')
    assert.deepEqual(rowNames(), ['deepseek-harness', 'dsh-plugins'])
    await press('Backspace')
    assert.equal(field().value, '~/Developer/')
    await press('Backspace')
    await press('Backspace')
    assert.equal(field().value, '/home/')
  })

  it('Enter with nothing highlighted opens the current folder; Ctrl+Enter opens the highlighted one', async () => {
    const { outcome } = await mount()
    await type('~/Developer/')
    assert.match(primary().textContent, /Developer$/)
    await press('Enter')
    assert.deepEqual(outcome.picked, [`${HOME}/Developer`])
    await type('~/Developer/web')
    assert.match(primary().textContent, /website$/)
    await press('Enter', { ctrlKey: true })
    assert.deepEqual(outcome.picked, [`${HOME}/Developer`, `${HOME}/Developer/website`])
  })

  it('ignores Enter and clicks on the previous folder while the next one loads', async () => {
    let release
    const gate = { promise: new Promise((resolve) => { release = resolve }) }
    const { outcome } = await mount({ gate })
    await type('~/Developer/d')
    assert.equal(document.querySelector('.dsh-fb-list').hasAttribute('data-stale'), true)
    assert.equal(activeRow(), null)
    assert.equal(primary().disabled, true)
    await press('Enter')
    await press('Enter', { ctrlKey: true })
    await click(document.querySelector('.dsh-fb-row'))
    assert.equal(field().value, '~/Developer/d')
    assert.deepEqual(outcome.picked, [])
    await act(() => { release() })
    await settle()
    assert.deepEqual(rowNames(), ['dsh', 'New folder "d"'])
    assert.equal(activeRow(), 'dsh')
  })

  it('ignores the Enter that confirms an IME composition and auto-repeated Enters', async () => {
    const { outcome } = await mount()
    await type('~/Developer/')
    await press('Enter', { keyCode: 229 })
    await press('Enter', { repeat: true })
    assert.deepEqual(outcome.picked, [])
    await press('Enter')
    assert.deepEqual(outcome.picked, [`${HOME}/Developer`])
  })

  it('offers to go to an unlisted name in a cut-off folder instead of creating it', async () => {
    const { calls } = await mount({ truncated: new Set([HOME]) })
    assert.match(document.querySelector('.dsh-fb-note').textContent, /type its full name followed by \//)
    await type('~/srv-data')
    assert.deepEqual(rowNames(), ['Go to "srv-data"'])
    await press('ArrowDown')
    await press('Enter')
    assert.equal(field().value, '~/srv-data/')
    assert.deepEqual(calls.filter(call => call[0] === 'create'), [])
  })

  it('a row click goes in and its Open button picks it', async () => {
    const { outcome } = await mount()
    const developer = [...document.querySelectorAll('.dsh-fb-row')].find(row => row.textContent.includes('Developer'))
    await click(developer.querySelector('.dsh-fb-row-open'))
    assert.deepEqual(outcome.picked, [`${HOME}/Developer`])
    await click(developer)
    assert.equal(field().value, '~/Developer/')
  })

  it('creates a missing folder from the typed name and moves into it', async () => {
    const { calls } = await mount()
    await type('~/Developer/new-app')
    assert.deepEqual(rowNames(), ['New folder "new-app"'])
    assert.match(document.querySelector('.dsh-fb-nomatch').textContent, /No folders match "new-app"/)
    // A typo must not create a folder: the suggestion is not highlighted until ↓.
    assert.equal(activeRow(), null)
    await press('Enter')
    assert.deepEqual(calls.filter(call => call[0] === 'create'), [])
    await press('ArrowDown')
    assert.equal(activeRow(), 'New folder "new-app"')
    await press('Enter')
    assert.deepEqual(calls.filter(call => call[0] === 'create'), [['create', `${HOME}/Developer`, 'new-app']])
    assert.equal(field().value, '~/Developer/new-app/')
    assert.match(primary().textContent, /new-app$/)
    await press('Backspace')
    assert.ok(rowNames().includes('new-app'), 'the parent listing is refreshed after creating')
  })

  it('the New folder button opens an inline name row', async () => {
    const { calls } = await mount()
    await click(document.querySelector('.dsh-fb-btn[data-variant="ghost"]'))
    const input = document.querySelector('.dsh-fb-draft-input')
    assert.ok(input)
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    await act(() => { setter.call(input, 'scratch'); input.dispatchEvent(new window.Event('input', { bubbles: true })) })
    await act(() => { input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    await settle()
    assert.deepEqual(calls.filter(call => call[0] === 'create'), [['create', HOME, 'scratch']])
    assert.equal(field().value, '~/scratch/')
  })

  it('shows quick locations from the folders that hold workspaces', async () => {
    await mount({
      workspaces: [
        { path: `${HOME}/Developer/dsh/deepseek-harness`, updatedAt: '2026-11-10T00:00:00Z' },
        { path: `${HOME}/Developer/dsh/dsh-plugins`, updatedAt: '2026-11-12T00:00:00Z' },
        { path: `${HOME}/Developer/website`, updatedAt: '2026-11-13T00:00:00Z' },
        { path: `${HOME}/notes`, updatedAt: '2026-11-13T00:00:00Z' },
      ],
    })
    const chips = [...document.querySelectorAll('.dsh-fb-chip')]
    assert.deepEqual(chips.map(chip => chip.textContent), ['Home', '~/Developer/dsh', '~/Developer', '/'])
    await click(chips[1])
    assert.equal(field().value, '~/Developer/dsh/')
    assert.equal(document.querySelectorAll('.dsh-fb-badge').length, 2)
  })

  it('reports an unreadable path in place and retries', async () => {
    await mount()
    await type('~/missing/')
    assert.match(document.querySelector('.dsh-fb-state').textContent, /no such directory/)
    await type('relative/')
    assert.match(document.querySelector('.dsh-fb-state').textContent, /starts with \/ or ~/)
  })

  it('Escape cancels, but first closes an open new-folder row', async () => {
    const { outcome } = await mount()
    const dialog = document.querySelector('dialog')
    await click(document.querySelector('.dsh-fb-btn[data-variant="ghost"]'))
    await act(() => { dialog.dispatchEvent(new window.Event('cancel', { cancelable: true })) })
    assert.equal(document.querySelector('.dsh-fb-draft-input'), null)
    assert.equal(outcome.cancelled, 0)
    await act(() => { dialog.dispatchEvent(new window.Event('cancel', { cancelable: true })) })
    assert.equal(outcome.cancelled, 1)
  })

  it('shows its purpose and locks while the owner adopts the folder', async () => {
    const { outcome } = await mount({ busy: true })
    assert.equal(document.querySelector('.dsh-fb-title').textContent, 'Choose a workspace folder')
    assert.equal(primary().getAttribute('aria-busy'), 'true')
    assert.match(primary().textContent, /Opening/)
    assert.equal(document.querySelector('.dsh-fb-body').hasAttribute('inert'), true)
    await press('Enter')
    assert.deepEqual(outcome.picked, [])
  })

  it('renders nothing while the owner has no pick open', async () => {
    const registrations = []
    const plugin = definition.factory(() => React)
    plugin.apply({
      effect: (callback) => { callback() },
      locale: { register: () => () => {}, bind: () => key => key },
      uiWorkspace: {},
      slots: {
        inject: (_name, callback) => { const result = callback(); if (result?.[Symbol.iterator]) for (const _ of result) { /* drain */ } },
        register: (options, Component) => { registrations.push(Component) },
      },
    })
    assert.equal(registrations[0]({ open: false }), null)
  })
})
