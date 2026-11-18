// Loads the browser half (client.js) against stand-in Client services. The helper,
// registration and polling tests need nothing else. The rendering tests drive the strip in
// jsdom with the real React of a deepseek-harness source checkout whose dependencies are
// installed: HARNESS_DIR, or a `deepseek-harness` directory beside any ancestor of this
// plugin (the repository or one of its worktrees). They are skipped without one.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { after, afterEach, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

function findHarness() {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = path.join(dir, 'deepseek-harness')
    if (existsSync(`${candidate}/packages/client/ui-primitives/node_modules/react`) && existsSync(`${candidate}/node_modules/jsdom`)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}
const harness = process.env.HARNESS_DIR ?? findHarness()
const skip = harness === undefined ? 'needs a deepseek-harness checkout with React and jsdom installed' : false

/** A fixed clock for answers and elapsed times. */
const NOW = 1_800_000_100_000
/** The header joins its counts with en spaces around the dot. */
const DOT = '\u2002·\u2002'

let React, ReactDOMClient, dom, definition
/** What `document.visibilityState` reads. */
let visibility = 'visible'
/** Undo what a test mounted. */
const cleanups = []

before(async () => {
  if (harness === undefined) {
    globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value } } }
    globalThis.document = { createElement: () => ({ dataset: {}, remove() {} }), head: { append() {} } }
  } else {
    const { JSDOM } = createRequire(`${harness}/package.json`)('jsdom')
    dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true })
    const { window } = dom
    window.__ModuleLoader__ = { load: (value) => { definition = value } }
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'MouseEvent']) {
      Object.defineProperty(globalThis, key, { value: key === 'window' ? window : window[key], configurable: true, writable: true })
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    // react-dom samples the DOM globals when it loads, so it comes after them.
    const reactRequire = createRequire(`${harness}/packages/client/ui-primitives/package.json`)
    React = reactRequire('react')
    ReactDOMClient = reactRequire('react-dom/client')
  }
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  await import('../client.js')
})

after(() => { dom?.window.close() })
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()()
  visibility = 'visible'
})

const ok = agents => ({ ok: true, value: { agents } })

/** Let the promises of a request settle. `setImmediate` stays real under the mocked timers. */
const flush = () => new Promise(resolve => setImmediate(resolve))

/** The translate function DSH hands the strip: one registered dictionary, with `{name}` filled in. */
const translate = dictionary => (key, params) => {
  const template = dictionary[key] ?? key
  return params === undefined ? template : template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match)
}

/**
 * Apply the module to stand-in services and capture what it registers.
 * `answer` is the Host: it receives a request's payload and returns the RPC result, or throws.
 */
function mount({ answer = () => ok([]) } = {}) {
  const registrations = []
  const slots = []
  const dictionaries = {}
  const disposers = []
  const calls = []
  const plugin = definition.factory((id) => {
    assert.equal(id, 'react')
    return React ?? { createElement() {}, useState() {} }
  })
  plugin.apply({
    effect: (callback) => {
      const dispose = callback()
      disposers.push(dispose)
      return dispose
    },
    locale: { register: (ns, value) => { dictionaries[ns] = value; return () => {} } },
    connection: {
      rpc: {
        call: async (channel, endpoint, payload) => {
          calls.push([channel, endpoint, payload])
          return answer(payload)
        },
      },
    },
    slots: {
      inject: (slot, callback) => { slots.push(slot); return callback() },
      register: (options, Component) => { registrations.push({ options, Component }); return () => {} },
    },
  })
  assert.equal(registrations.length, 1)
  const [{ options, Component }] = registrations
  return {
    plugin, slots, options, Component, dictionaries, calls,
    helpers: plugin.__helpers,
    t: (language = 'en') => translate(dictionaries[options.locale][language]),
    unload: () => { for (const dispose of disposers.reverse()) dispose() },
  }
}

describe('registration', () => {
  it('adds one strip to the composer dock, between the task list and the goal bar', () => {
    const m = mount()
    assert.equal(definition.id, '@pcmid/dsh-agent-monitor')
    assert.deepEqual(m.plugin.inject, ['slots', 'locale', 'connection'])
    assert.deepEqual(m.slots, ['conversation.input.dock'])
    assert.equal(m.options.name, 'conversation.input.dock')
    assert.equal(m.options.id, 'agent-monitor')
    assert.equal(m.options.order, 6)
    assert.equal(m.options.locale, 'agentMonitor')
    assert.deepEqual(Object.keys(m.dictionaries), ['agentMonitor'])
  })

  it('registers Chinese and English copy with the same keys and placeholders', () => {
    const { zh, en } = mount().dictionaries.agentMonitor
    const placeholders = text => (text.match(/\{\w+\}/g) ?? []).sort()
    assert.deepEqual(Object.keys(zh), Object.keys(en))
    for (const key of Object.keys(en)) assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), key)
    assert.equal(en.goalWaiting, 'Goal: waiting for background work before the next round')
    assert.equal(zh.goalWaiting, '目标：等待后台工作，之后开始下一轮')
  })
})

describe('helpers', () => {
  const row = (state, more = {}) => ({ id: state, depth: 1, name: state, state, subagents: 0, queued: 0, ...more })

  it('shows the strip for more than one agent, a job of the session agent, or a waiting goal', () => {
    const { visible } = mount().helpers
    assert.equal(visible([]), false)
    assert.equal(visible([row('idle')]), false)
    assert.equal(visible([row('running', { jobs: [] })]), false)
    assert.equal(visible([row('idle'), row('running')]), true)
    assert.equal(visible([row('waiting', { jobs: [{ kind: 'bash', label: 'make', status: 'running' }] })]), true)
    assert.equal(visible([row('idle', { goalWaiting: true })]), true)
  })

  it('summarizes the agents per state, leaving out zero counts', () => {
    const m = mount()
    const { summary } = m.helpers
    const agents = [row('waiting'), row('running'), row('running'), row('queued'), row('idle')]
    assert.equal(summary(agents, m.t()), `2 working${DOT}1 waiting for background work${DOT}2 idle`)
    assert.equal(summary(agents, m.t('zh')), `2 个运行中${DOT}1 个等待后台工作${DOT}2 个空闲`)
    // An agent with queued messages counts as idle.
    assert.equal(summary([row('queued')], m.t()), '1 idle')
    assert.equal(summary([row('running'), row('idle')], m.t()), `1 working${DOT}1 idle`)
    assert.equal(summary([row('waiting')], m.t()), '1 waiting for background work')
  })

  it('writes a duration in its two largest units', () => {
    const m = mount()
    const { formatElapsed } = m.helpers
    const en = ms => formatElapsed(ms, m.t())
    assert.equal(en(0), '0s')
    assert.equal(en(999), '0s')
    assert.equal(en(42_000), '42s')
    assert.equal(en(59_999), '59s')
    assert.equal(en(60_000), '1m 0s')
    assert.equal(en(185_400), '3m 5s')
    assert.equal(en(3_599_000), '59m 59s')
    assert.equal(en(3_600_000), '1h 0m')
    assert.equal(en(7_659_000), '2h 7m')
    assert.equal(en(90_061_000), '25h 1m')
    // The Host's clock may be ahead of the browser's.
    assert.equal(en(-5000), '0s')
    const zh = ms => formatElapsed(ms, m.t('zh'))
    assert.deepEqual([zh(42_000), zh(185_400), zh(7_659_000)], ['42秒', '3分5秒', '2小时7分'])
  })

  it('says what an agent is doing', () => {
    const m = mount()
    const text = one => m.helpers.rowText(one, m.t())
    assert.equal(text(row('running', { activity: { tool: 'bash', summary: 'npm test' } })), 'bash · npm test')
    assert.equal(text(row('running', { activity: { tool: 'todo_write' } })), 'todo_write')
    assert.equal(text(row('running')), 'Thinking')
    assert.equal(text(row('waiting')), 'Waiting for background work')
    assert.equal(text(row('queued')), 'Has queued messages')
    assert.equal(text(row('idle')), 'Idle')
    // A tool call is shown only while the agent runs.
    assert.equal(text(row('idle', { activity: { tool: 'bash', summary: 'npm test' } })), 'Idle')
    assert.equal(m.helpers.rowText(row('running'), m.t('zh')), '思考中')
  })
})

describe('polling', () => {
  const ROWS = [{ id: 's1', depth: 0, name: '', state: 'waiting', subagents: 1, queued: 0 }, { id: 'c1', depth: 1, name: 'builder', state: 'running', subagents: 0, queued: 0 }]
  /** The store of one session, as the dock's `inject` hands it to the renderer. */
  const storeOf = (m, sessionId = 's1') => m.options.inject(sessionId).hooks.agentMonitor
  const clock = t => t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: NOW })

  it('asks the Host for its session at once, then every two seconds, until nobody listens', async (t) => {
    clock(t)
    const m = mount({ answer: () => ok(structuredClone(ROWS)) })
    const store = storeOf(m)
    assert.deepEqual(store.getSnapshot(), { agents: [], at: 0 })
    assert.deepEqual(m.calls, [])
    let notified = 0
    const stop = store.subscribe(() => { notified += 1 })
    await flush()
    assert.deepEqual(m.calls, [['/api', 'pcmid/agent-monitor/snapshot', { sessionId: 's1' }]])
    assert.deepEqual(store.getSnapshot(), { agents: ROWS, at: NOW })
    assert.equal(notified, 1)
    t.mock.timers.tick(1999)
    await flush()
    assert.equal(m.calls.length, 1)
    t.mock.timers.tick(1)
    await flush()
    assert.equal(m.calls.length, 2)
    // A second listener starts no second timer.
    const stopSecond = store.subscribe(() => {})
    t.mock.timers.tick(2000)
    await flush()
    assert.equal(m.calls.length, 3)
    stop()
    t.mock.timers.tick(2000)
    await flush()
    assert.equal(m.calls.length, 4)
    stopSecond()
    t.mock.timers.tick(60_000)
    await flush()
    assert.equal(m.calls.length, 4)
    // A new listener starts over.
    cleanups.push(store.subscribe(() => {}))
    await flush()
    assert.equal(m.calls.length, 5)
  })

  it('replaces the rows only when the answer changed, and dates every answer', async (t) => {
    clock(t)
    let rows = ROWS
    const m = mount({ answer: () => ok(structuredClone(rows)) })
    const store = storeOf(m)
    let notified = 0
    cleanups.push(store.subscribe(() => { notified += 1 }))
    await flush()
    const first = store.getSnapshot()
    t.mock.timers.tick(2000)
    await flush()
    const second = store.getSnapshot()
    assert.equal(second.agents, first.agents)
    assert.equal(second.at, NOW + 2000)
    rows = [ROWS[0]]
    t.mock.timers.tick(2000)
    await flush()
    const third = store.getSnapshot()
    assert.notEqual(third.agents, first.agents)
    assert.deepEqual(third, { agents: [ROWS[0]], at: NOW + 4000 })
    assert.equal(notified, 3)
  })

  it('keeps the last answer when a request fails, and asks again at the next tick', async (t) => {
    clock(t)
    const answers = [
      ok(ROWS),
      new Error('offline'),
      { ok: false, error: { code: 'internal', message: 'log unavailable', details: {} } },
      ok([ROWS[0]]),
    ]
    const m = mount({
      answer: () => {
        const next = answers.shift()
        if (next instanceof Error) throw next
        return next
      },
    })
    const store = storeOf(m)
    let notified = 0
    cleanups.push(store.subscribe(() => { notified += 1 }))
    await flush()
    const first = store.getSnapshot()
    assert.deepEqual(first.agents, ROWS)
    for (const failed of [2, 3]) {
      t.mock.timers.tick(2000)
      await flush()
      assert.equal(m.calls.length, failed)
      assert.equal(store.getSnapshot(), first)
      assert.equal(notified, 1)
    }
    t.mock.timers.tick(2000)
    await flush()
    assert.deepEqual(store.getSnapshot(), { agents: [ROWS[0]], at: NOW + 6000 })
    assert.equal(notified, 2)
  })

  it('does not ask while the page is hidden', async (t) => {
    clock(t)
    visibility = 'hidden'
    const m = mount({ answer: () => ok(ROWS) })
    const store = storeOf(m)
    cleanups.push(store.subscribe(() => {}))
    t.mock.timers.tick(6000)
    await flush()
    assert.deepEqual(m.calls, [])
    visibility = 'visible'
    t.mock.timers.tick(2000)
    await flush()
    assert.equal(m.calls.length, 1)
    visibility = 'hidden'
    t.mock.timers.tick(6000)
    await flush()
    assert.equal(m.calls.length, 1)
  })

  it('waits for an answer before it asks again', async (t) => {
    clock(t)
    const pending = []
    const m = mount({ answer: () => new Promise((resolve) => { pending.push(resolve) }) })
    const store = storeOf(m)
    cleanups.push(store.subscribe(() => {}))
    t.mock.timers.tick(6000)
    await flush()
    assert.equal(m.calls.length, 1)
    pending[0](ok(ROWS))
    await flush()
    // Dated when the answer arrived.
    assert.deepEqual(store.getSnapshot(), { agents: ROWS, at: NOW + 6000 })
    t.mock.timers.tick(2000)
    await flush()
    assert.equal(m.calls.length, 2)
  })

  it('keeps one store per session', async (t) => {
    clock(t)
    const m = mount({ answer: ({ sessionId }) => ok([{ id: sessionId, depth: 0, name: '', state: 'idle', subagents: 0, queued: 0 }]) })
    const first = storeOf(m, 's1')
    const second = storeOf(m, 's2')
    assert.notEqual(first, second)
    cleanups.push(first.subscribe(() => {}), second.subscribe(() => {}))
    await flush()
    assert.deepEqual(m.calls.map(([, , payload]) => payload), [{ sessionId: 's1' }, { sessionId: 's2' }])
    assert.equal(first.getSnapshot().agents[0].id, 's1')
    assert.equal(second.getSnapshot().agents[0].id, 's2')
  })
})

/** A session whose agent waits on four jobs and a goal, with four subagents, one of which has its own. */
const SAMPLE = [
  {
    id: 'root', depth: 0, name: '', state: 'waiting', since: NOW - 65_000, subagents: 4, queued: 0, goalWaiting: true,
    jobs: [
      { kind: 'bash', label: 'npm run build', status: 'running', startedAt: NOW - 30_000 },
      { kind: 'bash', label: 'sleep 600', status: 'stopping', startedAt: NOW - 120_000 },
      { kind: 'workflow', label: 'audit', status: 'running' },
      { kind: 'bash', label: 'tail -f log', status: 'running', startedAt: NOW - 1000 },
    ],
  },
  {
    id: 'b', depth: 1, name: 'builder', label: 'Build the project', state: 'running', since: NOW - 42_000,
    activity: { tool: 'bash', summary: 'npm test' }, jobs: [], subagents: 1, queued: 0,
  },
  { id: 'c', depth: 2, name: 'builder/checker', label: 'Check the build', state: 'running', since: NOW - 5000, jobs: [], subagents: 0, queued: 0 },
  {
    id: 't', depth: 1, name: 'tester', label: 'Run the suite', state: 'waiting', since: NOW - 3_725_000, subagents: 0, queued: 0,
    jobs: [{ kind: 'bash', label: 'npm run e2e', status: 'running', startedAt: NOW - 61_000 }],
  },
  { id: 'q', depth: 1, name: 'e4444444', state: 'queued', since: NOW - 10_000, jobs: [], subagents: 0, queued: 2 },
  // The Host left out what it could not read.
  { id: 'i', depth: 1, name: 'f5555555', state: 'idle', subagents: 0 },
]

describe('strip', { skip }, () => {
  const act = callback => React.act(async () => { await callback() })

  /** Render the registered strip with the hook the renderer makes of the session's store. */
  async function show(m, useAgentMonitor, t = m.t()) {
    const container = document.createElement('div')
    document.body.append(container)
    const root = ReactDOMClient.createRoot(container)
    await act(() => { root.render(React.createElement(m.Component, { useAgentMonitor, t })) })
    let mounted = true
    const remove = async () => {
      if (!mounted) return
      mounted = false
      await act(() => { root.unmount() })
      container.remove()
    }
    cleanups.push(remove)
    return { container, remove }
  }

  /** The hook of an answer that does not change. */
  const fixed = (agents, at = NOW) => selector => selector({ agents, at })
  /** As the renderer binds a store of the `hooks` compartment: a selector hook over its snapshot. */
  const bind = store => selector => React.useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()))

  const header = container => container.querySelector('button')
  const toggle = container => act(() => { header(container).dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })) })
  const texts = (element, selector) => [...element.querySelectorAll(selector)].map(node => node.textContent)
  const icon = element => element.querySelector('use').getAttribute('href')
  /** A row's own line: name, label, what it does, elapsed time. */
  const line = item => ['name', 'label', 'doing', 'time'].map(part => item.querySelector(`.dsh-am-row > .dsh-am-${part}`)?.textContent)
  /** The lines under a row: text and elapsed time. */
  const notes = item => [...item.querySelectorAll('.dsh-am-note')].map(note => ['note-text', 'time'].map(part => note.querySelector(`.dsh-am-${part}`)?.textContent))

  it('draws nothing while the session agent is alone without a job or a waiting goal', async () => {
    const m = mount()
    for (const agents of [[], [{ ...SAMPLE[0], jobs: [], goalWaiting: undefined }], [SAMPLE[5]]]) {
      const { container } = await show(m, fixed(agents))
      assert.equal(container.innerHTML, '')
    }
    for (const agents of [[{ ...SAMPLE[0], goalWaiting: undefined }], [{ ...SAMPLE[0], jobs: [] }], [SAMPLE[5], SAMPLE[1]]]) {
      const { container } = await show(m, fixed(agents))
      assert.notEqual(header(container), null)
    }
  })

  it('starts collapsed: an icon, the title, the counts per state, and a chevron', async () => {
    const { container } = await show(mount(), fixed(SAMPLE))
    const section = container.querySelector('section')
    assert.equal(section.getAttribute('aria-label'), 'Agents')
    assert.equal(header(container).getAttribute('aria-expanded'), 'false')
    assert.equal(header(container).type, 'button')
    assert.deepEqual(texts(container, '.dsh-am-title'), ['Agents'])
    assert.deepEqual(texts(container, '.dsh-am-summary'), [`2 working${DOT}2 waiting for background work${DOT}2 idle`])
    assert.equal(icon(container.querySelector('.dsh-am-lead')), '#dsw-icon-users-outline-regular')
    assert.equal(icon(container.querySelector('.dsh-am-chevron')), '#dsw-icon-chevron-up-outline-regular')
    assert.equal(container.querySelector('ul'), null)
    // The header is the only control.
    assert.equal(container.querySelectorAll('button, a, input, [tabindex], [role="button"]').length, 1)
  })

  it('expands to one row per agent and collapses again', async () => {
    const { container } = await show(mount(), fixed(SAMPLE))
    await toggle(container)
    assert.equal(header(container).getAttribute('aria-expanded'), 'true')
    assert.equal(icon(container.querySelector('.dsh-am-chevron')), '#dsw-icon-chevron-down-outline-regular')
    const items = [...container.querySelectorAll('ul > li')]
    assert.deepEqual(items.map(line), [
      ['This session', undefined, 'Waiting for background work', '1m 5s'],
      ['builder', 'Build the project', 'bash · npm test', '42s'],
      ['builder/checker', 'Check the build', 'Thinking', '5s'],
      ['tester', 'Run the suite', 'Waiting for background work', '1h 2m'],
      ['e4444444', undefined, 'Has queued messages', '10s'],
      ['f5555555', undefined, 'Idle', undefined],
    ])
    // Indented by depth.
    assert.deepEqual(items.map(item => item.style.paddingLeft), ['', '16px', '32px', '16px', '16px', '16px'])
    // Each state mark has a text alternative.
    const marks = items.map(item => item.querySelector('.dsh-am-glyph'))
    assert.ok(marks.every(mark => mark.getAttribute('role') === 'img'))
    assert.deepEqual(marks.map(mark => mark.getAttribute('aria-label')), [
      'Waiting for background work', 'Working', 'Working', 'Waiting for background work', 'Has queued messages', 'Idle',
    ])
    // Running turns, waiting pauses, the rest is a dot.
    assert.deepEqual(marks.map(mark => mark.firstElementChild.getAttribute('class')), [
      'dsh-am-paused', 'dsh-am-spinner', 'dsh-am-spinner', 'dsh-am-paused', 'dsh-am-dot', 'dsh-am-dot',
    ])
    assert.equal(icon(marks[0]), '#dsw-icon-pause-outline-regular')
    // At most three jobs, then the rest as a count; the waiting goal comes last.
    assert.deepEqual(notes(items[0]), [
      ['bash: npm run build', '30s'],
      ['bash: sleep 600', '2m 0s'],
      ['workflow: audit', undefined],
      ['+1 more', undefined],
      ['Goal: waiting for background work before the next round', undefined],
    ])
    assert.deepEqual(notes(items[3]), [['bash: npm run e2e', '1m 1s']])
    assert.deepEqual(items.map(item => notes(item).length), [5, 0, 0, 1, 0, 0])

    await toggle(container)
    assert.equal(header(container).getAttribute('aria-expanded'), 'false')
    assert.equal(container.querySelector('ul'), null)
  })

  it('reads in Chinese', async () => {
    const m = mount()
    const { container } = await show(m, fixed(SAMPLE), m.t('zh'))
    assert.deepEqual(texts(container, '.dsh-am-title'), ['智能体'])
    assert.deepEqual(texts(container, '.dsh-am-summary'), [`2 个运行中${DOT}2 个等待后台工作${DOT}2 个空闲`])
    await toggle(container)
    const items = [...container.querySelectorAll('ul > li')]
    assert.deepEqual(line(items[0]), ['本会话', undefined, '等待后台工作', '1分5秒'])
    assert.deepEqual(line(items[2]), ['builder/checker', 'Check the build', '思考中', '5秒'])
    assert.deepEqual(notes(items[0]).slice(3), [['另有 1 个', undefined], ['目标：等待后台工作，之后开始下一轮', undefined]])
  })

  it('follows the Host while it is on the page', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: NOW })
    let rows = SAMPLE
    const m = mount({ answer: () => ok(structuredClone(rows)) })
    /** Renders of the strip, counted by its lookups of the title. */
    let renders = 0
    const en = m.t()
    const counting = (key, params) => {
      if (key === 'title') renders += 1
      return en(key, params)
    }
    const tick = () => act(async () => {
      t.mock.timers.tick(2000)
      await flush()
    })
    const { container, remove } = await show(m, bind(m.options.inject('s1').hooks.agentMonitor), counting)
    await act(flush)
    assert.deepEqual(m.calls.map(([, endpoint, payload]) => [endpoint, payload]), [['pcmid/agent-monitor/snapshot', { sessionId: 's1' }]])
    assert.deepEqual(texts(container, '.dsh-am-summary'), [`2 working${DOT}2 waiting for background work${DOT}2 idle`])

    // Collapsed, an unchanged answer draws nothing again.
    const drawn = renders
    await tick()
    assert.equal(m.calls.length, 2)
    assert.equal(renders, drawn)

    // Expanded, elapsed times follow each answer.
    await toggle(container)
    const times = () => texts(container, '.dsh-am-row > .dsh-am-time')
    assert.deepEqual(times(), ['1m 7s', '44s', '7s', '1h 2m', '12s'])
    await tick()
    assert.deepEqual(times(), ['1m 9s', '46s', '9s', '1h 2m', '14s'])

    // A changed answer replaces the rows; the strip stays expanded.
    rows = [SAMPLE[0], { ...SAMPLE[1], activity: undefined }]
    await tick()
    assert.deepEqual(texts(container, '.dsh-am-summary'), [`1 working${DOT}1 waiting for background work`])
    assert.deepEqual(texts(container, '.dsh-am-row > .dsh-am-doing'), ['Waiting for background work', 'Thinking'])

    // Nothing left to show: the strip goes, and keeps asking.
    rows = [{ ...SAMPLE[0], state: 'idle', jobs: [], goalWaiting: undefined }]
    await tick()
    assert.equal(container.innerHTML, '')
    rows = SAMPLE
    await tick()
    assert.equal(header(container).getAttribute('aria-expanded'), 'true')

    // Off the page it stops asking.
    const asked = m.calls.length
    await remove()
    t.mock.timers.tick(60_000)
    await flush()
    assert.equal(m.calls.length, asked)
  })

  it('adds its style sheet, and removes it when the plugin unloads', () => {
    const sheets = () => [...document.head.querySelectorAll('style[data-plugin="agent-monitor"]')]
    const before = sheets().length
    const m = mount()
    assert.equal(sheets().length, before + 1)
    const sheet = sheets().at(-1).textContent
    assert.match(sheet, /\.dsh-am-root \{/)
    // Colors come from the theme: no literal color in the sheet.
    assert.doesNotMatch(sheet, /#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i)
    m.unload()
    assert.equal(sheets().length, before)
  })
})
