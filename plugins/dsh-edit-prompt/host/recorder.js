/**
 * Per-conversation turn recorder.
 *
 * At every top-level `turn/start` it takes a git snapshot of the working
 * tree's repository; before every file-tool mutation it copies the target
 * file once per turn; at `turn/end` it takes a second snapshot and writes one
 * durable turn record holding, for every path the turn changed, the content
 * before the turn (stored) and a hash of the content after it. Paths the
 * snapshots cover use the snapshot; ignored files, files in nested
 * repositories, files outside the repository, and every path when there is no
 * repository use the copy taken before the first file-tool mutation.
 *
 * All work of one conversation is serialized, and tools wait for it, so a
 * snapshot or copy never races the mutation it describes.
 */

import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { blobSizes, checkoutPaths, diffTrees, ignoredPaths, locateRepository, snapshotTree } from './git.js'
import { canonicalPath, isInside, toPosix } from './paths.js'
import { currentSide, sameSide, turnKey } from './store.js'

const ABSENT_MODE = '000000'
const GITLINK_MODE = '160000'
const SYMLINK_MODE = '120000'

/**
 * @typedef {object} RecorderEnvironment
 * @property {() => Promise<import('./git.js').GitRunner | null>} git - the runner, or null without git.
 * @property {import('./store.js').Store} store - durable storage.
 * @property {number} maxFileBytes - largest file content stored.
 * @property {readonly string[]} privateDirs - canonical directories never snapshotted.
 * @property {Promise<readonly string[]>} temporaryRoots - scratch directories recorded only inside the workspace.
 * @property {(session: object) => string | undefined} cwdOf - the conversation's current working directory.
 * @property {(session: object) => Promise<number>} originTime - time of the conversation's event 0.
 * @property {(message: string) => void} warn - failure reporter; a failed step loses only its own turn.
 */

export class TurnRecorder {
  /**
   * @param {object} session - the recorded top-level Session.
   * @param {RecorderEnvironment} env - shared facts.
   */
  constructor(session, env) {
    this.session = session
    this.env = env
    this.chain = Promise.resolve()
    /** The open turn; a closed placeholder before the first `turn/start`. */
    this.state = { closed: true }
    /** @type {Map<string, object>} located repositories by canonical working directory */
    this.repositories = new Map()
    /** @type {Promise<string> | undefined} */
    this.scratch = undefined
    this.lifetime = new AbortController()
  }

  /**
   * Open a turn and queue its baseline snapshot.
   * @param {{ seq: number, time: number, data: { turn: number } }} event - the `turn/start` event.
   */
  start(event) {
    const state = { turn: event.data.turn, seq: event.seq, time: event.time, key: undefined, baseline: null, cwd: undefined, captures: new Map(), tools: false, closed: false }
    this.state = state
    void this.enqueue(async (signal) => {
      state.key = turnKey(await this.env.originTime(this.session), state.seq, state.time)
      const cwd = this.env.cwdOf(this.session)
      if (cwd === undefined) return
      state.cwd = await canonicalPath(cwd)
      const repository = await this.locate(state.cwd, signal)
      if (repository === null) return
      state.baseline = { repository, tree: await snapshotTree(repository.git, repository, signal) }
    })
  }

  /**
   * Queue a copy of a path a file tool is about to mutate; only the turn's
   * first mutation of a path copies it. Await {@link settled} afterwards.
   * @param {string} path - absolute path of the mutation target.
   */
  capture(path) {
    const state = this.state
    if (state.closed) return
    void this.enqueue(async () => {
      const absolute = await canonicalPath(path)
      if (state.captures.has(absolute)) return
      state.captures.set(absolute, await this.env.store.capture(absolute, this.env.maxFileBytes))
    })
  }

  /**
   * Note a settled tool result of the open turn; a turn without one changed nothing.
   * @param {{ data: { turn: number } }} event - the `tool/result` event.
   */
  observe(event) {
    if (!this.state.closed && event.data.turn === this.state.turn) this.state.tools = true
  }

  /**
   * Close the open turn and queue its record.
   * @param {number} turn - the turn number from `turn/end`.
   */
  end(turn) {
    const state = this.state
    if (state.closed || turn !== state.turn) return
    state.closed = true
    void this.enqueue(signal => this.record(state, signal))
  }

  /** @returns {Promise<void>} once every queued snapshot, copy, and record has settled. */
  settled() {
    return this.chain
  }

  /**
   * Finish queued work, then remove the snapshot directory.
   * @param {boolean} abort - abandon queued work instead (plugin disposal).
   */
  async dispose(abort) {
    if (abort) this.lifetime.abort()
    await this.chain
    if (this.scratch !== undefined) await rm(await this.scratch, { recursive: true, force: true }).catch(() => {})
  }

  enqueue(task) {
    const run = this.chain.then(async () => {
      if (this.lifetime.signal.aborted) return
      try {
        await task(this.lifetime.signal)
      } catch (error) {
        if (!this.lifetime.signal.aborted) this.env.warn(`edit-prompt: recording ${this.session.id}: ${error?.message ?? String(error)}`)
      }
    })
    this.chain = run
    return run
  }

  /** The repository enclosing a working directory, located once; absence is retried every turn. */
  async locate(cwd, signal) {
    const known = this.repositories.get(cwd)
    if (known !== undefined) return known
    const git = await this.env.git()
    if (git === null) return null
    this.scratch ??= mkdtemp(join(tmpdir(), 'dsh-edit-prompt-')).then(canonicalPath)
    const located = await locateRepository(git, cwd, await this.scratch, this.env.privateDirs, signal)
    if (located === null) return null
    const repository = { ...located, git }
    this.repositories.set(cwd, repository)
    return repository
  }

  async record(state, signal) {
    if (state.key === undefined || (!state.tools && state.captures.size === 0)) return
    /** @type {Map<string, { before: object, after: object }>} */
    const files = new Map()
    let baseline = state.baseline
    if (baseline !== null) {
      try {
        await this.snapshotChanges(baseline, files, signal)
      } catch (error) {
        // The copies taken around file-tool edits still describe their paths.
        this.env.warn(`edit-prompt: turn ${state.turn} of ${this.session.id}: shell changes not recorded: ${error?.message ?? String(error)}`)
        files.clear()
        baseline = null
      }
    }
    for (const absolute of await this.uncovered(state, baseline, files, signal)) {
      const before = state.captures.get(absolute)
      const after = await currentSide(absolute)
      if (!sameSide(before, after)) files.set(absolute, { before, after })
    }
    if (files.size === 0) return
    await this.env.store.writeTurn(state.key, {
      sessionId: this.session.id,
      turn: state.turn,
      seq: state.seq,
      time: state.time,
      files: [...files].map(([path, sides]) => ({ path, ...sides })),
    })
  }

  /** List every path the two snapshots of a turn disagree on, with its content before the turn. */
  async snapshotChanges(baseline, files, signal) {
    const { store, maxFileBytes } = this.env
    const { repository, tree } = baseline
    const { git, root } = repository
    const after = await snapshotTree(git, repository, signal)
    const entries = (await diffTrees(git, repository, tree, after, signal))
      .filter(entry => entry.srcMode !== GITLINK_MODE && entry.dstMode !== GITLINK_MODE)
    const present = entries.filter(entry => entry.srcMode !== ABSENT_MODE)
    const sizes = await blobSizes(git, repository, present.filter(entry => entry.srcMode !== SYMLINK_MODE).map(entry => entry.srcOid), signal)
    const wanted = new Set(present.filter(entry => entry.srcMode === SYMLINK_MODE || (sizes.get(entry.srcOid) ?? Infinity) <= maxFileBytes))
    const out = await mkdtemp(join(repository.scratch, 'checkout-'))
    try {
      await checkoutPaths(git, repository, tree, [...wanted].map(entry => entry.path), out, signal)
      for (const entry of entries) {
        const absolute = join(root, ...entry.path.split('/'))
        let before
        if (entry.srcMode === ABSENT_MODE) before = { kind: 'absent' }
        else if (!wanted.has(entry)) before = { kind: 'unavailable', reason: 'oversized' }
        else {
          before = await store.capture(join(out, ...entry.path.split('/')), maxFileBytes)
          // A path git could not check out on this filesystem is not known to have been absent.
          if (before.kind === 'absent') before = { kind: 'unavailable', reason: 'unsupported' }
        }
        files.set(absolute, { before, after: await currentSide(absolute) })
      }
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  }

  /** Copied paths the snapshots do not describe. Scratch files are kept out unless they lie in the workspace. */
  async uncovered(state, baseline, listed, signal) {
    const temporary = await this.env.temporaryRoots
    const workspace = baseline?.repository.root ?? state.cwd
    const outside = absolute => workspace === undefined || !isInside(workspace, absolute)
    const candidates = [...state.captures.keys()]
      .filter(absolute => !listed.has(absolute))
      .filter(absolute => !outside(absolute) || !temporary.some(root => isInside(root, absolute)))
    if (baseline === null) return candidates
    const { repository } = baseline
    const result = []
    const inRepository = []
    for (const absolute of candidates) {
      if (outside(absolute) || await insideNestedRepository(repository.root, absolute)) result.push(absolute)
      else inRepository.push(absolute)
    }
    const relativeOf = absolute => toPosix(relative(repository.root, absolute))
    const ignored = await ignoredPaths(repository.git, repository, inRepository.map(relativeOf), signal)
    return [...result, ...inRepository.filter(absolute => ignored.has(relativeOf(absolute)))]
  }
}

/**
 * Whether a path lies in a repository nested inside `root`, whose contents a snapshot records only as a gitlink.
 * @param {string} root - repository root.
 * @param {string} absolute - path inside `root`.
 * @returns {Promise<boolean>} true when a directory between them holds `.git`.
 */
async function insideNestedRepository(root, absolute) {
  for (let dir = dirname(absolute); dir !== root && isInside(root, dir); dir = dirname(dir)) {
    try {
      await access(join(dir, '.git'))
      return true
    } catch {
      // No `.git` here: keep walking up.
    }
  }
  return false
}
