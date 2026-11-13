/**
 * Git working-tree snapshots for the turn recorder.
 *
 * Snapshots never touch the user's repository: each one is written through a
 * private index seeded from the repository's index into a private object
 * directory, with the repository's own object store attached read-only as an
 * alternate. The same scheme as the shipped workspace-changes plugin.
 */

import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { isInside, toPosix } from './paths.js'

/** Milliseconds a git child gets to exit after termination starts. */
const TERMINATE_GRACE_MS = 2_000
/** Retained stderr tail for diagnostics. */
const STDERR_MAX_BYTES = 16 * 1024
/** Ambient variables git and its filters (LFS, global ignore rules) need; everything else stays out. */
const PASSED_ENV = ['PATH', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP']

/** Runs one git executable with a minimal environment, a timeout, and bounded output. */
export class GitRunner {
  /**
   * @param {string} executable - absolute git path.
   * @param {{ timeoutMs: number, outputMaxBytes: number }} limits - per-command bounds.
   */
  constructor(executable, limits) {
    this.executable = executable
    this.limits = limits
  }

  /**
   * Run `git <args>` to completion; a nonzero exit is a result, not an exception.
   * @param {readonly string[]} args - git arguments, never shell-interpreted.
   * @param {{ cwd: string, env?: Record<string, string>, stdin?: string, signal?: AbortSignal }} options - spawn facts.
   * @returns {Promise<{ code: number | null, stdout: Buffer, stderr: string, truncated: boolean }>} exit facts.
   * @throws when the command times out, is aborted, or cannot spawn.
   */
  run(args, options) {
    const env = { GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }
    for (const name of PASSED_ENV) if (process.env[name] !== undefined) env[name] = process.env[name]
    Object.assign(env, options.env)
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.executable, args, { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      const chunks = []
      let size = 0
      let truncated = false
      let stderr = ''
      let failure
      child.stdout.on('data', (chunk) => {
        if (truncated) return
        if (size + chunk.length > this.limits.outputMaxBytes) {
          truncated = true
          return
        }
        chunks.push(chunk)
        size += chunk.length
      })
      child.stderr.on('data', (chunk) => {
        if (stderr.length < STDERR_MAX_BYTES) stderr += chunk.toString('utf8')
      })
      const stop = (reason) => {
        failure ??= new Error(`git ${args[0]} ${reason}`)
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), TERMINATE_GRACE_MS).unref()
      }
      const timer = setTimeout(() => stop(`timed out after ${this.limits.timeoutMs}ms`), this.limits.timeoutMs)
      const onAbort = () => stop('was aborted')
      options.signal?.addEventListener('abort', onAbort, { once: true })
      let settled = false
      const settle = (error, code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        if (error !== undefined) reject(error)
        else resolvePromise({ code, stdout: Buffer.concat(chunks), stderr, truncated })
      }
      child.on('error', error => settle(failure ?? error))
      child.on('close', code => settle(failure, code))
      // A git that exits before reading its whole stdin closes the pipe; that is its own failure to report.
      child.stdin.on('error', () => {})
      child.stdin.end(options.stdin ?? '')
    })
  }
}

/**
 * Reject a failed command with its stderr.
 * @param {{ code: number | null, stderr: string, truncated: boolean }} result - settled command facts.
 * @param {string} what - command description.
 * @returns the same result.
 */
function ok(result, what) {
  if (result.code !== 0) throw new Error(`${what} failed: ${result.stderr.trim()}`)
  if (result.truncated) throw new Error(`${what} output exceeded the configured cap`)
  return result
}

/**
 * Locate the repository enclosing a working directory and route snapshot
 * objects to `scratch/objects`.
 * @param {GitRunner} git - command runner.
 * @param {string} cwd - canonical working directory.
 * @param {string} scratch - canonical private directory for snapshot objects and indexes.
 * @param {readonly string[]} privateDirs - directories a snapshot must never include (the plugin's own storage).
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<null | { root: string, gitDir: string, scratch: string, env: Record<string, string>, excludes: string[] }>}
 *   the repository, or null when the directory is not inside one.
 */
export async function locateRepository(git, cwd, scratch, privateDirs, signal) {
  const found = await git.run(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-path', 'objects'], { cwd, signal })
  if (found.code === 128 && /not a git repository/i.test(found.stderr)) return null
  const [root, gitDir, objects] = ok(found, 'git rev-parse').stdout.toString('utf8').split('\n').map(line => resolve(cwd, line))
  await mkdir(join(scratch, 'objects'), { recursive: true })
  const excludes = [scratch, ...privateDirs].filter(dir => isInside(root, dir) && dir !== root).map(dir => toPosix(relative(root, dir)))
  return {
    root,
    gitDir,
    scratch,
    env: { GIT_OBJECT_DIRECTORY: join(scratch, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: objects },
    excludes,
  }
}

/** Run one command with a private index under the repository's scratch directory, removed afterwards. */
async function withIndex(repository, task) {
  const dir = await mkdtemp(join(repository.scratch, 'index-'))
  try {
    return await task(join(dir, 'index'), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Write the complete work tree, untracked files included and ignored files
 * excluded, as a tree object.
 * @param {GitRunner} git - command runner.
 * @param {Awaited<ReturnType<typeof locateRepository>>} repository - located repository.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<string>} the tree id.
 */
export function snapshotTree(git, repository, signal) {
  return withIndex(repository, async (index) => {
    // A repository without an index yet (fresh `git init`) starts from an empty one.
    try {
      const source = join(repository.gitDir, 'index')
      const { mtimeMs } = await stat(source)
      await copyFile(source, index)
      // git trusts a cached stat only for files older than the index file; a fresh mtime on the copy
      // would make a file rewritten in the same second with the same size look unchanged.
      const time = new Date(mtimeMs - 1)
      await utimes(index, time, time)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const env = { ...repository.env, GIT_INDEX_FILE: index }
    const pathspec = repository.excludes.length === 0 ? [] : ['--', '.', ...repository.excludes.map(path => `:(exclude)${path}`)]
    // `--ignore-errors` skips unreadable files and reports them through exit code 1; the index is still complete.
    const added = await git.run(['add', '--all', '--ignore-errors', ...pathspec], { cwd: repository.root, env, signal })
    if (added.code !== 1) ok(added, `git add in ${repository.root}`)
    return ok(await git.run(['write-tree'], { cwd: repository.root, env, signal }), 'git write-tree').stdout.toString('utf8').trim()
  })
}

/**
 * Paths whose entry differs between two trees, renames split into a delete and an add.
 * @param {GitRunner} git - command runner.
 * @param {Awaited<ReturnType<typeof locateRepository>>} repository - located repository.
 * @param {string} before - turn-start tree.
 * @param {string} after - turn-end tree.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<Array<{ path: string, srcMode: string, dstMode: string, srcOid: string }>>}
 *   changed entries; `path` is slash-separated and relative to the repository root, a mode `000000` means absent.
 */
export async function diffTrees(git, repository, before, after, signal) {
  if (before === after) return []
  const result = ok(await git.run(['diff-tree', '-r', '-z', '--no-renames', '--raw', before, after], {
    cwd: repository.root, env: repository.env, signal,
  }), 'git diff-tree')
  const tokens = result.stdout.toString('utf8').split('\0')
  const entries = []
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) [0-9a-f]+ [A-Z]/.exec(tokens[index])
    if (match === null) throw new Error(`unexpected git diff-tree output: ${tokens[index]}`)
    entries.push({ path: tokens[index + 1], srcMode: match[1], dstMode: match[2], srcOid: match[3] })
  }
  return entries
}

/**
 * Byte sizes of blobs.
 * @param {GitRunner} git - command runner.
 * @param {Awaited<ReturnType<typeof locateRepository>>} repository - located repository.
 * @param {readonly string[]} oids - blob ids.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<Map<string, number>>} size by blob id.
 */
export async function blobSizes(git, repository, oids, signal) {
  const sizes = new Map()
  if (oids.length === 0) return sizes
  const result = ok(await git.run(['cat-file', '--batch-check'], {
    cwd: repository.root, env: repository.env, stdin: `${oids.join('\n')}\n`, signal,
  }), 'git cat-file')
  for (const line of result.stdout.toString('utf8').split('\n')) {
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(line)
    if (match !== null) sizes.set(match[1], Number(match[2]))
  }
  return sizes
}

/**
 * Check out paths of a tree, in their working-tree form (filters and line
 * endings applied as `git checkout` would), under a directory.
 * @param {GitRunner} git - command runner.
 * @param {Awaited<ReturnType<typeof locateRepository>>} repository - located repository.
 * @param {string} tree - tree id.
 * @param {readonly string[]} paths - slash-separated paths relative to the repository root.
 * @param {string} directory - destination; each path lands at `directory/<path>`.
 * @param {AbortSignal} signal - cancellation.
 */
export async function checkoutPaths(git, repository, tree, paths, directory, signal) {
  if (paths.length === 0) return
  await withIndex(repository, async (index) => {
    const env = { ...repository.env, GIT_INDEX_FILE: index }
    ok(await git.run(['read-tree', tree], { cwd: repository.root, env, signal }), 'git read-tree')
    ok(await git.run(['checkout-index', '-z', '--stdin', `--prefix=${directory}/`], {
      cwd: repository.root, env, stdin: `${paths.join('\0')}\0`, signal,
    }), 'git checkout-index')
  })
}

/**
 * The members of `paths` the repository ignores. Tracked files are never reported.
 * @param {GitRunner} git - command runner.
 * @param {Awaited<ReturnType<typeof locateRepository>>} repository - located repository.
 * @param {readonly string[]} paths - slash-separated paths relative to the repository root.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<Set<string>>} ignored paths.
 */
export async function ignoredPaths(git, repository, paths, signal) {
  if (paths.length === 0) return new Set()
  const result = await git.run(['check-ignore', '-z', '--stdin'], {
    cwd: repository.root, env: repository.env, stdin: `${paths.join('\0')}\0`, signal,
  })
  if (result.code === 1) return new Set()
  return new Set(ok(result, 'git check-ignore').stdout.toString('utf8').split('\0').filter(path => path !== ''))
}
