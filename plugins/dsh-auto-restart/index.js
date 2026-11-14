/**
 * Continue interrupted conversations after the Harness restarts.
 *
 * While the Host runs, a `session/event` listener keeps a small candidate list
 * in `<DSH_HOME>/auto-restart/<profile>.json`: every root Session whose turn is
 * open, plus the root of every subagent whose turn is open. A turn that ends on
 * its own (completed, failed, stopped by the user) removes its entry; a turn cut
 * off by shutdown (`aborted` with cause `disposed` or `parent`) leaves it, and a
 * crash leaves it because nothing runs. Nothing is written at exit.
 *
 * After the next successful startup, each candidate is judged from its own
 * Session log, which stays authoritative: the last turn must have been cut off
 * in an earlier process, within `maxAgeHours`, and the number of automatic
 * continuations since the last human message must stay within `maxAttempts`.
 * A continued root Session is resumed through the Web Session controller
 * (preset, model, and permissions come from its log) and receives one
 * next-turn notice that wakes it; the notice runs first, and messages already
 * queued stay queued behind it in their order. An active goal is rearmed when `rearmGoals`
 * is set; the goal round runs after the notice turn.
 *
 * @module @pcmid/dsh-auto-restart
 */

import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'auto-restart'

/** Session store, Agent registry, cold Session reads, Web Session activation, and the startup signal. */
export const inject = ['sessions', 'agents', 'sessionQuery', 'sessionController', 'appReady']

/** Message source kind of the continuation notice. */
export const SOURCE_KIND = 'auto-restart'

/** Source kinds of messages a person sent; one of them resets the continuation count. */
const HUMAN_SOURCE_KINDS = new Set(['user', 'retry'])

/** Version of the candidate-list file. */
const STATE_VERSION = 1

/** Ancestor walk bound for subagent roots. */
const MAX_ANCESTRY = 64

export const Config = z.object({
  afterShutdown: z.boolean().default(true)
    .description('Also continue turns cut off by an orderly quit or restart. When false, only turns cut off by a crash or forced kill are continued.'),
  includeSubagents: z.boolean().default(true)
    .description('Also wake a conversation whose own turn had ended but whose subagents were still running when the Harness stopped.'),
  maxAgeHours: z.natural().min(1).default(24)
    .description('Continue only interruptions younger than this many hours at startup.'),
  maxAttempts: z.natural().min(1).default(3)
    .description('Maximum automatic continuations of one conversation since the last message a person sent to it.'),
  rearmGoals: z.boolean().default(true)
    .description('Rearm an active goal after continuing, so its rounds go on without a person resuming it.'),
  startDelaySeconds: z.natural().max(600).default(5)
    .description('Wait after startup before continuing conversations, so late providers and MCP servers can connect.'),
  concurrency: z.natural().min(1).max(16).default(2)
    .description('How many conversations are resumed at the same time.'),
})

// ---------------------------------------------------------------------------
// Log reading
// ---------------------------------------------------------------------------

/**
 * Classify one turn ending.
 * @param reason - `turn/end` reason.
 * @returns `crash` for a turn closed after a crash, `shutdown` for a turn cut off by teardown,
 *   or `undefined` for a turn that ended on its own.
 */
export function endCause(reason) {
  if (reason?.kind === 'interrupted') return 'crash'
  if (reason?.kind === 'aborted' && (reason.reason?.kind === 'disposed' || reason.reason?.kind === 'parent')) return 'shutdown'
  return undefined
}

/** Messages recorded by one event: inbox insertions and committed user messages. */
function messagesOf(event) {
  if (event.type === 'user/message') return [event.data]
  if (event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)) return event.data.inserted
  return []
}

/**
 * Fold the facts recovery needs from one Session log.
 * @param events - complete log; a cold read already closes a crashed tail turn.
 * @returns the last turn ending, whether a turn is open, the latest turn number,
 *   and the automatic continuations since the last human message.
 */
export function summarize(events) {
  let lastEnd
  let lastStartSeq = -1
  let lastTurn = 0
  for (const event of events) {
    if (event.type === 'turn/start') {
      lastStartSeq = event.seq
      lastTurn = Math.max(lastTurn, event.data.turn)
    } else if (event.type === 'turn/end') {
      lastEnd = { seq: event.seq, time: event.time, turn: event.data.turn, reason: event.data.reason }
    }
  }
  const notices = new Set()
  scan: for (let index = events.length - 1; index >= 0; index--) {
    for (const message of messagesOf(events[index])) {
      const kind = message?.source?.kind
      if (HUMAN_SOURCE_KINDS.has(kind)) break scan
      if (kind === SOURCE_KIND) notices.add(message.id)
    }
  }
  return {
    lastEnd,
    open: lastStartSeq > (lastEnd?.seq ?? -1),
    lastTurn,
    continuations: notices.size,
  }
}

/**
 * Whether one ending counts as an interruption this process should continue.
 * @returns the cause, or `undefined` when it does not count.
 */
function interruption(end, { processStart, now, maxAgeMs, afterShutdown }) {
  if (end === undefined) return undefined
  const cause = endCause(end.reason)
  if (cause === undefined || (cause === 'shutdown' && !afterShutdown)) return undefined
  // An ending from this process is not a restart; an old one is not continued unattended.
  if (end.time >= processStart || now - end.time > maxAgeMs) return undefined
  return cause
}

/**
 * Decide what to do with one candidate.
 * @param root - {@link summarize} of the root log.
 * @param children - `{ id, summary }` of each recorded subagent.
 * @param options - `processStart`, `now`, `maxAgeMs`, `afterShutdown`, `maxAttempts`.
 * @returns `{ action: 'continue', rootCause, children, attempt, lastTurn }`,
 *   `{ action: 'wait' }` while work runs, or `{ action: 'drop', reason }`.
 */
export function plan(root, children, options) {
  if (root.open || children.some(child => child.summary.open)) return { action: 'wait' }
  const rootCause = interruption(root.lastEnd, options)
  // A subagent stopped before the root's latest turn ending was already followed by root work.
  const after = root.lastEnd?.time ?? Number.NEGATIVE_INFINITY
  const stopped = children
    .filter(child => child.summary.lastEnd !== undefined && child.summary.lastEnd.time >= after)
    .filter(child => interruption(child.summary.lastEnd, options) !== undefined)
    .map(child => child.id)
  if (rootCause === undefined && stopped.length === 0) return { action: 'drop', reason: 'nothing to continue' }
  const attempt = root.continuations + 1
  if (attempt > options.maxAttempts) {
    return { action: 'drop', reason: `${root.continuations} automatic continuations since the last human message` }
  }
  return { action: 'continue', rootCause, children: stopped, attempt, lastTurn: root.lastTurn }
}

/**
 * Model-facing continuation notice.
 * @param decision - a `continue` decision from {@link plan}.
 * @returns the notice text.
 */
export function noticeText({ rootCause, children, attempt }) {
  const lines = []
  if (rootCause === 'crash') {
    lines.push('The application running this conversation stopped unexpectedly while you were working, and it has restarted. Your previous turn was cut off before it finished.')
  } else if (rootCause === 'shutdown') {
    lines.push('The application running this conversation was shut down while you were working, and it has restarted. Your previous turn was cut off before it finished.')
  } else {
    lines.push('The application running this conversation restarted while subagents you started were still working. They were stopped before they finished, so their results will not arrive on their own.')
  }
  if (rootCause !== undefined && children.length > 0) {
    lines.push('Subagents you started were also still working and were stopped before they finished.')
  }
  lines.push(
    'Continue the task from where it stopped. Background jobs, terminals, and subagents that were running before the restart are no longer running: check their state before relying on them, and restart only what is still needed. For a tool call whose outcome is unknown, verify the external state before repeating it. If the task is already complete, reply briefly and stop.',
  )
  if (attempt > 1) {
    lines.push(`This is automatic continuation ${attempt} in a row: the previous one was also cut off. If a specific action caused the stop, do not repeat it the same way.`)
  }
  return lines.join('\n\n')
}

// ---------------------------------------------------------------------------
// Candidate list
// ---------------------------------------------------------------------------

/** Candidate list kept in memory and written to one JSON file after each change. */
export class CandidateStore {
  /**
   * @param file - absolute JSON file path.
   * @param logger - Cordis logger.
   */
  constructor(file, logger) {
    this.file = file
    this.logger = logger
    /** @type {Map<string, { root: boolean, children: Set<string> }>} */
    this.entries = new Map()
    this.chain = Promise.resolve()
    this.scheduled = false
    this.ready = this.load()
  }

  async load() {
    let text
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger.warn(`auto-restart: cannot read ${this.file}: ${describe(error)}`)
      return
    }
    try {
      const value = JSON.parse(text)
      if (value?.version !== STATE_VERSION || typeof value.sessions !== 'object' || value.sessions === null) {
        throw new Error(`unsupported content (version ${JSON.stringify(value?.version)})`)
      }
      for (const [id, entry] of Object.entries(value.sessions)) {
        const children = Array.isArray(entry?.children) ? entry.children.filter(child => typeof child === 'string') : []
        if (entry?.root === true || children.length > 0) this.entries.set(id, { root: entry.root === true, children: new Set(children) })
      }
    } catch (error) {
      this.logger.warn(`auto-restart: ignoring unreadable ${this.file}: ${describe(error)}`)
      await rename(this.file, `${this.file}.bad`).catch(() => undefined)
    }
  }

  /** Root ids with their recorded subagents, as a snapshot. */
  snapshot() {
    return [...this.entries].map(([id, entry]) => ({ id, root: entry.root, children: [...entry.children] }))
  }

  setRoot(id, running) {
    const entry = this.entries.get(id)
    if (running) {
      if (entry?.root === true) return
      if (entry === undefined) this.entries.set(id, { root: true, children: new Set() })
      else entry.root = true
    } else {
      if (entry === undefined || !entry.root) return
      entry.root = false
      this.prune(id, entry)
    }
    this.save()
  }

  addChild(rootId, childId) {
    const entry = this.entries.get(rootId)
    if (entry?.children.has(childId)) return
    if (entry === undefined) this.entries.set(rootId, { root: false, children: new Set([childId]) })
    else entry.children.add(childId)
    this.save()
  }

  removeChild(rootId, childId) {
    const entry = this.entries.get(rootId)
    if (entry === undefined || !entry.children.delete(childId)) return
    this.prune(rootId, entry)
    this.save()
  }

  clearChildren(id) {
    const entry = this.entries.get(id)
    if (entry === undefined || entry.children.size === 0) return
    entry.children.clear()
    this.prune(id, entry)
    this.save()
  }

  delete(id) {
    if (this.entries.delete(id)) this.save()
  }

  prune(id, entry) {
    if (!entry.root && entry.children.size === 0) this.entries.delete(id)
  }

  /** Coalesce writes: one queued write persists every change made before it runs. */
  save() {
    if (this.scheduled) return
    this.scheduled = true
    this.chain = this.chain.then(async () => {
      this.scheduled = false
      const sessions = {}
      for (const [id, entry] of this.entries) sessions[id] = { root: entry.root, children: [...entry.children] }
      await mkdir(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify({ version: STATE_VERSION, sessions }, null, 2)}\n`)
      await rename(temporary, this.file)
    }).catch((error) => {
      this.logger.warn(`auto-restart: cannot write ${this.file}: ${describe(error)}`)
    })
  }

  /** Resolves after every queued write settled. */
  flush() {
    return this.chain
  }
}

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

/**
 * Root Session id of a subagent Session, walking live parent headers.
 * @returns the root id, or `undefined` without a parent.
 */
export function rootIdOf(session, sessions) {
  let header = session.header
  for (let hop = 0; hop < MAX_ANCESTRY && header.origin === 'subagent'; hop++) {
    const parentId = header.parentSession
    if (parentId === undefined) return undefined
    const parent = sessions.get(parentId)
    if (parent === undefined) return parentId
    header = parent.header
  }
  return header.origin === 'subagent' ? undefined : header.id
}

/**
 * Build the `session/event` listener that maintains the candidate list.
 * @param store - candidate list; mutations wait for its initial load.
 * @param sessions - live Session store, for subagent ancestry.
 * @returns the listener.
 */
export function createTracker(store, sessions) {
  return function onSessionEvent(session, event) {
    if (event.type !== 'turn/start' && event.type !== 'turn/end') return
    const running = event.type === 'turn/start'
    // A turn cut off by teardown stays a candidate; only a turn that ended on its own leaves.
    if (!running && endCause(event.data.reason) !== undefined) return
    if (session.header.origin === 'subagent') {
      const rootId = rootIdOf(session, sessions)
      if (rootId === undefined) return
      void store.ready.then(() => {
        if (running) store.addChild(rootId, session.id)
        else store.removeChild(rootId, session.id)
      })
      return
    }
    void store.ready.then(() => { store.setRoot(session.id, running) })
  }
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

function describe(error) {
  if (error instanceof Error) return error.code ? `${error.code}: ${error.message}` : error.message
  return String(error)
}

function isNotFound(error) {
  return error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND'
    || error?.code === 'session/not-found'
    || error?.name === 'SessionPersistenceNotFoundError'
}

/**
 * Run `work` over `items` with at most `limit` in flight.
 * @returns resolution after every item settled.
 */
async function pool(items, limit, work) {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++])
  })
  await Promise.all(runners)
}

/**
 * Start `message` as the next turn of an idle Agent, ahead of messages already
 * queued; those stay queued in their order behind it. `followup` appends, so the
 * message is moved to the front while maintenance holds the wake, the same way
 * the Session controller sends a parked queued message.
 * @param agent - idle Agent.
 * @param message - message to deliver now.
 * @returns resolution after the wake was released.
 */
export async function sendFirst(agent, message) {
  const deliver = () => {
    agent.followup(message)
    if (agent.inbox.nextTurn[0]?.id !== message.id) {
      agent.inbox.remove(message.id)
      agent.inbox.prepend('next-turn', message)
    }
  }
  let held
  try {
    held = agent.runMaintenance(async () => { deliver() })
  } catch (_maintenanceActive) {
    // Another maintenance task owns the idle Agent and holds the wake the same way.
    deliver()
    return
  }
  await held
}

/**
 * Build the startup recovery pass.
 * @param ctx - Host context with the injected services.
 * @param config - resolved plugin config.
 * @param store - candidate list.
 * @param clock - `processStart` and `now()`, replaceable by tests.
 * @returns `recover(signal)`, resolving after every candidate settled.
 */
export function createRecovery(ctx, config, store, clock) {
  const options = () => ({
    processStart: clock.processStart,
    now: clock.now(),
    maxAgeMs: config.maxAgeHours * 3_600_000,
    afterShutdown: config.afterShutdown,
    maxAttempts: config.maxAttempts,
  })

  /** Summary and header of one stored or live Session, or `undefined` when none exists. */
  async function read(id, signal) {
    let observation
    try {
      observation = await ctx.sessionQuery.observeSession(id, { signal, projectionMode: 'none' })
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
    try {
      return { header: observation.header, summary: summarize(observation.events) }
    } finally {
      observation[Symbol.dispose]()
    }
  }

  function archived(id) {
    return ctx.get('workspaceRegistry')?.archivedSessionIds?.includes(id) ?? false
  }

  function rearmGoal(agent) {
    const goals = ctx.get('goals')
    if (!config.rearmGoals || goals === undefined) return undefined
    const goal = goals.get(agent)
    if (goal === undefined || goal.phase !== 'active' || goal.activation === 'armed') return undefined
    if (goal.roundsStarted >= goal.maxGoalRounds) return 'goal round budget exhausted'
    goals.resume(agent, { id: goal.id, revision: goal.revision })
    return 'goal rearmed'
  }

  async function recoverOne(candidate, signal) {
    const { id } = candidate
    if (signal.aborted) return
    if (archived(id)) {
      store.delete(id)
      ctx.logger.info(`auto-restart: ${id}: archived, not continued`)
      return
    }
    const root = await read(id, signal)
    if (root === undefined || root.header.origin === 'subagent') {
      store.delete(id)
      return
    }
    const children = []
    if (config.includeSubagents) {
      for (const childId of candidate.children) {
        const child = await read(childId, signal)
        if (child !== undefined) children.push({ id: childId, summary: child.summary })
      }
    }
    const decision = plan(root.summary, children, options())
    if (decision.action === 'wait') return
    if (decision.action === 'drop') {
      store.delete(id)
      ctx.logger.info(`auto-restart: ${id}: not continued (${decision.reason})`)
      return
    }
    if (signal.aborted) return

    const resolved = await ctx.sessionController.resolveAgent(id)
    if ('error' in resolved) {
      store.delete(id)
      ctx.logger.warn(`auto-restart: ${id}: cannot resume: ${describe(resolved.error)}`)
      return
    }
    const agent = resolved.agent
    const boundary = ctx.agents.turnBoundaryOf(agent.session)
    // Someone else (a client, a schedule delivery) already drove this conversation in this process.
    if (agent.status !== 'idle' || boundary.openTurnStartSeq !== null || boundary.lastTurn !== decision.lastTurn) {
      ctx.logger.info(`auto-restart: ${id}: already active again, not continued`)
      return
    }
    if (signal.aborted) return
    // A notice that never started its turn is replaced, not duplicated.
    for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
      if (message.source?.kind === SOURCE_KIND) agent.inbox.remove(message.id)
    }
    await sendFirst(agent, createUserMessage({
      content: [{ type: 'text', text: noticeText(decision) }],
      source: {
        kind: SOURCE_KIND,
        attempt: decision.attempt,
        form: 'notice',
        summary: decision.rootCause === undefined
          ? 'Harness restarted; waking the conversation for its stopped subagents'
          : 'Harness restarted; continuing the interrupted turn',
      },
    }))
    if (!(await ctx.sessions.flush(agent.session))) {
      ctx.logger.warn(`auto-restart: ${id}: the continuation notice was queued but not confirmed durable`)
    }
    store.clearChildren(id)
    let goal
    try {
      goal = rearmGoal(agent)
    } catch (error) {
      goal = `goal not rearmed: ${describe(error)}`
    }
    const what = decision.rootCause ?? `${decision.children.length} stopped subagent(s)`
    ctx.logger.info(`auto-restart: ${id}: continued after ${what}, attempt ${decision.attempt}/${config.maxAttempts}${goal ? `, ${goal}` : ''}`)
  }

  return async function recover(signal) {
    await store.ready
    await pool(store.snapshot(), config.concurrency, async (candidate) => {
      try {
        await recoverOne(candidate, signal)
      } catch (error) {
        if (!signal.aborted) ctx.logger.warn(`auto-restart: ${candidate.id}: ${describe(error)}`)
      }
    })
  }
}

/**
 * Candidate-list file of one profile.
 * @returns `<DSH_HOME>/auto-restart/<profile>.json`.
 */
export function stateFile(ctx) {
  const profile = ctx.get('profileContext')
  const home = profile?.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const name = (profile?.name ?? 'default').replace(/[^A-Za-z0-9._-]/g, '_')
  return join(home, 'auto-restart', `${name}.json`)
}

/** Track running turns and continue interrupted ones after the next startup. */
export function apply(ctx, config) {
  const store = new CandidateStore(stateFile(ctx), ctx.logger)
  ctx.on('session/event', createTracker(store, ctx.sessions))
  const recover = createRecovery(ctx, config, store, {
    processStart: performance.timeOrigin,
    now: () => Date.now(),
  })
  ctx.effect(() => {
    const controller = new AbortController()
    let timer
    const stopReady = ctx.appReady.onReady(() => {
      timer = setTimeout(() => {
        timer = undefined
        void recover(controller.signal).catch((error) => {
          ctx.logger.warn(`auto-restart: recovery stopped: ${describe(error)}`)
        })
      }, config.startDelaySeconds * 1000)
    })
    return async () => {
      controller.abort()
      stopReady()
      if (timer !== undefined) clearTimeout(timer)
      await store.flush()
    }
  }, 'auto-restart lifecycle')
}
