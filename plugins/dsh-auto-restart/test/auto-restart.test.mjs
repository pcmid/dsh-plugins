import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  CandidateStore, Config, SOURCE_KIND, createRecovery, createTracker, endCause, noticeText, plan, rootIdOf, summarize,
} from '../index.js'

const HOUR = 3_600_000
const PROCESS_START = 1_000_000_000
const config = (overrides = {}) => Config({ startDelaySeconds: 0, ...overrides })

/** Build a dense event log from compact specs. */
function log(...specs) {
  return specs.map((spec, seq) => ({ seq, ...spec }))
}
const turnStart = (turn, time) => ({ type: 'turn/start', time, data: { turn } })
const turnEnd = (turn, time, reason) => ({ type: 'turn/end', time, data: { turn, reason } })
const message = (kind, id, extra = {}) => ({ id, role: 'user', content: [{ type: 'text', text: id }], source: { kind, ...extra } })
const userMessage = (time, msg) => ({ type: 'user/message', time, data: msg })
const inserted = (time, ...msgs) => ({ type: 'agent/inbox/spliced', time, data: { target: 'next-turn', inserted: msgs } })

const CRASH = { kind: 'interrupted' }
const DISPOSED = { kind: 'aborted', reason: { kind: 'disposed' } }
const PARENT = { kind: 'aborted', reason: { kind: 'parent' } }
const USER_STOP = { kind: 'aborted', reason: { kind: 'user' } }
const COMPLETED = { kind: 'completed' }

const before = PROCESS_START - HOUR
const options = (overrides = {}) => ({
  processStart: PROCESS_START, now: PROCESS_START + 10_000, maxAgeMs: 24 * HOUR,
  afterShutdown: true, maxAttempts: 3, ...overrides,
})

function quietLogger() {
  const lines = []
  return { lines, info: line => lines.push(['info', line]), warn: line => lines.push(['warn', line]) }
}

const temporary = []
after(async () => { await Promise.all(temporary.map(dir => rm(dir, { recursive: true, force: true }))) })
async function tempFile() {
  const dir = await mkdtemp(join(tmpdir(), 'auto-restart-test-'))
  temporary.push(dir)
  return join(dir, 'state', 'desktop.json')
}

describe('endCause', () => {
  it('separates interruptions from turns that ended on their own', () => {
    assert.equal(endCause(CRASH), 'crash')
    assert.equal(endCause(DISPOSED), 'shutdown')
    assert.equal(endCause(PARENT), 'shutdown')
    for (const reason of [USER_STOP, COMPLETED, { kind: 'error', error: { code: 'SERVER' } }, { kind: 'blocked' }, { kind: 'max-tokens' }, { kind: 'forked' }]) {
      assert.equal(endCause(reason), undefined, JSON.stringify(reason))
    }
  })
})

describe('summarize', () => {
  it('reports the last ending, an open turn, and the latest turn number', () => {
    const closed = summarize(log(turnStart(1, 1), turnEnd(1, 2, COMPLETED), turnStart(2, 3), turnEnd(2, 4, CRASH)))
    assert.deepEqual(closed.lastEnd, { seq: 3, time: 4, turn: 2, reason: CRASH })
    assert.equal(closed.open, false)
    assert.equal(closed.lastTurn, 2)
    const open = summarize(log(turnStart(1, 1), turnEnd(1, 2, COMPLETED), turnStart(2, 3)))
    assert.equal(open.open, true)
    assert.equal(summarize([]).lastEnd, undefined)
  })

  it('counts distinct continuation notices since the last human message', () => {
    const notice1 = message(SOURCE_KIND, 'n1', { attempt: 1 })
    const notice2 = message(SOURCE_KIND, 'n2', { attempt: 2 })
    const events = log(
      inserted(1, message(SOURCE_KIND, 'old')),
      inserted(2, message('user', 'human')),
      inserted(3, notice1), userMessage(4, notice1),
      inserted(5, message('goal', 'goal-round')),
      inserted(6, notice2), userMessage(7, notice2),
    )
    assert.equal(summarize(events).continuations, 2)
    assert.equal(summarize(log(inserted(1, notice1), inserted(2, message('retry', 'continue')))).continuations, 0)
  })
})

describe('plan', () => {
  const crashed = summarize(log(inserted(1, message('user', 'task')), turnStart(1, 2), turnEnd(1, before, CRASH)))

  it('continues a turn cut off in an earlier process', () => {
    assert.deepEqual(plan(crashed, [], options()), { action: 'continue', rootCause: 'crash', children: [], attempt: 1, lastTurn: 1 })
  })

  it('drops turns that ended on their own, in this process, or too long ago', () => {
    const completed = summarize(log(turnStart(1, 1), turnEnd(1, before, COMPLETED)))
    assert.equal(plan(completed, [], options()).action, 'drop')
    const thisProcess = summarize(log(turnStart(1, 1), turnEnd(1, PROCESS_START + 5, DISPOSED)))
    assert.equal(plan(thisProcess, [], options()).action, 'drop')
    const old = summarize(log(turnStart(1, 1), turnEnd(1, PROCESS_START - 25 * HOUR, CRASH)))
    assert.equal(plan(old, [], options()).action, 'drop')
  })

  it('follows afterShutdown for turns cut off by an orderly stop', () => {
    const shutdown = summarize(log(turnStart(1, 1), turnEnd(1, before, DISPOSED)))
    assert.equal(plan(shutdown, [], options()).rootCause, 'shutdown')
    assert.equal(plan(shutdown, [], options({ afterShutdown: false })).action, 'drop')
    assert.equal(plan(crashed, [], options({ afterShutdown: false })).action, 'continue')
  })

  it('stops after maxAttempts continuations without a human message', () => {
    const notices = [1, 2, 3].map(n => message(SOURCE_KIND, `n${n}`, { attempt: n }))
    const looping = summarize(log(
      inserted(1, message('user', 'task')), turnStart(1, 2), turnEnd(1, 3, CRASH),
      ...notices.flatMap((notice, index) => [inserted(10 + index, notice), turnStart(2 + index, 11 + index), turnEnd(2 + index, before, CRASH)]),
    ))
    assert.deepEqual(plan(looping, [], options()), { action: 'drop', reason: '3 automatic continuations since the last human message' })
    assert.equal(plan(looping, [], options({ maxAttempts: 4 })).attempt, 4)
  })

  it('waits while the root or a subagent still runs', () => {
    const running = summarize(log(turnStart(1, 1)))
    assert.deepEqual(plan(running, [], options()), { action: 'wait' })
    assert.deepEqual(plan(crashed, [{ id: 'child', summary: running }], options()), { action: 'wait' })
  })

  it('wakes a root whose subagents were cut off after its own turn ended', () => {
    const waiting = summarize(log(turnStart(1, 1), turnEnd(1, before - 60_000, COMPLETED)))
    const child = summarize(log(turnStart(1, before - 50_000), turnEnd(1, before, PARENT)))
    assert.deepEqual(plan(waiting, [{ id: 'child', summary: child }], options()), {
      action: 'continue', rootCause: undefined, children: ['child'], attempt: 1, lastTurn: 1,
    })
    // The root already worked after the subagent stopped.
    const later = summarize(log(turnStart(1, 1), turnEnd(1, before + 1, COMPLETED)))
    assert.equal(plan(later, [{ id: 'child', summary: child }], options()).action, 'drop')
    const finished = summarize(log(turnStart(1, before - 50_000), turnEnd(1, before, COMPLETED)))
    assert.equal(plan(waiting, [{ id: 'child', summary: finished }], options()).action, 'drop')
  })
})

describe('noticeText', () => {
  it('describes the interruption and warns about repeated attempts', () => {
    const crash = noticeText({ rootCause: 'crash', children: [], attempt: 1 })
    assert.match(crash, /stopped unexpectedly/)
    assert.match(crash, /Continue the task from where it stopped/)
    assert.doesNotMatch(crash, /in a row/)
    assert.match(noticeText({ rootCause: 'shutdown', children: ['c'], attempt: 2 }), /was shut down[\s\S]*Subagents you started[\s\S]*continuation 2 in a row/)
    assert.match(noticeText({ rootCause: undefined, children: ['c'], attempt: 1 }), /results will not arrive on their own/)
  })
})

describe('CandidateStore', () => {
  it('persists roots and their running subagents, pruning finished entries', async () => {
    const file = await tempFile()
    const store = new CandidateStore(file, quietLogger())
    await store.ready
    store.setRoot('a', true)
    store.addChild('b', 'b-child')
    store.addChild('a', 'a-child')
    store.setRoot('a', false)
    await store.flush()
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
      version: 1, sessions: { a: { root: false, children: ['a-child'] }, b: { root: false, children: ['b-child'] } },
    })
    store.removeChild('a', 'a-child')
    store.clearChildren('b')
    await store.flush()
    const reloaded = new CandidateStore(file, quietLogger())
    await reloaded.ready
    assert.deepEqual(reloaded.snapshot(), [])
  })

  it('sets an unreadable file aside and starts empty', async () => {
    const file = await tempFile()
    const store = new CandidateStore(file, quietLogger())
    await store.ready
    store.setRoot('a', true)
    await store.flush()
    await writeFile(file, '{not json')
    const logger = quietLogger()
    const reloaded = new CandidateStore(file, logger)
    await reloaded.ready
    assert.deepEqual(reloaded.snapshot(), [])
    assert.equal(await readFile(`${file}.bad`, 'utf8'), '{not json')
    assert.match(logger.lines[0][1], /ignoring unreadable/)
  })
})

describe('createTracker', () => {
  const header = (id, extra = {}) => ({ id, header: { id, ...extra } })
  const live = new Map([
    ['root', header('root')],
    ['child', header('child', { origin: 'subagent', parentSession: 'root' })],
    ['grandchild', header('grandchild', { origin: 'subagent', parentSession: 'child' })],
  ])

  it('walks subagent ancestry to the root', () => {
    assert.equal(rootIdOf(live.get('grandchild'), live), 'root')
    assert.equal(rootIdOf(header('orphan', { origin: 'subagent', parentSession: 'gone' }), live), 'gone')
    assert.equal(rootIdOf(header('lost', { origin: 'subagent' }), live), undefined)
  })

  it('keeps cut-off turns and drops turns that ended on their own', async () => {
    const store = new CandidateStore(await tempFile(), quietLogger())
    const track = createTracker(store, live)
    const settle = () => store.ready.then(() => new Promise(resolve => setImmediate(resolve)))
    track(live.get('root'), { type: 'turn/start', data: { turn: 1 } })
    track(live.get('grandchild'), { type: 'turn/start', data: { turn: 1 } })
    track(live.get('root'), { type: 'turn/end', data: { turn: 1, reason: DISPOSED } })
    track(live.get('grandchild'), { type: 'turn/end', data: { turn: 1, reason: PARENT } })
    track(live.get('root'), { type: 'user/message', data: message('user', 'x') })
    await settle()
    assert.deepEqual(store.snapshot(), [{ id: 'root', root: true, children: ['grandchild'] }])
    track(live.get('root'), { type: 'turn/end', data: { turn: 1, reason: COMPLETED } })
    track(live.get('grandchild'), { type: 'turn/end', data: { turn: 1, reason: USER_STOP } })
    await settle()
    assert.deepEqual(store.snapshot(), [])
  })
})

describe('createRecovery', () => {
  /** Fake Host services around one stored log per Session id. */
  async function fixture({ logs, status = 'idle', lastTurn, goal, archived = [], resolveError, pending = [] }) {
    const calls = []
    const store = new CandidateStore(await tempFile(), quietLogger())
    await store.ready
    const inbox = {
      nextTurn: [...pending], nextStep: [],
      remove(id) { calls.push(['remove', id]); this.nextTurn = this.nextTurn.filter(m => m.id !== id) },
    }
    const agent = {
      id: 'root', status, inbox, session: { id: 'root' },
      followup(msg) { calls.push(['followup', msg]) },
    }
    const goalView = goal
    const ctx = {
      logger: quietLogger(),
      sessionQuery: {
        async observeSession(id) {
          const entry = logs[id]
          if (entry === undefined) throw Object.assign(new Error('missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
          return { header: { id, ...entry.header }, events: entry.events, [Symbol.dispose]() { calls.push(['dispose', id]) } }
        },
      },
      sessionController: {
        async resolveAgent(id) {
          calls.push(['resolve', id])
          return resolveError === undefined ? { agent } : { error: resolveError }
        },
      },
      agents: { turnBoundaryOf: () => ({ openTurnStartSeq: null, lastTurn: lastTurn ?? summarize(logs.root.events).lastTurn }) },
      sessions: { flush: async () => { calls.push(['flush']); return true } },
      get(name) {
        if (name === 'workspaceRegistry') return { archivedSessionIds: archived }
        if (name === 'goals' && goalView !== undefined) {
          return {
            get: () => goalView,
            resume: (_agent, ref) => { calls.push(['goal-resume', ref]) },
          }
        }
        return undefined
      },
    }
    const recover = createRecovery(ctx, config(), store, { processStart: PROCESS_START, now: () => PROCESS_START + 10_000 })
    return { calls, store, ctx, run: () => recover(new AbortController().signal) }
  }

  const crashedRoot = { events: log(inserted(1, message('user', 'task')), turnStart(1, 2), turnEnd(1, before, CRASH)) }

  it('resumes the conversation, sends one notice, then rearms its goal', async () => {
    const goal = { id: 'g1', revision: 4, phase: 'active', activation: 'disarmed', roundsStarted: 2, maxGoalRounds: 20 }
    const f = await fixture({ logs: { root: crashedRoot, child: { header: { origin: 'subagent' }, events: log(turnStart(1, 3), turnEnd(1, before, PARENT)) } }, goal })
    f.store.setRoot('root', true)
    f.store.addChild('root', 'child')
    await f.run()
    const order = f.calls.filter(([kind]) => kind !== 'dispose').map(([kind]) => kind)
    assert.deepEqual(order, ['resolve', 'followup', 'flush', 'goal-resume'])
    const notice = f.calls.find(([kind]) => kind === 'followup')[1]
    assert.equal(notice.role, 'user')
    assert.deepEqual(notice.source, { kind: SOURCE_KIND, attempt: 1, form: 'notice', summary: 'Harness restarted; continuing the interrupted turn' })
    assert.match(notice.content[0].text, /stopped unexpectedly[\s\S]*Subagents you started/)
    assert.deepEqual(f.calls.find(([kind]) => kind === 'goal-resume')[1], { id: 'g1', revision: 4 })
    assert.deepEqual(f.store.snapshot(), [{ id: 'root', root: true, children: [] }])
  })

  it('replaces a notice that never started its turn', async () => {
    const stale = message(SOURCE_KIND, 'stale', { attempt: 1 })
    const f = await fixture({ logs: { root: { events: [...crashedRoot.events, { ...inserted(before + 1, stale), seq: 3 }] } }, pending: [stale] })
    f.store.setRoot('root', true)
    await f.run()
    assert.deepEqual(f.calls.find(([kind]) => kind === 'remove'), ['remove', 'stale'])
    assert.equal(f.calls.find(([kind]) => kind === 'followup')[1].source.attempt, 2)
  })

  it('leaves a conversation alone when something else already drove it', async () => {
    const running = await fixture({ logs: { root: crashedRoot }, status: 'running' })
    running.store.setRoot('root', true)
    await running.run()
    assert.equal(running.calls.some(([kind]) => kind === 'followup'), false)
    assert.equal(running.store.snapshot().length, 1)
    const advanced = await fixture({ logs: { root: crashedRoot }, lastTurn: 2 })
    advanced.store.setRoot('root', true)
    await advanced.run()
    assert.equal(advanced.calls.some(([kind]) => kind === 'followup'), false)
  })

  it('drops missing, archived, finished, and unresumable candidates', async () => {
    const missing = await fixture({ logs: { root: crashedRoot } })
    missing.store.setRoot('gone', true)
    await missing.run()
    assert.deepEqual(missing.store.snapshot(), [])

    const archived = await fixture({ logs: { root: crashedRoot }, archived: ['root'] })
    archived.store.setRoot('root', true)
    await archived.run()
    assert.deepEqual(archived.store.snapshot(), [])
    assert.equal(archived.calls.length, 0)

    const finished = await fixture({ logs: { root: { events: log(turnStart(1, 1), turnEnd(1, before, COMPLETED)) } } })
    finished.store.setRoot('root', true)
    await finished.run()
    assert.deepEqual(finished.store.snapshot(), [])
    assert.equal(finished.calls.some(([kind]) => kind === 'resolve'), false)

    const failing = await fixture({ logs: { root: crashedRoot }, resolveError: Object.assign(new Error('busy'), { code: 'session/agent-busy' }) })
    failing.store.setRoot('root', true)
    await failing.run()
    assert.deepEqual(failing.store.snapshot(), [])
    assert.match(failing.ctx.logger.lines.at(-1)[1], /cannot resume: session\/agent-busy: busy/)
  })

  it('does not rearm a goal whose round budget is spent', async () => {
    const goal = { id: 'g1', revision: 1, phase: 'active', activation: 'disarmed', roundsStarted: 5, maxGoalRounds: 5 }
    const f = await fixture({ logs: { root: crashedRoot }, goal })
    f.store.setRoot('root', true)
    await f.run()
    assert.equal(f.calls.some(([kind]) => kind === 'goal-resume'), false)
    assert.match(f.ctx.logger.lines.at(-1)[1], /goal round budget exhausted/)
  })
})
