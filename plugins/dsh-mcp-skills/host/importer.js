/**
 * Repository import internals shared by the repository manager (host/repos.js): source parsing, git
 * processes, the SKILL.md scan, and the staged copy that installs or replaces a skill directory.
 *
 * Git always runs through `execFile` (never a shell) with prompts disabled, a 90 second timeout, an abort
 * signal, and user input passed as argv after `--`.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HostError, errorMessage } from './errors.js'
import { inspectSkill } from './frontmatter.js'
import { displayPath, exists, expandHome, listFiles, removeEntry } from './paths.js'

export const GIT_TIMEOUT_MS = 90_000
const MAX_SCAN_DEPTH = 5
export const MAX_CANDIDATES = 500
/** Directories visited per scan, so scanning a very large folder by mistake stays bounded. */
const MAX_SCAN_DIRECTORIES = 5000
const SCAN_SKIP = new Set(['.git', 'node_modules'])
/** `fileCount` counts what an install copies (everything but `.git`), up to 1000 files. */
const FILE_COUNT = { maxDepth: 8, keep: 0, countLimit: 1000, skip: new Set(['.git']) }

export const SOURCE_HELP = 'Enter a GitHub link (https://github.com/<owner>/<repo>[/tree/<ref>/<path>]), <owner>/<repo>, a Git URL ending in .git, a git@ address, or a local folder path starting with / or ~/'
const GITHUB_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/i
const GITHUB_SHORT = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9_.-]+)$/
const SCP_LIKE = /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[^\s]+$/
const GIT_URL = /^(?:https?|ssh|git|file):\/\/[^\s]+$/i
const REF = /^[A-Za-z0-9._/-]+$/

/**
 * Parse a repository source.
 * @param {string} input - user-entered source.
 * @returns {{ kind: 'local', path: string, label: string } | { kind: 'git', url: string, ref?: string,
 *   subpath?: string[], label: string, repoName: string, github?: { owner: string, repo: string } }} the
 *   source; GitHub sources always use `https://github.com/<owner>/<repo>.git`, and a `/tree/HEAD` link has
 *   no `ref` (it names the default branch).
 * @throws {HostError} `bad-request` for unsupported or malformed sources.
 */
export function parseSource(input) {
  const source = input.trim()
  if (source === '') throw new HostError('bad-request', SOURCE_HELP)
  if (source === '~' || source.startsWith('~/') || source.startsWith('~\\') || path.isAbsolute(source)) {
    const resolved = path.resolve(expandHome(source))
    return { kind: 'local', path: resolved, label: displayPath(resolved) }
  }
  if (source.startsWith('~')) throw new HostError('bad-request', `Only ~/ paths are supported: ${source}`)

  const github = GITHUB_URL.exec(source.replace(/[?#].*$/, '')) ?? GITHUB_SHORT.exec(source)
  if (github !== null) {
    const [, owner, rawRepo, ref, rest] = github
    const repo = rawRepo.replace(/\.git$/i, '')
    if (owner === '.' || owner === '..' || repo === '' || repo === '.' || repo === '..') throw new HostError('bad-request', SOURCE_HELP)
    const parsed = { kind: 'git', url: `https://github.com/${owner}/${repo}.git`, label: `${owner}/${repo}`, repoName: repo, github: { owner, repo } }
    if (ref !== undefined) {
      const checked = checkRef(decode(ref))
      if (checked !== 'HEAD') parsed.ref = checked
    }
    const subpath = splitSubpath(rest)
    if (subpath.length > 0) parsed.subpath = subpath
    return parsed
  }

  if (SCP_LIKE.test(source)) {
    const target = source.slice(source.indexOf('@') + 1)
    const label = target.replace(/\.git\/?$/, '')
    return { kind: 'git', url: source, label, repoName: repoName(target.slice(target.indexOf(':') + 1)) }
  }
  if (GIT_URL.test(source)) {
    let url
    try {
      url = new URL(source)
    } catch {
      // Malformed URLs are reported with the list of supported forms.
      throw new HostError('bad-request', SOURCE_HELP)
    }
    if (url.protocol === 'file:') {
      const local = fileURLToPath(url)
      return { kind: 'git', url: source, label: displayPath(local), repoName: repoName(local) }
    }
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !/\.git\/?$/.test(url.pathname)) {
      throw new HostError('bad-request', `Git URLs must end in .git: ${source}`)
    }
    return { kind: 'git', url: source, label: `${url.host}${url.pathname}`.replace(/\.git\/?$/, '').replace(/\/$/, ''), repoName: repoName(url.pathname) }
  }
  throw new HostError('bad-request', SOURCE_HELP)
}

/**
 * Parse the `subpath` field of `repos-add`.
 * @param {unknown} value - payload value.
 * @returns {string[] | undefined} path segments, or `undefined` when absent or empty.
 * @throws {HostError} `bad-request` for a non-string or a path with `.`/`..` segments.
 */
export function parseSubpath(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new HostError('bad-request', 'Field "subpath" must be a folder path inside the repository')
  const segments = value.trim().split(/[/\\]/).filter(segment => segment !== '')
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw new HostError('bad-request', `Field "subpath" must not contain "." or ".." segments: ${value}`)
  }
  return segments.length === 0 ? undefined : segments
}

function decode(text) {
  try {
    return decodeURIComponent(text)
  } catch {
    // Invalid percent-encoding is a malformed link.
    throw new HostError('bad-request', `Malformed link segment: ${text}`)
  }
}

function checkRef(ref) {
  if (!REF.test(ref) || ref.startsWith('-') || ref.includes('..')) throw new HostError('bad-request', `Unsupported Git ref "${ref}"`)
  return ref
}

function splitSubpath(rest) {
  if (rest === undefined) return []
  const segments = decode(rest).split('/').filter(segment => segment !== '')
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw new HostError('bad-request', `The folder path in the link must not contain "." or ".." segments: ${rest}`)
  }
  return segments
}

function repoName(pathname) {
  const last = pathname.replace(/\/+$/, '').split(/[/\\]/).pop() ?? ''
  return last.replace(/\.git$/, '') || 'skill'
}

/** Summarize git's stderr: `fatal:`/`error:` lines when present, otherwise the last lines. */
function gitStderr(stderr) {
  const lines = String(stderr ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const important = lines.filter(line => /^(?:fatal|error):/i.test(line))
  const text = (important.length > 0 ? important : lines.slice(-3)).join(' ')
  return text.length > 500 ? `${text.slice(0, 497)}...` : text || 'no error output'
}

/**
 * Run git without a shell. Prompts are disabled so a private repository fails instead of waiting for input.
 * @param {string[]} args - git arguments; user input must follow `--` where git accepts it.
 * @param {{ signal?: AbortSignal, what: string }} options - `what` names the operation in errors
 *   (for example "git clone of anthropics/skills").
 * @returns {Promise<string>} stdout.
 * @throws {HostError} `unavailable` when git is missing or the run was aborted, `git-failed` otherwise.
 */
export function runGit(args, { signal, what }) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1 << 20,
      windowsHide: true,
      signal,
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolve(String(stdout))
        return
      }
      if (error.code === 'ENOENT') reject(new HostError('unavailable', 'Git is not installed or not on PATH; install Git to add skills from a repository'))
      else if (error.name === 'AbortError') reject(new HostError('unavailable', `${what} was cancelled`))
      else if (error.killed) reject(new HostError('git-failed', `${what} timed out after ${GIT_TIMEOUT_MS / 1000} seconds`))
      else reject(new HostError('git-failed', `${what} failed: ${gitStderr(stderr)}`))
    })
  })
}

/**
 * Clone `source` with depth 1 into `dir` (which must not exist).
 * @param {{ url: string, ref?: string, label: string }} source - parsed git source.
 * @param {string} dir - destination.
 * @param {AbortSignal} [signal] - cancels the clone.
 */
export async function cloneRepository(source, dir, signal) {
  const args = ['clone', '--depth', '1', '--quiet']
  if (source.ref !== undefined) args.push('--branch', source.ref)
  args.push('--', source.url, dir)
  await runGit(args, { signal, what: `git clone of ${source.label}` })
}

/**
 * Find SKILL.md folders under `root` (depth ≤ 5, skipping `.git`/`node_modules`, not following symlinks,
 * at most 500). A folder with SKILL.md is one candidate; its subfolders are not searched.
 * @param {string} root - real path of the scan root.
 * @param {string} rootName - name used when the root itself is an invalid skill.
 * @returns {Promise<{ key: string, name: string, description: string, valid: boolean, error?: string,
 *   fileCount: number }[]>} candidates in sorted depth-first order; `key` is the `/`-separated folder
 *   relative to `root`, `'.'` for the root itself.
 */
export async function findCandidates(root, rootName) {
  const candidates = []
  let visited = 0
  const walk = async (dir, key, depth) => {
    if (candidates.length >= MAX_CANDIDATES || visited >= MAX_SCAN_DIRECTORIES) return
    visited++
    let skill
    try {
      skill = await fs.lstat(path.join(dir, 'SKILL.md'))
    } catch {
      // No SKILL.md here; keep looking below.
      skill = undefined
    }
    if (skill?.isFile()) {
      candidates.push(await describeCandidate(dir, key, rootName))
      return
    }
    if (depth >= MAX_SCAN_DEPTH) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      // Unreadable folders are skipped.
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (!entry.isDirectory() || SCAN_SKIP.has(entry.name)) continue
      await walk(path.join(dir, entry.name), key === '.' ? entry.name : `${key}/${entry.name}`, depth + 1)
    }
  }
  await walk(root, '.', 0)
  return candidates
}

async function describeCandidate(dir, key, rootName) {
  let info
  try {
    info = inspectSkill(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8'))
  } catch (error) {
    info = { invalid: `Cannot read SKILL.md: ${errorMessage(error)}` }
  }
  const { total } = await listFiles(dir, FILE_COUNT)
  return {
    key,
    name: info.invalid === undefined ? info.name : keyBasename(key, rootName),
    description: info.description ?? '',
    valid: info.invalid === undefined,
    ...(info.invalid === undefined ? {} : { error: info.invalid }),
    fileCount: total,
  }
}

/**
 * @param {string} key - candidate key.
 * @param {string} rootName - name of the scan root.
 * @returns {string} the candidate folder's own name.
 */
export function keyBasename(key, rootName) {
  return key === '.' ? rootName : key.slice(key.lastIndexOf('/') + 1)
}

/**
 * @param {string} root - scan root.
 * @param {string} key - candidate key.
 * @returns {string} the candidate folder.
 */
export function candidateDir(root, key) {
  return key === '.' ? root : path.join(root, ...key.split('/'))
}

/**
 * Copy `sourceDir` to `target` (a direct child of a checked skill root), replacing what is there: the copy
 * is staged next to the target, the old entry is moved aside, the copy is renamed into place, and only then
 * is the old entry removed (a symlink loses only the link). A failure before the swap leaves the old entry
 * untouched. `.git` is skipped and symlinks are copied as links.
 * @param {string} sourceDir - folder to copy.
 * @param {string} target - destination entry path.
 * @param {{ removeFlat?: boolean }} [options] - also remove a flat `<target>.md` skill after the swap.
 */
export async function copySkill(sourceDir, target, { removeFlat = false } = {}) {
  const parent = path.dirname(target)
  const name = path.basename(target)
  const staging = path.join(parent, `.${name}.installing-${randomUUID()}`)
  try {
    await fs.cp(sourceDir, staging, {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
      filter: source => path.basename(source) !== '.git',
    })
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true })
    throw error
  }
  let aside
  try {
    if (await exists(target)) {
      aside = path.join(parent, `.${name}.replaced-${randomUUID()}`)
      await fs.rename(target, aside)
    }
    await fs.rename(staging, target)
  } catch (error) {
    if (aside !== undefined && !(await exists(target))) {
      try {
        await fs.rename(aside, target)
        aside = undefined
      } catch {
        // The old entry stays at its aside name; the error below reports the failure.
      }
    }
    await fs.rm(staging, { recursive: true, force: true })
    throw error
  }
  if (aside !== undefined) {
    try {
      await removeEntry(aside)
    } catch {
      // The new copy is in place; a leftover dot entry is not listed as a skill.
    }
  }
  const flat = `${target}.md`
  if (removeFlat && await exists(flat)) await removeEntry(flat)
}
