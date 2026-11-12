// Loads the browser half (client.js) against stand-in Client services: renders the
// user-message renderer with the real React from a built deepseek-harness checkout
// beside this plugin or its repository (or REACT_DIR), and drives the resend flow.
// Rendering tests are skipped without React.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const reactDir = process.env.REACT_DIR ?? ['../../deepseek-harness', '../../../../deepseek-harness']
  .map(root => fileURLToPath(new URL(`${root}/packages/client/ui-primitives`, import.meta.url)))
  .find(dir => existsSync(`${dir}/node_modules/react`))

let definition
let React
let renderToStaticMarkup

before(async () => {
  globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value } } }
  globalThis.document = { createElement: () => ({ dataset: {}, remove() {} }), head: { append() {} } }
  await import('../client.js')
  if (reactDir !== undefined) {
    const require = createRequire(`${reactDir}/package.json`)
    React = require('react')
    renderToStaticMarkup = require('react-dom/server').renderToStaticMarkup
  }
})

const ok = value => ({ ok: true, value })
const refused = (code, message = code) => ({ ok: false, error: { code, message } })

/** A settings form whose `archiveSource` value is fixed. */
function fakeForm(archiveSource) {
  const snapshot = { status: 'ready', value: archiveSource === undefined ? undefined : { archiveSource } }
  return { getSnapshot: () => snapshot, subscribe: () => () => {} }
}

/** Apply the module to stand-in services and capture its registration. */
function mount({ archiveSource = true, remote = {}, fork } = {}) {
  const calls = []
  const record = (name, value) => { calls.push([name, value]); return value }
  const registrations = []
  const ctx = {
    effect: (callback) => { callback(); return () => {} },
    locale: { register: () => () => {} },
    configForms: { get: () => fakeForm(archiveSource) },
    sessions: {
      fork: fork ?? (async (options) => { record('fork', options); return 'session-child' }),
    },
    uiWorkspace: {
      openSession: id => record('open', id),
      archiveSession: async (id, options) => { record('archive', { id, ...options }) },
    },
    remote: {
      session: {
        events: async (request) => { record('events', request); return ok({ records: [], hasMore: false }) },
        attachment: async (request) => {
          record('attachment', request)
          return ok({ attachment: request.attachment, data: 'aGVsbG8=' })
        },
        projections: async (request) => {
          record('projections', request)
          return request.sessionId === 'session-source'
            ? ok({ kind: 'sequenced', asOfSeq: 40, values: { modelSelection: { lastUsed: null, next: { provider: 'p', model: 'm2', reasoningEffort: 'high' } } } })
            : ok({ kind: 'sequenced', asOfSeq: 6, values: {
              inbox: { 'next-turn': [{ id: 'm-old' }], 'next-step': [] },
              modelSelection: { lastUsed: { provider: 'p', model: 'm1' }, next: { provider: 'p', model: 'm1' } },
            } })
        },
        selectModel: async (request) => { record('selectModel', request); return ok({ selected: request }) },
        updateQueue: async (request) => { record('updateQueue', request); return ok({ accepted: true }) },
        prompt: async (request) => { record('prompt', request); return ok({ accepted: true }) },
        ...remote,
      },
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    },
  }
  const plugin = definition.factory((id) => {
    if (id === 'react') return React ?? { memo: component => component }
    throw new Error(`unexpected module request ${id}`)
  })
  assert.equal(definition.id, '@pcmid/dsh-edit-prompt')
  plugin.apply(ctx)
  assert.equal(registrations.length, 1)
  const [{ options, component }] = registrations
  return { calls, options, component, face: options.inject('session-source'), plugin }
}

const IMAGE = { attachmentId: 'sha256:abc', mediaType: 'image/png', width: 1, height: 1, bytes: 5, name: 'shot.png' }

function stepLocation(turnStart) {
  const turn = { turn: 2, start: turnStart === undefined ? undefined : { type: 'turn/start', seq: turnStart }, status: 'closed' }
  return { kind: 'step', turn, step: { turn: 2, step: 1 } }
}

describe('registration', () => {
  it('shadows the shipped user renderer with its own locale', () => {
    const { options, plugin } = mount()
    assert.equal(options.name, 'conversation.chat.node')
    assert.equal(options.key, 'user')
    assert.ok(options.priority < 0)
    assert.equal(options.locale, 'editPrompt')
    assert.deepEqual(plugin.inject.slice().sort(), ['configForms', 'locale', 'remote', 'remote.session', 'sessions', 'slots', 'uiWorkspace'])
  })
})

describe('resend', () => {
  it('forks before the Turn, clears inherited input, prompts the edit with images, and archives the original', async () => {
    const { calls, face } = mount()
    const result = await face.resendEdited({
      seq: 11,
      location: stepLocation(7),
      content: [{ type: 'image', attachment: IMAGE }, { type: 'text', text: 'old' }],
      text: 'new text',
    })
    assert.deepEqual(result, { ok: true })
    const names = calls.map(([name]) => name)
    assert.deepEqual(names, ['attachment', 'projections', 'fork', 'projections', 'updateQueue', 'selectModel', 'prompt', 'open', 'archive'])
    assert.deepEqual(calls[1][1], { sessionId: 'session-source' })
    assert.deepEqual(calls[2][1], { sessionId: 'session-source', atSeq: 6, increaseTitle: false })
    assert.deepEqual(calls[3][1], { sessionId: 'session-child' })
    assert.deepEqual(calls[4][1], { sessionId: 'session-child', itemId: 'm-old', action: { kind: 'remove' } })
    assert.deepEqual(calls[5][1], { sessionId: 'session-child', provider: 'p', model: 'm2', reasoningEffort: 'high' })
    const prompt = calls[6][1]
    assert.equal(prompt.sessionId, 'session-child')
    assert.equal(prompt.mode, 'queue')
    assert.deepEqual(prompt.content, [
      { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=', name: 'shot.png' },
      { type: 'text', text: 'new text' },
    ])
    assert.equal(calls[7][1], 'session-child')
    assert.deepEqual(calls[8][1], { id: 'session-source', stopActivity: true })
  })

  it('leaves the inherited model alone when it already matches, and survives an unreadable selection', async () => {
    const same = mount({
      remote: {
        projections: async request => ok({ kind: 'sequenced', asOfSeq: 1, values: { modelSelection: { lastUsed: null, next: { provider: 'p', model: 'm1' } }, ...(request.sessionId === 'session-child' ? { inbox: { 'next-turn': [], 'next-step': [] } } : {}) } }),
      },
    })
    assert.deepEqual(await same.face.resendEdited({ seq: 11, location: stepLocation(7), content: [], text: 'x' }), { ok: true })
    assert.equal(same.calls.some(([name]) => name === 'selectModel' || name === 'updateQueue'), false)

    const unreadable = mount({
      remote: {
        projections: async request => request.sessionId === 'session-source'
          ? refused('gateway/internal')
          : ok({ kind: 'sequenced', asOfSeq: 1, values: { inbox: { 'next-turn': [], 'next-step': [] } } }),
      },
    })
    assert.deepEqual(await unreadable.face.resendEdited({ seq: 11, location: stepLocation(7), content: [], text: 'x' }), { ok: true })
    assert.equal(unreadable.calls.some(([name]) => name === 'selectModel'), false)
  })

  it('keeps the original and numbers the fork title when archiving is off', async () => {
    const { calls, face } = mount({ archiveSource: false })
    const result = await face.resendEdited({ seq: 11, location: stepLocation(7), content: [], text: 'x' })
    assert.deepEqual(result, { ok: true })
    assert.deepEqual(calls.find(([name]) => name === 'fork')[1], { sessionId: 'session-source', atSeq: 6, increaseTitle: true })
    assert.equal(calls.some(([name]) => name === 'archive'), false)
  })

  it('reads the Turn start from the Host log when the loaded window lacks it', async () => {
    const { calls, face } = mount({
      remote: {
        events: async () => ok({
          records: [
            { type: 'event', event: { type: 'turn/start', seq: 2 } },
            { type: 'event', event: { type: 'turn/end', seq: 5 } },
            { type: 'event', event: { type: 'turn/start', seq: 9 } },
          ],
          hasMore: true,
        }),
      },
    })
    const result = await face.resendEdited({ seq: 13, location: stepLocation(undefined), content: [], text: 'x' })
    assert.deepEqual(result, { ok: true })
    assert.equal(calls.find(([name]) => name === 'fork')[1].atSeq, 8)
  })

  it('reports a missing restart point without forking', async () => {
    const { calls, face } = mount()
    const result = await face.resendEdited({ seq: 3, location: { kind: 'unresolved' }, content: [], text: 'x' })
    assert.deepEqual(result, { ok: false, code: 'noBoundary' })
    assert.equal(calls.some(([name]) => name === 'fork'), false)
  })

  it('archives an unused fork and reports the refusal when the prompt fails', async () => {
    const { calls, face } = mount({ remote: { prompt: async () => refused('session/attachment-invalid', 'image too large') } })
    const result = await face.resendEdited({ seq: 11, location: stepLocation(7), content: [], text: 'x' })
    assert.deepEqual(result, { ok: false, code: 'failed', detail: 'image too large' })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls.filter(([name]) => name === 'archive').map(([, value]) => value), [{ id: 'session-child' }])
    assert.equal(calls.some(([name]) => name === 'open'), false)
  })

  it('reports a fork refusal and creates nothing else', async () => {
    const { calls, face } = mount({ fork: async () => { throw Object.assign(new Error('SessionForkError'), { error: { message: 'event 6 does not exist' } }) } })
    const result = await face.resendEdited({ seq: 11, location: stepLocation(7), content: [], text: 'x' })
    assert.deepEqual(result, { ok: false, code: 'failed', detail: 'event 6 does not exist' })
    assert.equal(calls.some(([name]) => name === 'prompt' || name === 'archive'), false)
  })
})

describe('rendering', () => {
  const t = (key, params) => params === undefined ? key : `${key}:${JSON.stringify(params)}`

  function render({ access = true } = {}) {
    const { component, face } = mount()
    const factoryCalls = []
    const markup = renderToStaticMarkup(React.createElement(component, {
      node: {
        kind: 'user',
        location: stepLocation(7),
        data: { kind: 'user', seq: 11, time: Date.now(), content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' }, skillNames: ['office'] },
      },
      t,
      loadImage: () => {},
      useAccess: () => access,
      renderFactorySlot: (name, props) => {
        factoryCalls.push([name, props])
        return React.createElement('div', { 'data-factory': name }, props.content.text)
      },
      ...face,
    }))
    return { markup, factoryCalls }
  }

  it('renders the content Factory, the clock, copy, and edit', { skip: reactDir === undefined }, () => {
    const { markup, factoryCalls } = render()
    assert.equal(factoryCalls.length, 1)
    assert.equal(factoryCalls[0][0], 'conversation.chat.user.content')
    assert.deepEqual(factoryCalls[0][1].content, { text: 'hello', attachments: [], extraBlocks: [] })
    assert.deepEqual(factoryCalls[0][1].facts, { skillNames: ['office'] })
    assert.equal(factoryCalls[0][1].interactive, true)
    assert.match(markup, /aria-label="copy"/)
    assert.match(markup, /aria-label="edit"/)
    assert.match(markup, /#dsw-icon-edit-outline-regular/)
    assert.match(markup, /class="dsh-ep-time">\d\d:\d\d</)
  })

  it('hides edit when the Session refuses forks', { skip: reactDir === undefined }, () => {
    const { markup } = render({ access: false })
    assert.match(markup, /aria-label="copy"/)
    assert.doesNotMatch(markup, /aria-label="edit"/)
  })
})
