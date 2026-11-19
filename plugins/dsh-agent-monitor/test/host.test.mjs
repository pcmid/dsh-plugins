// The Host half against stand-ins for the parts of DSH it reads: loaded Agents with their
// Session logs, and the optional subagent, job and goal services. Needs no dependencies.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { apply, inject, name, summarize } from '../index.js'

/** A fixed clock: every event time and job start is an offset from it. */
const T0 = 1_800_000_000_000

/** Session ids as DSH mints them, so the name fallback has eight characters to show. */
const id = (head, n) => `${head}-0000-4000-8000-${String(n).padStart(12, '0')}`
const ROOT = id('a0000000', 1)
const BUILDER = id('b1111111', 2)
const CHECKER = id('c2222222', 3)
const TESTER = id('d3333333', 4)
const QUEUED = id('e4444444', 5)
const IDLE = id('f5555555', 6)

/**
 * A Session stand-in: creation metadata, an append-only log, and the ranged
 * reads recorded in `reads`. With `inherited` it is a forked subagent's, laid
 * out as DSH lays one out: the creator's events through its last completed
 * turn, then a marker written at creation, then its own events.
 */
function session(sessionId, { parent, origin, createdAt = T0, inherited = [] } = {}) {
  const log = [...inherited]
  if (inherited.length > 0) log.push({ type: 'session/end-seed', data: { inherited: true }, seq: log.length, time: createdAt })
  const reads = []
  return {
    header: { id: sessionId, createdAt, isSeeded: inherited.length > 0, ...parent === undefined ? {} : { parentSession: parent }, ...origin === undefined ? {} : { origin } },
    inheritedEventCount: inherited.length,
    log,
    reads,
    get seq() { return log.length },
    isOwnSeq: seq => seq >= inherited.length && seq < log.length,
    snapshotEvents(from = 0, to = log.length) {
      reads.push([from, Math.min(to, log.length)])
      return log.slice(from, to)
    },
    /** Append one event `at` milliseconds after {@link T0}. */
    append(type, data, at) {
      const event = { type, data, seq: log.length, time: T0 + at }
      log.push(event)
      return event
    },
  }
}

/** An Agent stand-in for a Session. */
function agent(ofSession, status = 'idle') {
  return { id: ofSession.header.id, status, inbox: { nextTurn: [], nextStep: [] }, session: ofSession }
}

/** A subagent's Session: created by `parent`, with its own descriptor unless `label` is null. */
function subSession(sessionId, parent, createdAt, { label, inherited } = {}) {
  const created = session(sessionId, { parent, origin: 'subagent', createdAt: T0 + createdAt, inherited })
  if (label !== null) created.append('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'fork', ...label === undefined ? {} : { label } }, createdAt)
  return created
}

const turnStart = (s, turn, at) => s.append('turn/start', { turn }, at)
const turnEnd = (s, turn, at) => s.append('turn/end', { turn, reason: { kind: 'completed' } }, at)
const toolCall = (s, callId, tool, args, at) => s.append('tool/call', { turn: 1, step: 1, callId, name: tool, arguments: JSON.stringify(args) }, at)
const toolResult = (s, callId, at) => s.append('tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: callId, content: [] } }, at)

/**
 * Apply the plugin to a stand-in Host. `services` holds the optional services
 * by name; `snapshot` and `sessions` each send one request through their
 * registered route.
 */
function host(services = {}) {
  const loaded = new Map()
  const routes = []
  apply({
    agents: {
      get: sessionId => loaded.get(sessionId),
      list: () => [...loaded.values()],
      // The fold of DSH's turn-boundary projection.
      turnBoundaryOf: (ofSession) => {
        let openTurnStartSeq = null
        for (const event of ofSession.log) {
          if (event.type === 'turn/start') openTurnStartSeq = event.seq
          else if (event.type === 'turn/end') openTurnStartSeq = null
        }
        return { openTurnStartSeq }
      },
    },
    get: key => services[key],
    connection: { fetch: { register: (route) => { routes.push(route); return async () => {} } } },
  })
  /** Send a body to the route of one endpoint. */
  const post = (body, endpoint = 'snapshot') => {
    const route = routes.find(one => one.path === `/api/pcmid/agent-monitor/${endpoint}`)
    return route.fetch(new Request(`http://localhost${route.path}`, { method: 'POST', body }))
  }
  /** Send one request in the RPC envelope and return the value of its answer. */
  async function call(endpoint, payload) {
    const response = await post(JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: `pcmid/agent-monitor/${endpoint}`, payload }), endpoint)
    const body = await response.json()
    assert.equal(body.type, 'server-response')
    assert.equal(body.rpcId, 'rpc-1')
    assert.equal(body.result.ok, true, JSON.stringify(body.result))
    return body.result.value
  }
  return {
    routes,
    post,
    load(...agents) {
      for (const one of agents) loaded.set(one.id, one)
    },
    snapshot: async sessionId => (await call('snapshot', { sessionId })).agents,
    sessions: async () => (await call('sessions', {})).sessions,
  }
}

/** The subagent service: names by Session id; an agent without one is addressed by its id, as DSH does. */
const naming = names => ({ namesOf: one => ({ self: names[one.id] ?? one.id }) })

/** The job registry: a caller sees its own jobs and the jobs nobody owns. */
const registry = jobs => ({ list: caller => jobs.filter(job => job.owner === undefined || job.owner === caller) })

const job = (owner, status, label, startedAt, kind = 'bash') => ({
  id: `${kind}-${label.length}${startedAt}`, kind, label, ...owner === undefined ? {} : { owner }, status, startedAt: T0 + startedAt, output: { total: 0, earliest: 0 },
})

/**
 * Record in its owner's log that a job was registered, as DSH's job registry
 * does. `toolCall` names the tool call that started the job: `callId` is that
 * call and `rootCallId` the model's call it ran in, which is the same call
 * unless a script made it. A job that no tool call started has none.
 */
const jobRegistered = (s, started, toolCall) => s.append('job/registered', {
  jobId: started.id, owner: started.owner, kind: started.kind, label: started.label, startedAt: started.startedAt,
  ...toolCall === undefined ? {} : { toolCall },
}, started.startedAt - T0)

/** The `toolCall` of a job that one of the model's own calls started. */
const by = callId => ({ callId, rootCallId: callId })

/** The job DSH registers for the builder's `bash` call while that call runs in the foreground. */
const BUILDER_COMMAND = job(BUILDER, 'running', 'npm test', 2400)

/**
 * A session with four subagents, one of which has a subagent of its own:
 *
 *   root             idle
 *   ├─ builder       running, `bash` in flight
 *   │  └─ checker    running, no tool call in flight
 *   ├─ tester        idle, owns a running and a stopping job
 *   ├─ (no name)     idle, two pending messages
 *   └─ (no name)     idle, never ran a turn
 */
function tree(services = {}) {
  const root = session(ROOT)
  turnStart(root, 1, 100)
  turnEnd(root, 1, 900)
  turnStart(root, 2, 1000)
  turnEnd(root, 2, 5000)
  /** What a fork of the root inherits: its first, completed turn. */
  const rootHistory = root.log.slice(0, 2)

  const builder = subSession(BUILDER, ROOT, 2000, { label: 'Build the project', inherited: rootHistory })
  turnStart(builder, 2, 2100)
  turnEnd(builder, 2, 2150)
  turnStart(builder, 3, 2200)
  toolCall(builder, 'call-1', 'read', { file_path: '/repo/package.json' }, 2300)
  toolResult(builder, 'call-1', 2350)
  toolCall(builder, 'call-2', 'bash', { description: 'Run the tests', command: 'npm test' }, 2400)
  jobRegistered(builder, BUILDER_COMMAND, by('call-2'))
  toolCall(builder, 'call-3', 'grep', { pattern: 'TODO' }, 2401)
  toolResult(builder, 'call-3', 2500)

  // Forked from the builder after its first turn: the inherited history holds the builder's descriptor.
  const checker = subSession(CHECKER, BUILDER, 3000, { label: 'Check the build', inherited: builder.log.slice(0, 6) })
  turnStart(checker, 3, 3100)

  const tester = subSession(TESTER, ROOT, 2500, { label: 'Run the suite' })
  turnStart(tester, 1, 2600)
  turnEnd(tester, 1, 4000)

  // Its descriptor is not written yet.
  const queued = subSession(QUEUED, ROOT, 2600, { label: null })
  turnStart(queued, 1, 2700)
  turnEnd(queued, 1, 2800)

  // A fork that never ran a turn of its own; a one-shot descriptor may carry no label.
  const idle = subSession(IDLE, ROOT, 2700, { inherited: rootHistory })

  const agents = {
    root: agent(root),
    builder: agent(builder, 'running'),
    checker: agent(checker, 'running'),
    tester: agent(tester),
    queued: agent(queued),
    idle: agent(idle),
  }
  agents.queued.inbox.nextTurn.push({ id: 'm1' })
  agents.queued.inbox.nextStep.push({ id: 'm2' })

  const h = host({
    subagents: naming({ [ROOT]: 'lead', [BUILDER]: 'builder', [CHECKER]: 'builder/checker', [TESTER]: 'tester' }),
    jobs: registry([
      BUILDER_COMMAND,
      job(TESTER, 'running', 'npm run build\n&& echo done', 3500),
      job(TESTER, 'stopping', `node ${'x'.repeat(100)}`, 3600, 'workflow'),
      job(TESTER, 'completed', 'ls', 3000),
      job(BUILDER, 'failed', 'false', 3000),
      job(undefined, 'running', 'shared watcher', 100),
    ]),
    ...services,
  })
  // Loaded in no particular order.
  h.load(agents.idle, agents.checker, agents.queued, agents.root, agents.tester, agents.builder)
  return { h, agents }
}

describe('plugin', () => {
  it('needs the connection and the agent registry, and registers two owner routes', () => {
    const { routes } = host()
    assert.equal(name, 'agent-monitor')
    assert.deepEqual(inject, ['connection', 'agents'])
    assert.deepEqual(routes.map(route => route.path), ['/api/pcmid/agent-monitor/snapshot', '/api/pcmid/agent-monitor/sessions'])
    for (const route of routes) {
      assert.deepEqual(route.methods, ['POST'])
      assert.equal(route.requestBody, 'buffered')
    }
  })

  it('answers a body that is not JSON with 400 and a wrong envelope with a refusal', async () => {
    const { post } = host()
    for (const [endpoint, envelopes] of [
      ['snapshot', [
        [{ type: 'client-request', rpcId: 'r7', payload: {} }, 'r7'],
        [{ type: 'client-request', rpcId: 'r8', payload: { sessionId: 7 } }, 'r8'],
        [{ type: 'server-response', rpcId: 'r9', payload: { sessionId: ROOT } }, 'r9'],
        [{ type: 'client-request', payload: null }, 'invalid-request'],
      ]],
      ['sessions', [
        [{ type: 'server-response', rpcId: 'r9', payload: {} }, 'r9'],
        [{ rpcId: 'r10' }, 'r10'],
        [null, 'invalid-request'],
      ]],
    ]) {
      assert.equal((await post('not json', endpoint)).status, 400)
      for (const [envelope, rpcId] of envelopes) {
        const body = await (await post(JSON.stringify(envelope), endpoint)).json()
        assert.equal(body.type, 'server-response')
        assert.equal(body.rpcId, rpcId)
        assert.equal(body.result.ok, false)
        assert.equal(body.result.error.code, 'bad-request', `${endpoint} ${JSON.stringify(envelope)}`)
      }
    }
  })

  it('answers a request it cannot serve with a refusal that carries the reason', async () => {
    const h = host()
    const gone = agent(session(ROOT))
    Object.defineProperty(gone, 'status', { get() { throw new Error('agent is gone') } })
    h.load(gone)
    const body = await (await h.post(JSON.stringify({ type: 'client-request', rpcId: 'r11', payload: { sessionId: ROOT } }))).json()
    assert.deepEqual(body, { type: 'server-response', rpcId: 'r11', result: { ok: false, error: { code: 'internal', message: 'agent is gone', details: {} } } })
  })
})

describe('snapshot', () => {
  it('is empty for a session without a loaded agent', async () => {
    const { h } = tree()
    assert.deepEqual(await h.snapshot('no-such-session'), [])
  })

  it('lists the session agent, then each subagent before its own subagents, siblings by creation time', async () => {
    const { h } = tree()
    const rows = await h.snapshot(ROOT)
    assert.deepEqual(rows.map(row => [row.id, row.depth]), [[ROOT, 0], [BUILDER, 1], [CHECKER, 2], [TESTER, 1], [QUEUED, 1], [IDLE, 1]])
  })

  it('describes every agent of the tree', async () => {
    const { h } = tree()
    assert.deepEqual(await h.snapshot(ROOT), [
      // Idle with loaded subagents: waiting since its last turn ended.
      { id: ROOT, depth: 0, name: '', state: 'waiting', since: T0 + 5000, jobs: [], subagents: 4, queued: 0 },
      // The latest call without a result; `call-3` came later but finished. The job of that call is the call, so it is not listed.
      {
        id: BUILDER, depth: 1, name: 'builder', label: 'Build the project', state: 'running', since: T0 + 2200,
        activity: { tool: 'bash', summary: 'npm test' }, jobs: [], subagents: 1, queued: 0,
      },
      { id: CHECKER, depth: 2, name: 'builder/checker', label: 'Check the build', state: 'running', since: T0 + 3100, jobs: [], subagents: 0, queued: 0 },
      {
        id: TESTER, depth: 1, name: 'tester', label: 'Run the suite', state: 'waiting', since: T0 + 4000,
        jobs: [
          { kind: 'bash', label: 'npm run build', status: 'running', startedAt: T0 + 3500 },
          { kind: 'workflow', label: `node ${'x'.repeat(74)}…`, status: 'stopping', startedAt: T0 + 3600 },
        ],
        subagents: 0, queued: 0,
      },
      { id: QUEUED, depth: 1, name: 'e4444444', state: 'queued', since: T0 + 2800, jobs: [], subagents: 0, queued: 2 },
      // The turn that ended at 900 is the root's, not this fork's.
      { id: IDLE, depth: 1, name: 'f5555555', state: 'idle', jobs: [], subagents: 0, queued: 0 },
    ])
  })

  it('views a subagent as the session: itself at depth 0 without name or label, then its own subagents', async () => {
    const { h } = tree()
    const rows = await h.snapshot(BUILDER)
    assert.deepEqual(rows.map(row => [row.id, row.depth, row.name, row.label]), [[BUILDER, 0, '', undefined], [CHECKER, 1, 'builder/checker', 'Check the build']])
    assert.equal(rows[0].activity.tool, 'bash')
  })

  it('leaves out agents that are not subagents of the session through loaded agents', async () => {
    const { h } = tree()
    const other = session(id('99999999', 7))
    const stranger = subSession(id('88888888', 8), other.header.id, 100)
    // A historical ordinary fork keeps its source id but is not a subagent.
    const fork = session(id('77777777', 9), { parent: ROOT, createdAt: T0 + 100 })
    // Its creator is not loaded.
    const orphan = subSession(id('66666666', 10), id('55555555', 11), 100)
    const grandchild = subSession(id('44444444', 12), orphan.header.id, 200)
    h.load(agent(other), agent(stranger), agent(fork), agent(orphan), agent(grandchild))
    const rows = await h.snapshot(ROOT)
    assert.deepEqual(rows.map(row => row.id), [ROOT, BUILDER, CHECKER, TESTER, QUEUED, IDLE])
    assert.equal(rows[0].subagents, 4)
  })

  it('reads a bounded part of a long log', async () => {
    const h = host()
    const long = session(ROOT)
    for (let turn = 1; turn <= 300; turn += 1) {
      turnStart(long, turn, turn * 10)
      turnEnd(long, turn, turn * 10 + 5)
    }
    turnStart(long, 301, 9000)
    for (let step = 0; step < 1000; step += 1) long.append('step/start', { turn: 301, step }, 9001 + step)
    toolCall(long, 'late', 'bash', { command: 'sleep 600' }, 20_000)
    const running = agent(long, 'running')
    h.load(running)
    // The start of a turn longer than the part that is searched is still known.
    assert.deepEqual(await h.snapshot(ROOT), [
      { id: ROOT, depth: 0, name: '', state: 'running', since: T0 + 9000, activity: { tool: 'bash', summary: 'sleep 600' }, subagents: 0, queued: 0 },
    ])
    running.status = 'idle'
    turnEnd(long, 301, 21_000)
    assert.equal((await h.snapshot(ROOT))[0].since, T0 + 21_000)
    assert.ok(long.reads.length > 0)
    assert.ok(long.reads.every(([from, to]) => to - from <= 400), JSON.stringify(long.reads))
  })

  it('dates nothing for an agent that never ended a turn', async () => {
    const h = host()
    h.load(agent(session(ROOT)))
    assert.deepEqual(await h.snapshot(ROOT), [{ id: ROOT, depth: 0, name: '', state: 'idle', subagents: 0, queued: 0 }])
  })

  it('shows no activity for a running agent between two turns or between two calls', async () => {
    const h = host()
    const between = session(ROOT)
    turnStart(between, 1, 100)
    toolCall(between, 'call-1', 'bash', { command: 'true' }, 150)
    toolResult(between, 'call-1', 160)
    const running = agent(between, 'running')
    h.load(running)
    // Between two calls of an open turn.
    assert.deepEqual(await h.snapshot(ROOT), [{ id: ROOT, depth: 0, name: '', state: 'running', since: T0 + 100, subagents: 0, queued: 0 }])
    // The turn ended and the driver has not gone idle yet.
    turnEnd(between, 1, 200)
    assert.deepEqual(await h.snapshot(ROOT), [{ id: ROOT, depth: 0, name: '', state: 'running', subagents: 0, queued: 0 }])
  })
})

describe('names and labels', () => {
  it('falls back to the first eight characters of the id', async () => {
    const naming = { calls: 0 }
    const { h } = tree({
      subagents: {
        namesOf(one) {
          naming.calls += 1
          if (one.id === BUILDER) throw new Error('agent has no active runtime owner')
          if (one.id === CHECKER) return { self: '' }
          if (one.id === TESTER) return { self: TESTER }
          return { self: 'named' }
        },
      },
    })
    const rows = await h.snapshot(ROOT)
    assert.deepEqual(rows.map(row => row.name), ['', 'b1111111', 'c2222222', 'd3333333', 'named', 'named'])
    // The session's own agent is not asked for a name.
    assert.equal(naming.calls, 5)
  })

  it('takes the label from the subagent\'s own descriptor, not from one it inherited', async () => {
    const { h, agents } = tree()
    // The checker's history holds the builder's descriptor.
    const inherited = agents.checker.session.log.find(event => event.type === 'subagent/descriptor')
    assert.equal(inherited.data.label, 'Build the project')
    assert.equal(agents.checker.session.isOwnSeq(inherited.seq), false)
    const rows = await h.snapshot(ROOT)
    assert.equal(rows.find(row => row.id === CHECKER).label, 'Check the build')
  })

  it('looks again for a descriptor that was not written yet', async () => {
    const { h, agents } = tree()
    assert.equal('label' in (await h.snapshot(ROOT)).find(row => row.id === QUEUED), false)
    agents.queued.session.append('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'spawn', label: 'Late label' }, 9000)
    assert.equal((await h.snapshot(ROOT)).find(row => row.id === QUEUED).label, 'Late label')
  })

  it('reads a label once per agent', async () => {
    const { h, agents } = tree()
    // The checker runs, so its other reads start at its open turn; only the label read starts where its own events do.
    const { session: checker } = agents.checker
    const labelReads = () => checker.reads.filter(([from]) => from === checker.inheritedEventCount).length
    for (let poll = 0; poll < 3; poll += 1) {
      assert.equal((await h.snapshot(ROOT)).find(row => row.id === CHECKER).label, 'Check the build')
      assert.equal(labelReads(), 1)
    }
    // Another Agent object for the same Session is read again.
    h.load(agent(checker, 'running'))
    assert.equal((await h.snapshot(ROOT)).find(row => row.id === CHECKER).label, 'Check the build')
    assert.equal(labelReads(), 2)
  })
})

describe('optional services and unreadable agents', () => {
  it('leaves out what a missing service would supply', async () => {
    const { h } = tree({ subagents: undefined, jobs: undefined, goals: undefined })
    const rows = await h.snapshot(ROOT)
    assert.deepEqual(rows.map(row => row.name), ['', 'b1111111', 'c2222222', 'd3333333', 'e4444444', 'f5555555'])
    assert.ok(rows.every(row => !('jobs' in row) && !('goalWaiting' in row)))
    // Without a job registry the tester's jobs are unknown, so it reads as idle.
    assert.equal(rows.find(row => row.id === TESTER).state, 'idle')
  })

  it('leaves out what cannot be read about one agent and still answers', async () => {
    const { h, agents } = tree({
      jobs: { list: (caller) => { if (caller === TESTER) throw new Error('registry is closing'); return caller === BUILDER ? [BUILDER_COMMAND] : [] } },
    })
    agents.builder.session.snapshotEvents = () => { throw new Error('log unavailable') }
    Object.defineProperty(agents.queued, 'inbox', { get() { throw new Error('inbox unavailable') } })
    const rows = await h.snapshot(ROOT)
    // Without its log nothing tells that the builder's job is its tool call in flight, so the job is listed.
    assert.deepEqual(rows.find(row => row.id === BUILDER), {
      id: BUILDER, depth: 1, name: 'builder', state: 'running', jobs: [{ kind: 'bash', label: 'npm test', status: 'running', startedAt: T0 + 2400 }], subagents: 1, queued: 0,
    })
    assert.deepEqual(rows.find(row => row.id === TESTER), { id: TESTER, depth: 1, name: 'tester', label: 'Run the suite', state: 'idle', since: T0 + 4000, subagents: 0, queued: 0 })
    assert.deepEqual(rows.find(row => row.id === QUEUED), { id: QUEUED, depth: 1, name: 'e4444444', state: 'idle', since: T0 + 2800, jobs: [], subagents: 0 })
    assert.equal(rows.length, 6)
  })
})

describe('the job of a tool call in flight', () => {
  /** A running session agent with the given jobs; `build` writes its open turn. */
  function running(jobs, build) {
    const h = host({ jobs: registry(jobs) })
    const log = session(ROOT)
    turnStart(log, 1, 100)
    build(log)
    h.load(agent(log, 'running'))
    return { h, log }
  }
  const listed = async h => (await h.snapshot(ROOT))[0].jobs.map(one => one.label)

  it('is not listed while the call runs, and is listed once the call returned', async () => {
    const server = job(ROOT, 'running', 'npm run dev', 200)
    const command = job(ROOT, 'running', 'npm test', 400)
    const { h, log } = running([server, command], (s) => {
      // Started in the background: its call returned at once.
      toolCall(s, 'call-1', 'bash', { command: 'npm run dev', run_in_background: true }, 200)
      jobRegistered(s, server, by('call-1'))
      toolResult(s, 'call-1', 210)
      toolCall(s, 'call-2', 'bash', { command: 'npm test' }, 400)
      jobRegistered(s, command, by('call-2'))
    })
    const [row] = await h.snapshot(ROOT)
    assert.deepEqual(row.activity, { tool: 'bash', summary: 'npm test' })
    assert.deepEqual(row.jobs, [{ kind: 'bash', label: 'npm run dev', status: 'running', startedAt: T0 + 200 }])
    // At its timeout DSH moved the command to the background, and the call returned.
    toolResult(log, 'call-2', 10_400)
    assert.deepEqual(await listed(h), ['npm run dev', 'npm test'])
    // The same while the next call runs.
    toolCall(log, 'call-3', 'read', { file_path: '/repo/package.json' }, 10_500)
    assert.deepEqual(await listed(h), ['npm run dev', 'npm test'])
  })

  it('is not listed either when a call made inside that call registered it', async () => {
    const first = job(ROOT, 'running', 'make lint', 400)
    const second = job(ROOT, 'stopping', 'make test', 410)
    const { h } = running([first, second], (s) => {
      // A script's own tool calls are not in the log; the jobs they start name the script's call as their root.
      toolCall(s, 'call-1', 'run_code', { code: 'await Promise.all([bash("make lint"), bash("make test")])' }, 300)
      jobRegistered(s, first, { callId: 'call-1:ptc:1', rootCallId: 'call-1' })
      jobRegistered(s, second, { callId: 'call-1:ptc:2', rootCallId: 'call-1' })
    })
    assert.deepEqual(await listed(h), [])
  })

  it('is not listed either when its registration names only the call', async () => {
    const command = job(ROOT, 'running', 'npm test', 400)
    const { h } = running([command], (s) => {
      toolCall(s, 'call-1', 'bash', { command: 'npm test' }, 400)
      jobRegistered(s, command, { callId: 'call-1' })
    })
    assert.deepEqual(await listed(h), [])
  })

  it('is not listed for any of several calls in flight, of which the latest is the activity', async () => {
    const first = job(ROOT, 'running', 'npm run lint', 400)
    const second = job(ROOT, 'running', 'npm test', 410)
    const { h, log } = running([first, second], (s) => {
      toolCall(s, 'call-1', 'bash', { command: first.label }, 400)
      toolCall(s, 'call-2', 'bash', { command: second.label }, 410)
      jobRegistered(s, first, by('call-1'))
      jobRegistered(s, second, by('call-2'))
    })
    const [row] = await h.snapshot(ROOT)
    assert.deepEqual(row.activity, { tool: 'bash', summary: second.label })
    assert.deepEqual(row.jobs, [])
    // The later call returned first with its command moved to the background; the earlier one is still in flight.
    toolResult(log, 'call-2', 10_410)
    const [next] = await h.snapshot(ROOT)
    assert.deepEqual(next.activity, { tool: 'bash', summary: first.label })
    assert.deepEqual(next.jobs.map(one => one.label), [second.label])
  })

  it('is listed when the log does not tell that a call in flight registered it', async () => {
    const unrecorded = job(ROOT, 'running', 'no registration in the log', 150)
    const latest = job(ROOT, 'running', 'registered by the call in flight', 410)
    const toolless = job(ROOT, 'running', 'registered by no tool call', 420)
    const { h } = running([unrecorded, latest, toolless], (s) => {
      toolCall(s, 'call-1', 'bash', { command: latest.label }, 410)
      jobRegistered(s, latest, by('call-1'))
      jobRegistered(s, toolless)
    })
    const [row] = await h.snapshot(ROOT)
    assert.deepEqual(row.activity, { tool: 'bash', summary: latest.label })
    assert.deepEqual(row.jobs.map(one => one.label), [unrecorded.label, toolless.label])
  })
})

describe('goalWaiting', () => {
  const ARMED = { phase: 'active', activation: 'armed', roundsStarted: 2, maxGoalRounds: 10 }

  /**
   * The session agent with one subagent. `goal` is the session agent's goal
   * view, `null` for no goal, or a function that throws as the goal service
   * does; `goals: false` leaves the goal service out.
   */
  function setup({ goal = ARMED, rootStatus = 'idle', childStatus = 'idle', jobs = [], goals = true } = {}) {
    const root = session(ROOT)
    const child = subSession(BUILDER, ROOT, 100, { label: 'Work' })
    const views = { [ROOT]: goal }
    const h = host({
      jobs: registry(jobs),
      goals: goals ? { get: one => typeof views[one.id] === 'function' ? views[one.id]() : views[one.id] ?? undefined } : undefined,
    })
    const agents = { root: agent(root, rootStatus), child: agent(child, childStatus) }
    h.load(agents.root, agents.child)
    return { h, agents, views }
  }
  const waiting = async h => (await h.snapshot(ROOT))[0].goalWaiting

  it('is set while an armed goal with rounds left waits behind a job of the session agent', async () => {
    for (const status of ['running', 'stopping']) {
      const { h } = setup({ jobs: [job(ROOT, status, 'npm run build', 10)] })
      assert.equal(await waiting(h), true)
    }
  })

  it('is set while another agent of the session is running or waiting', async () => {
    assert.equal(await waiting(setup({ childStatus: 'running' }).h), true)
    assert.equal(await waiting(setup({ jobs: [job(BUILDER, 'running', 'make', 10)] }).h), true)
  })

  it('is set only on the session agent', async () => {
    const { h, views } = setup({ childStatus: 'running', jobs: [job(BUILDER, 'running', 'make', 10)] })
    views[BUILDER] = ARMED
    const rows = await h.snapshot(ROOT)
    assert.equal(rows[0].goalWaiting, true)
    assert.equal('goalWaiting' in rows[1], false)
  })

  it('is absent without a goal, a goal service, or a readable goal', async () => {
    // The same session with an armed goal does wait.
    assert.equal(await waiting(setup({ childStatus: 'running' }).h), true)
    assert.equal(await waiting(setup({ goal: null, childStatus: 'running' }).h), undefined)
    assert.equal(await waiting(setup({ goals: false, childStatus: 'running' }).h), undefined)
    assert.equal(await waiting(setup({ goal: () => { throw new Error('agent is not live') }, childStatus: 'running' }).h), undefined)
  })

  it('is absent for a goal that is not active and armed', async () => {
    for (const change of [{ phase: 'paused' }, { phase: 'blocked' }, { phase: 'complete' }, { activation: 'disarmed' }]) {
      assert.equal(await waiting(setup({ goal: { ...ARMED, ...change }, childStatus: 'running' }).h), undefined, JSON.stringify(change))
    }
  })

  it('is absent for a goal at its round limit', async () => {
    assert.equal(await waiting(setup({ goal: { ...ARMED, roundsStarted: 10 }, childStatus: 'running' }).h), undefined)
    assert.equal(await waiting(setup({ goal: { ...ARMED, roundsStarted: 9 }, childStatus: 'running' }).h), true)
  })

  it('is absent while the session agent is running', async () => {
    assert.equal(await waiting(setup({ rootStatus: 'running', childStatus: 'running' }).h), undefined)
  })

  it('is absent without background work', async () => {
    // The subagent is idle, or only has pending messages; finished and foreign jobs do not count.
    assert.equal(await waiting(setup().h), undefined)
    const { h, agents } = setup({ jobs: [job(ROOT, 'completed', 'ls', 10), job(undefined, 'running', 'shared', 10), job(id('99999999', 7), 'running', 'other', 10)] })
    agents.child.inbox.nextTurn.push({ id: 'm1' })
    assert.deepEqual((await h.snapshot(ROOT)).map(row => row.state), ['waiting', 'queued'])
    assert.equal(await waiting(h), undefined)
  })
})

describe('sessions', () => {
  /** The answer does not promise an order. */
  const byId = entries => [...entries].sort((a, b) => a.id.localeCompare(b.id))

  /** What the snapshots say the answer is: an entry for each agent whose own row waits, counting the rows of its tree. */
  async function fromSnapshots(h, agents) {
    const entries = []
    for (const one of agents) {
      const rows = await h.snapshot(one.id)
      const count = state => rows.filter(row => row.state === state).length
      if (rows[0].state === 'waiting') {
        entries.push({ id: one.id, running: count('running'), waiting: count('waiting'), subagentRunning: rows.some(row => row.depth === 1 && row.state === 'running') })
      }
    }
    return entries
  }

  it('lists every agent that waits on background work, with the running and waiting agents of its tree', async () => {
    const { h } = tree()
    assert.deepEqual(byId(await h.sessions()), [
      // Itself and the tester wait, the builder and its checker run; the subagents with pending messages and without work are in neither count.
      // The builder is a subagent it created itself.
      { id: ROOT, running: 2, waiting: 2, subagentRunning: true },
      // Stopped with a running and a stopping job.
      { id: TESTER, running: 0, waiting: 1, subagentRunning: false },
    ])
    // The request names nothing: it is answered whatever its payload is.
    for (const envelope of [{ type: 'client-request', rpcId: 'r1' }, { type: 'client-request', rpcId: 'r1', payload: { sessionId: BUILDER } }]) {
      const body = await (await h.post(JSON.stringify(envelope), 'sessions')).json()
      assert.deepEqual(byId(body.result.value.sessions).map(entry => entry.id), [ROOT, TESTER])
    }
  })

  it('counts a waiting subagent in its own entry and in the entry of each agent above it', async () => {
    const { h, agents } = tree()
    // The builder stopped while its checker runs.
    agents.builder.status = 'idle'
    assert.deepEqual(byId(await h.sessions()), [
      // The checker runs, but the builder created it: none of the root's own subagents is running.
      { id: ROOT, running: 1, waiting: 3, subagentRunning: false },
      { id: BUILDER, running: 1, waiting: 1, subagentRunning: true },
      { id: TESTER, running: 0, waiting: 1, subagentRunning: false },
    ])
  })

  it('gives every agent the state its snapshot gives it', async () => {
    for (const change of [
      () => {},
      (agents) => { agents.builder.status = 'idle' },
      (agents) => { agents.root.status = 'running' },
      (agents) => {
        agents.checker.status = 'idle'
        agents.checker.inbox.nextTurn.push({ id: 'm3' })
      },
    ]) {
      const { h, agents } = tree()
      change(agents)
      const answer = byId(await h.sessions())
      assert.deepEqual(answer, byId(await fromSnapshots(h, Object.values(agents))))
      assert.ok(answer.length > 0)
    }
  })

  it('keeps to the tree of each agent, and gives a waiting agent outside every tree its own entry', async () => {
    const { h } = tree()
    const other = session(id('99999999', 7))
    const stranger = subSession(id('88888888', 8), other.header.id, 100)
    // A historical ordinary fork keeps its source id but is not a subagent.
    const fork = session(id('77777777', 9), { parent: ROOT, createdAt: T0 + 100 })
    // Its creator is not loaded.
    const orphan = subSession(id('66666666', 10), id('55555555', 11), 100)
    const grandchild = subSession(id('44444444', 12), orphan.header.id, 200)
    h.load(agent(other), agent(stranger, 'running'), agent(fork, 'running'), agent(orphan), agent(grandchild))
    assert.deepEqual(byId(await h.sessions()), byId([
      { id: ROOT, running: 2, waiting: 2, subagentRunning: true },
      { id: TESTER, running: 0, waiting: 1, subagentRunning: false },
      { id: other.header.id, running: 1, waiting: 1, subagentRunning: true },
      { id: orphan.header.id, running: 0, waiting: 1, subagentRunning: false },
    ]))
  })

  it('reads no Session log', async () => {
    const { h, agents } = tree()
    assert.equal((await h.sessions()).length, 2)
    for (const one of Object.values(agents)) assert.deepEqual(one.session.reads, [])
  })

  it('counts no job without a job registry', async () => {
    const { h } = tree({ jobs: undefined })
    // The tester's jobs are unknown, so it reads as idle, as in its snapshot.
    assert.deepEqual(await h.sessions(), [{ id: ROOT, running: 2, waiting: 1, subagentRunning: true }])
  })

  it('skips an agent whose state cannot be read, and still answers', async () => {
    const { h, agents } = tree({ jobs: { list: (caller) => { if (caller === TESTER) throw new Error('registry is closing'); return [] } } })
    // Without its jobs nothing tells that the tester waits.
    assert.deepEqual(await h.sessions(), [{ id: ROOT, running: 2, waiting: 1, subagentRunning: true }])
    Object.defineProperty(agents.builder, 'status', { get() { throw new Error('agent is gone') } })
    // The builder is in no count and is not known to run; its checker still counts.
    assert.deepEqual(await h.sessions(), [{ id: ROOT, running: 1, waiting: 1, subagentRunning: false }])
    Object.defineProperty(agents.root, 'status', { get() { throw new Error('agent is gone') } })
    assert.deepEqual(await h.sessions(), [])
  })

  it('is empty while no agent waits', async () => {
    assert.deepEqual(await host().sessions(), [])
    // Finished and foreign jobs are not background work, and an agent that runs does not wait.
    const h = host({ jobs: registry([job(ROOT, 'completed', 'ls', 10), job(undefined, 'running', 'shared watcher', 10), job(BUILDER, 'running', 'make', 10)]) })
    h.load(agent(session(ROOT)), agent(session(BUILDER), 'running'))
    assert.deepEqual(await h.sessions(), [])
  })
})

describe('summarize', () => {
  const of = args => summarize(JSON.stringify(args))

  it('prefers the argument that tells most about the call', () => {
    assert.equal(of({ description: 'Run the tests', command: 'npm test' }), 'npm test')
    assert.equal(of({ limit: 20, file_path: '/repo/index.js' }), '/repo/index.js')
    assert.equal(of({ include: '*.ts', pattern: 'TODO' }), 'TODO')
    assert.equal(of({ name: 'checker', description: 'Check the build', prompt: 'Read everything…' }), 'Check the build')
  })

  it('otherwise takes the first text, also the first of a list', () => {
    assert.equal(of({ timeout_ms: 30000, agent: 'builder', message: 'status?' }), 'builder')
    assert.equal(of({ queries: ['dsh plugins', 'cordis'] }), 'dsh plugins')
  })

  it('puts the text on one line of at most 80 characters', () => {
    assert.equal(of({ command: 'cd /repo &&\n  npm test\t--watch ' }), 'cd /repo && npm test --watch')
    const cut = of({ command: 'x'.repeat(200) })
    assert.equal(cut, `${'x'.repeat(79)}…`)
    assert.equal(Array.from(cut).length, 80)
    assert.equal(of({ command: 'y'.repeat(80) }), 'y'.repeat(80))
  })

  it('is undefined without a text argument or readable arguments', () => {
    assert.equal(of({ timeout_ms: 30000 }), undefined)
    assert.equal(of({ todos: [{ content: 'a', status: 'pending' }] }), undefined)
    assert.equal(of({ command: '   ' }), undefined)
    assert.equal(of([1, 2]), undefined)
    assert.equal(summarize('{"command": "npm te'), undefined)
    assert.equal(summarize(''), undefined)
  })
})
