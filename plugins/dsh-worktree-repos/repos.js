/**
 * Repository scanning and the three Host operations, free of Harness imports
 * so they run under plain Node in tests.
 *
 * @module @pcmid/dsh-worktree-repos/repos
 */
import { readdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

/** An expected failure the client shows as is; anything else is answered as `internal`. */
export class HostError extends Error {
  /**
   * @param {string} code - stable failure code.
   * @param {string} message - reader-facing reason.
   */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * Compare directories as the Workspace registry stores them: trailing
 * separators are ignored, everything else must match exactly.
 * @param {string} path - absolute directory.
 * @returns {string} the directory without trailing separators (a root stays a root).
 */
export function normalizePath(path) {
  const trimmed = path.replace(/[\\/]+$/u, '')
  return trimmed === '' || /^[A-Za-z]:$/u.test(trimmed) ? path : trimmed
}

/**
 * Whether scanning is on for a workspace directory.
 * @param {unknown} workspaces - the `workspaces` Config value.
 * @param {string} path - workspace directory.
 * @returns {boolean} whether the list names the directory.
 */
export function listed(workspaces, path) {
  if (!Array.isArray(workspaces)) return false
  const wanted = normalizePath(path)
  return workspaces.some(entry => typeof entry === 'string' && normalizePath(entry) === wanted)
}

/** Whether a path exists; an unreadable path counts as absent. */
async function exists(path) {
  return stat(path).then(() => true, () => false)
}

/** Whether a path is a directory, following a symbolic link. */
async function isDirectory(path) {
  return stat(path).then(info => info.isDirectory(), () => false)
}

/**
 * Whether a directory lies inside a Git checkout: it or one of its parents has
 * a `.git` entry, as Git's own discovery finds it.
 * @param {string} directory - absolute directory.
 * @returns {Promise<boolean>} whether a `.git` entry was found.
 */
export async function insideGitCheckout(directory) {
  for (let current = directory; ; current = dirname(current)) {
    if (await exists(join(current, '.git'))) return true
    if (dirname(current) === current) return false
  }
}

/**
 * List the Git repositories directly under a workspace: first-level
 * subdirectories, other than hidden ones, that have a `.git` entry.
 * @param {string} workspace - absolute workspace directory.
 * @returns {Promise<{ name: string, path: string }[]>} repositories by name; `path` is canonical.
 */
export async function scanRepositories(workspace) {
  const entries = await readdir(workspace, { withFileTypes: true })
  const found = await Promise.all(entries.map(async (entry) => {
    if (entry.name.startsWith('.') || !(entry.isDirectory() || entry.isSymbolicLink())) return undefined
    const path = join(workspace, entry.name)
    if (!(await isDirectory(path)) || !(await exists(join(path, '.git')))) return undefined
    return { name: entry.name, path: await realpath(path) }
  }))
  return found.filter(repository => repository !== undefined).sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Build the Host operations over the live services.
 * @param {object} deps - lookups bound to the live Host services.
 * @param {() => unknown} deps.workspaces - current `workspaces` Config value.
 * @param {(sessionId: string) => any} deps.agentOf - live Agent of a Session, if loaded.
 * @param {(session: any) => boolean} deps.started - whether the Session has started a turn.
 * @param {(session: any) => string} deps.cwdOf - the Session's current working directory.
 * @param {(agent: any, path: string, signal: AbortSignal) => Promise<boolean>} deps.changeDirectory - move the Session into a
 *   directory; resolves whether an open worktree request was withdrawn on the way.
 * @returns {Record<string, (payload: object, signal: AbortSignal) => Promise<unknown>>} operations by route name.
 */
export function createOperations({ workspaces, agentOf, started, cwdOf, changeDirectory }) {
  /**
   * The picker state of a Session, or null while the picker does not apply. A
   * Session already moved into a repository keeps its picker after scanning is
   * turned off, so it can still move back.
   */
  async function stateOf(agent) {
    const workspace = agent.session.header?.cwd
    if (typeof workspace !== 'string' || started(agent.session)) return null
    const current = cwdOf(agent.session)
    const scanning = listed(workspaces(), workspace)
    if (!scanning && normalizePath(current) === normalizePath(workspace)) return null
    if (await insideGitCheckout(workspace)) return null
    const repositories = await scanRepositories(workspace)
    if (!scanning && !repositories.some(repository => normalizePath(repository.path) === normalizePath(current))) return null
    return { workspace, current, repositories }
  }

  function sessionAgent(payload) {
    if (typeof payload.sessionId !== 'string' || payload.sessionId === '') throw new HostError('bad-request', 'sessionId must be a non-empty string')
    return agentOf(payload.sessionId)
  }

  return {
    /** Whether a workspace directory is inside a Git checkout; the workspace menu offers scanning only outside one. */
    async probe(payload) {
      if (typeof payload.path !== 'string' || !isAbsolute(payload.path)) throw new HostError('bad-request', 'path must be an absolute directory')
      return { git: await insideGitCheckout(payload.path) }
    },

    /** The repositories a new Session may move into, or null when scanning is off, the workspace is a checkout, or the Session started. */
    async repositories(payload) {
      const agent = sessionAgent(payload)
      return agent === undefined ? null : await stateOf(agent)
    },

    /**
     * Move a new Session into one of its workspace's repositories, or back to the workspace for a null path.
     * `withdrawn` tells whether an open worktree request was withdrawn, since its base branch belonged to the previous directory.
     */
    async choose(payload, signal) {
      if (payload.path !== null && typeof payload.path !== 'string') throw new HostError('bad-request', 'path must be a string or null')
      const agent = sessionAgent(payload)
      const state = agent === undefined ? null : await stateOf(agent)
      if (state === null) throw new HostError('unavailable', 'This session can no longer change its repository.')
      const target = payload.path === null ? state.workspace : state.repositories.find(repository => repository.path === payload.path)?.path
      if (target === undefined) throw new HostError('not-found', 'The repository is no longer in this workspace.')
      const withdrawn = normalizePath(target) !== normalizePath(state.current) && await changeDirectory(agent, target, signal)
      const next = await stateOf(agent)
      return { state: next, withdrawn }
    },
  }
}
