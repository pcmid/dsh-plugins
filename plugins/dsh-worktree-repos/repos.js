/**
 * Repository scanning and the Host operations, free of Harness imports so they
 * run under plain Node in tests.
 *
 * @module @pcmid/dsh-worktree-repos/repos
 */
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** An expected failure the client shows in its own words; anything else is answered as `internal`. */
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
 * The checked-out branch of a repository, read from its `HEAD` file without
 * running Git. A `.git` file (a worktree or submodule checkout) is followed to
 * its Git directory.
 * @param {string} repository - repository directory.
 * @returns {Promise<string | null>} the branch, the short commit of a detached HEAD, or null when unreadable.
 */
export async function currentBranch(repository) {
  try {
    let gitDir = join(repository, '.git')
    if ((await stat(gitDir)).isFile()) {
      const pointer = /^gitdir:\s*(.+?)\s*$/mu.exec(await readFile(gitDir, 'utf8'))
      if (pointer === null) return null
      gitDir = resolve(repository, pointer[1])
    }
    const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim()
    if (head.startsWith('ref: ')) return head.slice(5).replace(/^refs\/heads\//u, '')
    return /^[\da-f]{7,}$/iu.test(head) ? head.slice(0, 7) : null
  } catch {
    return null
  }
}

/**
 * List the Git repositories under a workspace, down to `depth` directory
 * levels: directories with a `.git` entry. Hidden directories are skipped, a
 * repository is not searched for repositories inside it, and a symbolic link
 * counts only when it points at a repository, so a link loop cannot recurse.
 * @param {string} workspace - absolute workspace directory.
 * @param {number} depth - levels searched; 1 searches the direct subdirectories.
 * @returns {Promise<{ name: string, path: string, branch: string | null }[]>} repositories by name;
 *   `name` is the path relative to the workspace and `path` is canonical.
 */
export async function scanRepositories(workspace, depth = 1) {
  const found = []
  async function walk(directory, prefix, level) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      // An unreadable workspace is the caller's failure; an unreadable subdirectory holds no listed repository.
      if (level === 1) throw error
      return
    }
    await Promise.all(entries.map(async (entry) => {
      const link = entry.isSymbolicLink()
      if (entry.name.startsWith('.') || !(entry.isDirectory() || link)) return
      const path = join(directory, entry.name)
      if (!(await isDirectory(path))) return
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (await exists(join(path, '.git'))) {
        found.push({ name, path: await realpath(path), branch: await currentBranch(path) })
      } else if (!link && level < depth) {
        await walk(path, name, level + 1)
      }
    }))
  }
  await walk(workspace, '', 1)
  found.sort((a, b) => a.name.localeCompare(b.name))
  const seen = new Set()
  return found.filter(repository => !seen.has(repository.path) && seen.add(repository.path))
}

/**
 * Build the Host operations over the live services.
 * @param {object} deps - lookups bound to the live Host services.
 * @param {() => number} deps.depth - current scan depth.
 * @param {(sessionId: string) => any} deps.agentOf - live Agent of a Session, if loaded.
 * @param {(session: any) => boolean} deps.started - whether the Session has started a turn.
 * @param {(session: any) => string} deps.cwdOf - the Session's current working directory.
 * @param {(agent: any, path: string, signal: AbortSignal) => Promise<boolean>} deps.changeDirectory - move the Session into a
 *   directory; resolves whether an open worktree request was withdrawn on the way.
 * @returns {Record<string, (payload: object, signal: AbortSignal) => Promise<unknown>>} operations by route name.
 */
export function createOperations({ depth, agentOf, started, cwdOf, changeDirectory }) {
  /**
   * The picker state of a Session: null once it started, when its workspace is
   * itself inside a Git checkout, or when the workspace holds no repository.
   */
  async function stateOf(agent) {
    const workspace = agent.session.header?.cwd
    if (typeof workspace !== 'string' || started(agent.session) || await insideGitCheckout(workspace)) return null
    const repositories = await scanRepositories(workspace, depth())
    return repositories.length === 0 ? null : { workspace, current: cwdOf(agent.session), repositories }
  }

  function sessionAgent(payload) {
    if (typeof payload.sessionId !== 'string' || payload.sessionId === '') throw new HostError('bad-request', 'sessionId must be a non-empty string')
    return agentOf(payload.sessionId)
  }

  return {
    /** The repositories a new Session may move into, or null while the picker does not apply. */
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
      return { state: await stateOf(agent), withdrawn }
    },
  }
}
