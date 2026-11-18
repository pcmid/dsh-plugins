/**
 * Host half of @pcmid/dsh-agent-monitor: two owner-only routes under
 * `/api/pcmid/agent-monitor` that tell the browser half what the loaded agents
 * are doing. Both read and change nothing.
 *
 * `snapshot` describes the agents of one session, for the strip above the
 * composer: the viewed Session's agent and the loaded agents it created as
 * subagents, directly or through other loaded agents, a parent before its
 * children. It reads live state and Session logs.
 *
 * `sessions` lists every loaded agent that waits on background work, with how
 * many agents of its tree are running and waiting and whether one of its own
 * subagents is running, for the marks on the sidebar's session rows. It reads
 * live state only.
 *
 * Subagent names, background jobs, and goals come from optional services; what
 * a missing service would supply, and anything that cannot be read about one
 * agent, is left out of the answer instead of failing it.
 *
 * @module @pcmid/dsh-agent-monitor
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'agent-monitor'

/** Route registration and the live Agents. */
export const inject = ['connection', 'agents']

/** Route prefix of the browser half's API. */
const API = '/api/pcmid/agent-monitor'

/** Newest events of a log searched for the tool call in flight, or for the end of the last turn. */
const TAIL_EVENTS = 400

/** A subagent's descriptor is written when it is created, so it lies within this many events after its inherited history. */
const DESCRIPTOR_EVENTS = 200

/** Longest activity summary and job label, in characters. */
const TEXT_LIMIT = 80

/** Arguments that say most about a tool call, most telling first. A call with none of them shows its first text argument. */
const TELLING_ARGUMENTS = ['command', 'file_path', 'pattern', 'url', 'query', 'description']

/**
 * Put a text on one line of at most {@link TEXT_LIMIT} characters.
 * @param {string} text - any text.
 * @returns {string} the text with whitespace runs collapsed; a longer text ends in an ellipsis.
 */
function oneLine(text) {
  // The head is enough; the rest of a long argument is never shown.
  const chars = Array.from(text.slice(0, 1000).replace(/\s+/gu, ' ').trim())
  return chars.length > TEXT_LIMIT ? `${chars.slice(0, TEXT_LIMIT - 1).join('')}…` : chars.join('')
}

/**
 * The most telling argument of a tool call, on one line.
 * @param {string} json - the call's arguments as the model wrote them.
 * @returns {string | undefined} the summary; undefined when the arguments hold no text.
 */
export function summarize(json) {
  let args
  try {
    args = JSON.parse(json)
  } catch {
    return undefined
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  for (const key of [...TELLING_ARGUMENTS.filter(key => Object.hasOwn(args, key)), ...Object.keys(args)]) {
    // A list of texts, such as search queries, is told by its first one.
    const value = Array.isArray(args[key]) ? args[key][0] : args[key]
    const text = typeof value === 'string' ? oneLine(value) : ''
    if (text !== '') return text
  }
  return undefined
}

/**
 * When an agent's current state began and, while it runs, the latest tool call
 * in flight and the jobs that calls in flight registered.
 * @param session - the agent's Session.
 * @param {boolean} running - whether the agent is running.
 * @param {(session: object) => { openTurnStartSeq: number | null }} turnOf - reads a Session's turn boundary.
 * @returns {{ since?: number, activity?: { tool: string, summary?: string }, foreground?: Set<string> }} what the log tells; `foreground` holds job ids.
 */
function readLog(session, running, turnOf) {
  const end = session.seq
  if (!running) {
    // Idle since its latest turn ended. A forked subagent's log starts with its creator's history, whose turns are not its own.
    const ended = session.snapshotEvents(Math.max(session.inheritedEventCount, end - TAIL_EVENTS), end).findLast(event => event.type === 'turn/end')
    return ended === undefined ? {} : { since: ended.time }
  }
  // Harness keeps the position of the open turn's start, so a turn of any length is dated without a search.
  const start = turnOf(session).openTurnStartSeq
  // Running between two turns: the driver is opening or closing one.
  if (start === null) return {}
  const facts = {}
  const opened = session.snapshotEvents(start, start + 1)[0]
  if (opened !== undefined) facts.since = opened.time
  // The calls without a result. Going backwards, a call's result is seen before the call, and the latest such call first.
  const tail = session.snapshotEvents(Math.max(start, end - TAIL_EVENTS), end)
  const finished = new Set()
  const inFlight = new Set()
  const registered = []
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const event = tail[index]
    if (event.type === 'tool/result') {
      finished.add(event.data.message.toolCallId)
    } else if (event.type === 'job/registered') {
      registered.push(event.data)
    } else if (event.type === 'tool/call' && !finished.has(event.data.callId)) {
      if (inFlight.size === 0) {
        const summary = summarize(event.data.arguments)
        facts.activity = summary === undefined ? { tool: event.data.name } : { tool: event.data.name, summary }
      }
      inFlight.add(event.data.callId)
    }
  }
  // A call made from inside another, as a script's own tool calls are, names that one as its root.
  if (inFlight.size > 0) {
    facts.foreground = new Set(registered
      .filter(({ toolCall }) => inFlight.has(toolCall?.callId) || inFlight.has(toolCall?.rootCallId))
      .map(({ jobId }) => jobId))
  }
  return facts
}

/**
 * Read a value that is left out of the answer when it cannot be read.
 * @template T
 * @param {() => T} read - the read; it may throw.
 * @returns {T | undefined} the value, or undefined when the read threw.
 */
function attempt(read) {
  try {
    return read()
  } catch {
    return undefined
  }
}

/**
 * Build the two operations over the Harness services they read.
 * @param {object} sources - the reads.
 * @param {(sessionId: string) => object | undefined} sources.agentOf - the loaded Agent of a Session.
 * @param {() => object[]} sources.agents - every loaded Agent.
 * @param {(session: object) => { openTurnStartSeq: number | null }} sources.turnOf - a Session's turn boundary.
 * @param {(agent: object) => string | undefined} sources.nameOf - an agent's model-facing name; may throw.
 * @param {(sessionId: string) => object[] | undefined} sources.jobsOf - the jobs a Session can see; undefined without a job registry.
 * @param {(agent: object) => object | undefined} sources.goalOf - an agent's goal; may throw.
 * @returns {{ snapshot: (sessionId: string) => { agents: object[] }, sessions: () => { sessions: object[] } }} the operations.
 */
function createOperations({ agentOf, agents, turnOf, nameOf, jobsOf, goalOf }) {
  /** Task labels read so far, by Agent. A descriptor does not change once written. */
  const labels = new WeakMap()

  /**
   * A subagent's task label, from its own descriptor. A forked subagent's log
   * starts with its creator's history, which holds the creator's descriptor
   * when the creator is a subagent too, so the read starts after that history.
   */
  function labelOf(agent) {
    if (labels.has(agent)) return labels.get(agent)
    const own = agent.session.inheritedEventCount
    const descriptor = agent.session.snapshotEvents(own, own + DESCRIPTOR_EVENTS).find(event => event.type === 'subagent/descriptor')
    // Not written yet: the next request looks again.
    if (descriptor === undefined) return undefined
    const label = typeof descriptor.data.label === 'string' && descriptor.data.label !== '' ? descriptor.data.label : undefined
    labels.set(agent, label)
    return label
  }

  /** The name the model uses for a subagent, or the start of its Session id. */
  function nameFor(agent) {
    const name = attempt(() => nameOf(agent))
    // Harness addresses a subagent without a name by its whole Session id.
    return typeof name === 'string' && name !== '' && name !== agent.id ? name : agent.id.slice(0, 8)
  }

  /**
   * The jobs of a Session that are still running or stopping. Harness also
   * registers a command that runs in the foreground as a job, so that it can
   * move to the background at a timeout. Until its tool call returns, such a
   * job is that call and not background work; the ids in `foreground` are
   * left out.
   */
  function liveJobs(sessionId, foreground) {
    return jobsOf(sessionId)
      ?.filter(job => job.owner === sessionId && (job.status === 'running' || job.status === 'stopping') && foreground?.has(job.id) !== true)
      .map(job => ({
        kind: job.kind,
        label: oneLine(job.label.split('\n', 1)[0]),
        status: job.status,
        ...typeof job.startedAt === 'number' ? { startedAt: job.startedAt } : {},
      }))
  }

  /**
   * An agent's state, with the two live reads that decide it. The state is
   * `running` while the agent runs; `waiting` once it has stopped and
   * background work remains, a live job of its own or a loaded subagent;
   * `queued` once it has stopped with messages to process; `idle` otherwise.
   * A read that fails finds nothing and leaves its value undefined.
   * @param agent - a loaded Agent.
   * @param {number} subagents - how many loaded subagents it created.
   * @param {Set<string>} [foreground] - ids of its jobs that are tool calls in flight.
   * @returns {{ state: string, jobs?: object[], queued?: number }} the state and the reads.
   */
  function live(agent, subagents, foreground) {
    const jobs = attempt(() => liveJobs(agent.id, foreground))
    const queued = attempt(() => agent.inbox.nextTurn.length + agent.inbox.nextStep.length)
    let state = 'idle'
    if (agent.status === 'running') state = 'running'
    else if ((jobs?.length ?? 0) > 0 || subagents > 0) state = 'waiting'
    else if ((queued ?? 0) > 0) state = 'queued'
    return { state, jobs, queued }
  }

  /** One row of the answer. */
  function describe(agent, depth, subagents) {
    const running = agent.status === 'running'
    const log = attempt(() => readLog(agent.session, running, turnOf)) ?? {}
    const { state, jobs, queued } = live(agent, subagents, log.foreground)
    const label = depth === 0 ? undefined : attempt(() => labelOf(agent))
    return {
      id: agent.id,
      depth,
      name: depth === 0 ? '' : nameFor(agent),
      ...label === undefined ? {} : { label },
      state,
      ...log.since === undefined ? {} : { since: log.since },
      ...log.activity === undefined ? {} : { activity: log.activity },
      ...jobs === undefined ? {} : { jobs },
      subagents,
      ...queued === undefined ? {} : { queued },
    }
  }

  /**
   * Group subagents by the Session that created them.
   * @param {object[]} loaded - every loaded Agent.
   * @returns {Map<string, object[]>} the subagents among them by their creator's id, oldest first.
   */
  function subagentsByCreator(loaded) {
    const created = new Map()
    for (const agent of loaded) {
      const { origin, parentSession } = agent.session.header
      if (origin !== 'subagent' || parentSession === undefined) continue
      const siblings = created.get(parentSession)
      if (siblings === undefined) created.set(parentSession, [agent])
      else siblings.push(agent)
    }
    for (const siblings of created.values()) siblings.sort((a, b) => a.session.header.createdAt - b.session.header.createdAt)
    return created
  }

  /** The agents of one session: its own agent, then each subagent before its own subagents. Empty for a Session without a loaded agent. */
  function snapshot(sessionId) {
    const viewed = agentOf(sessionId)
    if (viewed === undefined) return { agents: [] }
    const created = subagentsByCreator(agents())
    const rows = []
    const visit = (agent, depth) => {
      const children = created.get(agent.id) ?? []
      rows.push(describe(agent, depth, children.length))
      for (const child of children) visit(child, depth + 1)
    }
    visit(viewed, 0)

    // An armed goal with rounds left starts its next round from an idle agent; background work holds that round back.
    const [self, ...others] = rows
    const goal = attempt(() => goalOf(viewed))
    const background = (self.jobs?.length ?? 0) > 0 || others.some(row => row.state === 'running' || row.state === 'waiting')
    if (goal?.phase === 'active' && goal.activation === 'armed' && goal.roundsStarted < goal.maxGoalRounds
      && self.state !== 'running' && background) self.goalWaiting = true
    return { agents: rows }
  }

  /**
   * Every loaded agent that waits on background work, with how many agents of
   * its tree, itself included, are running and how many are waiting, and
   * whether a subagent it created itself is running. The states are those
   * `snapshot` gives, without a read of any Session log: an agent that has
   * stopped has no tool call in flight, so every live job it owns is
   * background work, and a running agent is running whatever it owns.
   */
  function sessions() {
    const loaded = agents()
    const created = subagentsByCreator(loaded)
    // An agent whose state cannot be read is in no count and has no entry of its own.
    const states = new Map(loaded.map(agent => [agent.id, attempt(() => live(agent, created.get(agent.id)?.length ?? 0).state)]))
    const count = (id, counts) => {
      const state = states.get(id)
      if (state === 'running' || state === 'waiting') counts[state] += 1
      for (const child of created.get(id) ?? []) count(child.id, counts)
      return counts
    }
    return {
      sessions: loaded.filter(agent => states.get(agent.id) === 'waiting').map(agent => ({
        id: agent.id,
        ...count(agent.id, { running: 0, waiting: 0 }),
        subagentRunning: (created.get(agent.id) ?? []).some(child => states.get(child.id) === 'running'),
      })),
    }
  }

  return { snapshot, sessions }
}

/**
 * Register the routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  const { snapshot, sessions } = createOperations({
    agentOf: sessionId => ctx.agents.get(sessionId),
    agents: () => ctx.agents.list(),
    turnOf: session => ctx.agents.turnBoundaryOf(session),
    nameOf: agent => ctx.get('subagents')?.namesOf(agent).self,
    jobsOf: sessionId => ctx.get('jobs')?.list(sessionId),
    goalOf: agent => ctx.get('goals')?.get(agent),
  })

  /**
   * Register one exact POST route that speaks the Connection RPC envelope, as the browser half's `rpc.call` sends it.
   * @param {string} endpoint - the route's name under {@link API}.
   * @param {(payload: unknown) => object | undefined} answer - the value for a request's payload; undefined for a payload it cannot answer.
   */
  function serve(endpoint, answer) {
    ctx.connection.fetch.register({
      path: `${API}/${endpoint}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let envelope
        try {
          envelope = await request.json()
        } catch {
          // A body that is not JSON carries no rpcId to answer.
          return new Response('body is not JSON', { status: 400 })
        }
        const rpcId = typeof envelope?.rpcId === 'string' ? envelope.rpcId : 'invalid-request'
        const failure = (code, message) => ({ ok: false, error: { code, message, details: {} } })
        let result
        try {
          const value = envelope?.type === 'client-request' ? answer(envelope.payload) : undefined
          result = value === undefined ? failure('bad-request', `Expected a client-request envelope with the payload of ${endpoint}`) : { ok: true, value }
        } catch (error) {
          result = failure('internal', error?.message ?? String(error))
        }
        return Response.json({ type: 'server-response', rpcId, result })
      },
    })
  }

  serve('snapshot', payload => typeof payload?.sessionId === 'string' ? snapshot(payload.sessionId) : undefined)
  // The answer covers every session, so the payload names nothing.
  serve('sessions', () => sessions())
}
