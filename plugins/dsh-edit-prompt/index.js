/**
 * Host half of @pcmid/dsh-edit-prompt.
 *
 * The edit button, the editor, and the conversation restart run in the Web
 * client (`client.js`): it forks at the event just before the edited
 * message's turn, clears the input the fork inherited as pending, prompts the
 * edited text, opens the fork, and optionally archives the original
 * conversation. Session logs are append-only, so "dropping" the later
 * messages means continuing in the fork.
 *
 * This half rewinds the files those dropped turns changed:
 *
 * - A recorder per top-level conversation records every turn that changed
 *   files (`host/recorder.js`): git snapshots of the working tree's repository
 *   at turn start and turn end catch every change in it, shell commands
 *   included; a copy taken before each file-tool mutation covers ignored files,
 *   files outside the repository, and conversations without one. Subagent
 *   edits count toward their root conversation. Records, stored copies, and
 *   restore journals live in `<DSH_HOME>/edit-prompt/` (`host/store.js`).
 * - `POST /api/pcmid/edit-prompt/rewind` stops the conversation and its
 *   subagents, waits for its last turn record, and restores every recorded
 *   path to its state before the edited turn (`host/rewind.js`).
 * - `POST /api/pcmid/edit-prompt/undo` puts back what one rewind overwrote,
 *   for a restart that failed after its files were rewound.
 *
 * @module @pcmid/dsh-edit-prompt
 */

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import z from '@deepseek-ai/schemastery'
import { GitRunner } from './host/git.js'
import { canonicalPath, temporaryRoots } from './host/paths.js'
import { TurnRecorder } from './host/recorder.js'
import { planRewind, rewindFiles, undoRewind } from './host/rewind.js'
import { Store } from './host/store.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'edit-prompt'

/** Route registration, cold Session reads, and the live Agent registry. */
export const inject = ['connection', 'sessionQuery', 'agents']

/** Route prefix of the rewind API. */
const API = '/api/pcmid/edit-prompt'
/** Bytes of git output kept per command; a larger listing loses that turn's shell changes. */
const GIT_OUTPUT_MAX_BYTES = 64 * 1024 * 1024
/** Milliseconds a stopped conversation and its subagents get to settle before a rewind gives up. */
const STOP_TIMEOUT_MS = 30_000
const STOP_POLL_MS = 50
/** Delay before the first pruning pass, so startup work goes first. */
const PRUNE_DELAY_MS = 60_000
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

export const Config = z.object({
  archiveSource: z.boolean().default(true).volatile()
    .description('On a DSH without in-place revert, where resending forks the conversation: archive the original after an edited prompt is resent, so the conversation appears to restart in place. When off, the original stays in the list next to the new conversation. A DSH with revert keeps the conversation and always archives the dropped history.'),
  maxFileBytes: z.natural().min(1).default(16 * 1024 * 1024)
    .description('Largest file, in bytes, whose earlier content is kept. A larger file changed by a dropped turn cannot be rewound.'),
  retentionDays: z.natural().min(1).default(30)
    .description('Days the record of a turn is kept. Editing a message older than this does not rewind the files its turns changed.'),
  gitTimeoutMs: z.natural().min(1000).default(60_000)
    .description('Milliseconds one git command may run while a turn is recorded. A slower snapshot loses that turn\'s shell changes.'),
})

/** An expected failure answered as `{ ok: false, error: { code, message } }`. */
class HostError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * Storage directory of the rewind.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {string} `<DSH_HOME>/edit-prompt`.
 */
export function storageDir(ctx) {
  const home = ctx.get('profileContext')?.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'edit-prompt')
}

/**
 * Resolve git once. On macOS `/usr/bin/git` is an installer stub until developer tools are selected.
 * @returns {Promise<GitRunner | null>} the runner, or null when git is unavailable.
 */
async function resolveGit(ctx, config, signal) {
  let executable = 'git'
  const subprocess = ctx.get('subprocess')
  if (subprocess !== undefined) {
    try {
      executable = await subprocess.resolveExecutable('git', undefined, signal)
    } catch {
      // No git on the Host: only file-tool edits are recorded.
      return null
    }
  }
  if (process.platform === 'darwin' && executable === '/usr/bin/git') {
    try {
      await promisify(execFile)('/usr/bin/xcode-select', ['-p'], { timeout: 5_000 })
    } catch {
      // The stub would open an installer dialog instead of running.
      return null
    }
  }
  return new GitRunner(executable, { timeoutMs: config.gitTimeoutMs, outputMaxBytes: GIT_OUTPUT_MAX_BYTES })
}

/** Whether a Session is a top-level conversation; subagent edits are recorded in their root's turn. */
function topLevel(session) {
  return session.header.origin !== 'subagent' && (session.header.delegationDepth ?? 0) === 0
}

export function apply(ctx, config) {
  const store = new Store(storageDir(ctx))
  const lifetime = new AbortController()
  const warn = message => ctx.logger?.warn?.(message)
  let git
  /** @type {Map<string, TurnRecorder>} recorders by Session id */
  const recorders = new Map()
  /** Tool executions whose file mutations a recorder copies, keyed by the execution object the `fs/*` events carry. */
  const executions = new WeakMap()
  const env = {
    git: () => (git ??= resolveGit(ctx, config, lifetime.signal).then((runner) => {
      if (runner === null) ctx.logger?.info?.('edit-prompt: git is unavailable; only file-tool edits are rewound')
      return runner
    })),
    store,
    maxFileBytes: config.maxFileBytes,
    privateDirs: [store.dir],
    temporaryRoots: temporaryRoots(),
    cwdOf: session => ctx.get('workingDirectory')?.get(session) ?? session.header.cwd,
    originTime: async (session) => {
      const time = typeof session.eventAt === 'function' ? session.eventAt(0)?.time : undefined
      if (typeof time === 'number') return time
      const events = await ctx.sessionQuery.listEvents(session.id)
      return events.find(event => event.seq === 0).time
    },
    warn,
  }
  // Snapshots must not take in the plugin's own storage, under whatever spelling git reports it.
  void canonicalPath(store.dir).then((dir) => { env.privateDirs = [dir] })

  ctx.effect(() => () => {
    lifetime.abort()
    for (const recorder of recorders.values()) void recorder.dispose(true)
    recorders.clear()
  }, 'edit-prompt: turn recorders')

  /** The recorder of the conversation an Agent belongs to; a subagent belongs to its root. */
  const recorderOf = (agent) => {
    if (agent === undefined) return undefined
    let root = agent
    try {
      root = ctx.get('subagents')?.rootOf(agent) ?? agent
    } catch {
      // An Agent the subagent registry does not know is its own root.
    }
    return recorders.get(root.session.id)
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      if (!topLevel(session) || session.header.cwd === undefined) return
      let recorder = recorders.get(session.id)
      if (recorder === undefined) recorders.set(session.id, recorder = new TurnRecorder(session, env))
      recorder.start(event)
    } else if (event.type === 'tool/result') {
      recorders.get(session.id)?.observe(event)
    } else if (event.type === 'turn/end') {
      recorders.get(session.id)?.end(event.data.turn)
    }
  })
  ctx.on('session/disposed', (session) => {
    const recorder = recorders.get(session.id)
    if (recorder === undefined) return
    recorders.delete(session.id)
    // The last turn record is still written; only the snapshot directory goes.
    void recorder.dispose(false)
  })

  // No tool runs before the queued snapshot or copy that must precede it.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const recorder = recorderOf(exec.agent)
    if (recorder !== undefined) {
      executions.set(exec, recorder)
      await recorder.settled()
    }
    return next()
  })
  const captureBeforeMutation = async (target, actor, next) => {
    const intent = await next()
    const recorder = actor === undefined ? undefined : executions.get(actor)
    const fs = ctx.get('fs')
    if (recorder !== undefined && fs !== undefined) {
      recorder.capture(fs.processPath(target))
      await recorder.settled()
    }
    return intent
  }
  ctx.on('fs/write-intent', captureBeforeMutation, { prepend: true })
  ctx.on('fs/edit-intent', captureBeforeMutation, { prepend: true })
  ctx.on('fs/delete-intent', captureBeforeMutation, { prepend: true })

  /** Cancel the conversation's turn and every running subagent under it, then wait until all are idle. */
  async function stopConversation(sessionId) {
    const involved = () => ctx.agents.list().filter((agent) => {
      if (agent.session.id === sessionId) return true
      try {
        return ctx.get('subagents')?.rootOf(agent)?.session.id === sessionId
      } catch {
        // Not a registered subagent: not under this conversation.
        return false
      }
    })
    for (const agent of involved()) {
      if (agent.status === 'running') agent.cancel(agent.session.id === sessionId ? { kind: 'user' } : { kind: 'parent' })
    }
    const deadline = Date.now() + STOP_TIMEOUT_MS
    while (involved().some(agent => agent.status === 'running')) {
      if (Date.now() > deadline) throw new HostError('busy', 'The conversation is still running after it was asked to stop.')
      await new Promise(resolve => setTimeout(resolve, STOP_POLL_MS))
    }
    await recorders.get(sessionId)?.settled()
  }

  // One rewind at a time: two restores must not interleave on the same files.
  let exclusive = Promise.resolve()
  const serialized = task => (exclusive = exclusive.then(task, task))

  registerOperation(ctx, 'rewind', (payload) => {
    const { sessionId, fromSeq, force } = payload
    if (typeof sessionId !== 'string' || sessionId === '') throw new HostError('bad-request', 'sessionId must be a non-empty string')
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) throw new HostError('bad-request', 'fromSeq must be a non-negative integer')
    return serialized(async () => {
      await stopConversation(sessionId)
      const events = await ctx.sessionQuery.listEvents(sessionId)
      const plan = await planRewind(store, events, fromSeq)
      return rewindFiles(store, plan, { force: force === true, journal: { sessionId, fromSeq } })
    })
  })
  registerOperation(ctx, 'undo', (payload) => {
    if (typeof payload.restoreId !== 'string') throw new HostError('bad-request', 'restoreId must be a string')
    return serialized(() => undoRewind(store, payload.restoreId).catch((error) => {
      throw error?.code === 'not-found' ? new HostError('not-found', error.message) : error
    }))
  })

  ctx.effect(() => {
    const prune = () => {
      void store.prune(config.retentionDays).catch(error => warn(`edit-prompt: pruning ${store.dir}: ${error?.message ?? String(error)}`))
    }
    let interval
    const first = setTimeout(() => {
      prune()
      interval = setInterval(prune, PRUNE_INTERVAL_MS)
      interval.unref?.()
    }, PRUNE_DELAY_MS)
    first.unref?.()
    return () => {
      clearTimeout(first)
      clearInterval(interval)
    }
  }, 'edit-prompt: pruning')
}

/**
 * Register one exact POST route that speaks the Connection RPC envelope.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context owning the route.
 * @param {string} operation - operation name under {@link API}.
 * @param {(payload: object) => unknown} handle - operation body.
 */
function registerOperation(ctx, operation, handle) {
  ctx.connection.fetch.register({
    path: `${API}/${operation}`,
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
      let result
      try {
        const payload = envelope?.payload
        if (envelope?.type !== 'client-request' || typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          throw new HostError('bad-request', 'Expected a client-request envelope with an object payload')
        }
        result = { ok: true, value: await handle(payload) }
      } catch (error) {
        const code = error instanceof HostError ? error.code : 'internal'
        result = { ok: false, error: { code, message: error?.message ?? String(error), details: {} } }
      }
      return Response.json({ type: 'server-response', rpcId, result })
    },
  })
}
