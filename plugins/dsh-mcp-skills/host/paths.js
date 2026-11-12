/**
 * Skill roots, path display, the direct-child write rule, and filesystem helpers shared by the routes.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { HostError, errorMessage } from './errors.js'

/** Root ids, highest precedence first. */
export const ROOT_IDS = ['project-dsh', 'project-agents', 'user-dsh', 'user-agents']

/**
 * Expand `~`, `~/…`, and `~\…` against the OS home.
 * @param {string} value - path text.
 * @returns {string} the expanded path.
 */
export function expandHome(value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2))
  return value
}

/** Resolve a home root the way `@deepseek-ai/dsh-home-paths` does; read at call time. */
function resolveHome(envName, dirName) {
  const fromEnv = process.env[envName]
  const selected = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : path.join(os.homedir(), dirName)
  return path.resolve(expandHome(selected))
}

/** @returns {string} `$DSH_HOME`, or `~/.dsh`. */
export function dshHome() {
  return resolveHome('DSH_HOME', '.dsh')
}

/** @returns {string} `$DSH_AGENTS_HOME`, or `~/.agents`. */
export function agentsHome() {
  return resolveHome('DSH_AGENTS_HOME', '.agents')
}

/**
 * @param {string} value - absolute path.
 * @returns {string} the path with the OS home replaced by `~`.
 */
export function displayPath(value) {
  const home = os.homedir()
  if (value === home) return '~'
  if (value.startsWith(home + path.sep)) return `~${value.slice(home.length)}`
  return value
}

/**
 * Validate an optional workspace path.
 * @param {unknown} cwd - payload `cwd`.
 * @returns {Promise<string | undefined>} the normalized absolute directory, or `undefined` when absent.
 * @throws {HostError} `bad-request` unless `cwd` is absent or an absolute path of an existing directory.
 */
export async function resolveCwd(cwd) {
  if (cwd === undefined || cwd === null) return undefined
  if (typeof cwd !== 'string' || cwd === '') throw new HostError('bad-request', 'Field "cwd" must be a non-empty path')
  if (!path.isAbsolute(cwd)) throw new HostError('bad-request', `Workspace path ${cwd} must be absolute`)
  const resolved = path.resolve(cwd)
  let info
  try {
    info = await fs.stat(resolved)
  } catch (error) {
    throw new HostError('bad-request', `Workspace folder ${displayPath(resolved)} is not accessible: ${errorMessage(error)}`)
  }
  if (!info.isDirectory()) throw new HostError('bad-request', `Workspace path ${displayPath(resolved)} is not a folder`)
  return resolved
}

/**
 * @param {string} cwd - absolute workspace directory.
 * @returns {Promise<string>} the nearest ancestor (or `cwd` itself) containing `.git`, else `cwd`.
 */
export async function findProjectRoot(cwd) {
  let current = cwd
  for (;;) {
    if (await exists(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

/**
 * Compute the four skill roots for a workspace (project roots only when `cwd` is given).
 * @param {string | undefined} cwd - validated workspace directory.
 * @returns {Promise<{ projectRoot?: string, roots: { id: string, scope: 'project' | 'user', path: string,
 *   rank: number }[] }>} roots in precedence order.
 */
export async function skillRoots(cwd) {
  const roots = []
  let projectRoot
  if (cwd !== undefined) {
    projectRoot = await findProjectRoot(cwd)
    roots.push(
      { id: 'project-dsh', scope: 'project', path: path.join(projectRoot, '.dsh', 'skills'), rank: 100 },
      { id: 'project-agents', scope: 'project', path: path.join(projectRoot, '.agents', 'skills'), rank: 200 },
    )
  }
  roots.push(
    { id: 'user-dsh', scope: 'user', path: path.join(dshHome(), 'skills'), rank: 400 },
    { id: 'user-agents', scope: 'user', path: path.join(agentsHome(), 'skills'), rank: 500 },
  )
  return projectRoot === undefined ? { roots } : { projectRoot, roots }
}

/**
 * Select a root by id.
 * @param {{ roots: { id: string }[] }} layout - result of {@link skillRoots}.
 * @param {unknown} id - payload root id.
 * @returns {object} the root.
 * @throws {HostError} `bad-request` for an unknown id, or a project root without a workspace.
 */
export function rootById(layout, id) {
  if (!ROOT_IDS.includes(id)) {
    throw new HostError('bad-request', `Field "root" must be one of ${ROOT_IDS.join(', ')}`)
  }
  const root = layout.roots.find(candidate => candidate.id === id)
  if (root === undefined) throw new HostError('bad-request', `Root "${id}" needs a workspace; pass "cwd"`)
  return root
}

/**
 * Enforce the write rule: `target` must be a direct child of one of `roots`, comparing real paths of the
 * parent directory and the root.
 * @param {string} target - absolute entry path (`<root>/<entry>`).
 * @param {{ path: string }[]} roots - allowed roots.
 * @returns {Promise<object>} the matching root.
 * @throws {HostError} `forbidden` when no root matches.
 */
export async function assertDirectChild(target, roots) {
  const entry = path.basename(target)
  if (entry === '' || entry === '.' || entry === '..') {
    throw new HostError('forbidden', `${displayPath(target)} is not a skill entry`)
  }
  let parent
  try {
    parent = await fs.realpath(path.dirname(target))
  } catch {
    // An unresolvable parent cannot be proven to be a root.
    parent = undefined
  }
  if (parent !== undefined) {
    for (const root of roots) {
      let real
      try {
        real = await fs.realpath(root.path)
      } catch {
        // A missing root matches nothing.
        continue
      }
      if (real === parent) return root
    }
  }
  throw new HostError('forbidden', `${displayPath(target)} is not directly inside a skill folder (${roots.map(root => displayPath(root.path)).join(', ')})`)
}

/**
 * @param {string} target - path to probe without following a final symlink.
 * @returns {Promise<boolean>} whether anything exists there.
 */
export async function exists(target) {
  try {
    await fs.lstat(target)
    return true
  } catch {
    // Absence and inaccessibility both read as "nothing to reuse here".
    return false
  }
}

/**
 * @param {string} target - path to resolve.
 * @returns {Promise<string>} its real path, or the path itself when it cannot be resolved.
 */
export async function realpathOr(target) {
  try {
    return await fs.realpath(target)
  } catch {
    // A vanished path is compared by its spelling.
    return target
  }
}

/**
 * Identify a root entry independently of how its root is spelled: the real path of the parent joined with
 * the entry's own name. Unlike a full realpath, a symlinked skill folder keeps its own identity instead of
 * taking its target's, and the identity survives deleting the entry.
 * @param {string} target - absolute entry path (`<root>/<entry>`).
 * @returns {Promise<string>} the entry identity.
 */
export async function entryKey(target) {
  return path.join(await realpathOr(path.dirname(target)), path.basename(target))
}

/**
 * @param {string} target - directory path.
 * @returns {Promise<boolean>} whether the current process may create entries in it.
 */
export async function isWritable(target) {
  try {
    await fs.access(target, fs.constants.W_OK)
    return true
  } catch {
    // Permission errors are the answer here, not a failure.
    return false
  }
}

/**
 * Write a file atomically: a temporary file in the same directory, then rename. An existing file's mode
 * is kept.
 * @param {string} target - destination path (not a symlink; callers resolve links first).
 * @param {string} text - UTF-8 content.
 */
export async function writeAtomic(target, text) {
  let mode = 0o644
  try {
    mode = (await fs.stat(target)).mode & 0o777
  } catch {
    // A new file uses the default mode.
  }
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
  try {
    await fs.writeFile(temp, text, { encoding: 'utf8', flag: 'wx', mode })
    await fs.rename(temp, target)
  } catch (error) {
    await fs.rm(temp, { force: true })
    throw error
  }
}

/**
 * Remove a skill entry. A symlink (to a file or a directory) loses only the link; a real directory is
 * removed recursively; a file is unlinked.
 * @param {string} target - entry path.
 */
export async function removeEntry(target) {
  const info = await fs.lstat(target)
  if (info.isDirectory()) await fs.rm(target, { recursive: true })
  else await fs.unlink(target)
}

/**
 * List files under a directory without following symlinks (a symlink counts as one file).
 * @param {string} dir - directory to walk.
 * @param {{ maxDepth: number, keep: number, countLimit: number, skip: Set<string>, excludeTop?: string }} options -
 *   files at most `maxDepth` path segments deep are counted; names in `skip` are ignored at every depth;
 *   `excludeTop` is ignored at the top level only.
 * @returns {Promise<{ files: string[], total: number }>} the first `keep` relative paths (`/`-separated, in
 *   sorted depth-first order) and the count, which stops at `countLimit`.
 */
export async function listFiles(dir, { maxDepth, keep, countLimit, skip, excludeTop }) {
  const files = []
  let total = 0
  const walk = async (current, prefix, depth) => {
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      // Unreadable subdirectories are left out of the listing.
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (total >= countLimit) return
      if (skip.has(entry.name) || (depth === 1 && entry.name === excludeTop)) continue
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (depth < maxDepth) await walk(path.join(current, entry.name), relative, depth + 1)
        continue
      }
      total++
      if (files.length < keep) files.push(relative)
    }
  }
  await walk(dir, '', 1)
  return { files, total }
}

/** Runs async tasks one at a time, in submission order. */
export class SerialQueue {
  #tail = Promise.resolve()

  /**
   * @template T
   * @param {() => Promise<T>} task - work that must not overlap other queued work.
   * @returns {Promise<T>} the task's result.
   */
  run(task) {
    const result = this.#tail.then(task)
    // The caller observes the failure through `result`; the queue only needs to keep going.
    this.#tail = result.catch(() => {})
    return result
  }
}
