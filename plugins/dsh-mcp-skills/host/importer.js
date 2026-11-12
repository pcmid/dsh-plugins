/**
 * Skill import routes: `skills-scan` finds SKILL.md folders in a Git repository or a local folder, and
 * `skills-install` copies selected ones into a skill root.
 *
 * Git sources are cloned shallowly into `os.tmpdir()/dsh-mcp-skills-*`. A scan, and its clone, is
 * removed after an install from it, 15 minutes after the scan, when more than 8 scans are kept, or when
 * the plugin is disposed.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HostError, errorMessage } from './errors.js'
import { inspectSkill } from './frontmatter.js'
import {
  assertDirectChild, displayPath, exists, expandHome, listFiles, removeEntry, resolveCwd, rootById, skillRoots,
} from './paths.js'

const TEMP_PREFIX = 'dsh-mcp-skills-'
const SCAN_TTL_MS = 15 * 60_000
const GIT_TIMEOUT_MS = 90_000
const MAX_STORED_SCANS = 8
const MAX_SCAN_DEPTH = 5
const MAX_CANDIDATES = 500
/** Directories visited per scan, so scanning a very large folder by mistake stays bounded. */
const MAX_SCAN_DIRECTORIES = 5000
const MAX_INSTALL_ITEMS = 500
const SCAN_SKIP = new Set(['.git', 'node_modules'])
/** `fileCount` counts what an install copies (everything but `.git`), up to 1000 files. */
const FILE_COUNT = { maxDepth: 8, keep: 0, countLimit: 1000, skip: new Set(['.git']) }

const SOURCE_HELP = 'Enter a GitHub link (https://github.com/<owner>/<repo>[/tree/<ref>/<path>]), <owner>/<repo>, a Git URL ending in .git, a git@ address, or a local folder path starting with / or ~/'
const GITHUB_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/i
const GITHUB_SHORT = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9_.-]+)$/
const SCP_LIKE = /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[^\s]+$/
const GIT_URL = /^(?:https?|ssh|git|file):\/\/[^\s]+$/i
const REF = /^[A-Za-z0-9._/-]+$/

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse an import source.
 * @param {string} input - user-entered source.
 * @returns {{ kind: 'local', path: string, label: string } | { kind: 'git', url: string, ref?: string,
 *   subpath?: string[], label: string, repoName: string }} the source.
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
    const parsed = { kind: 'git', url: `https://github.com/${owner}/${repo}.git`, label: `${owner}/${repo}`, repoName: repo }
    if (ref !== undefined) parsed.ref = checkRef(decode(ref))
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

/** Clone `source` with depth 1 into `dir`; user input is passed as argv after `--`, never through a shell. */
function cloneRepository(source, dir, signal) {
  const args = ['clone', '--depth', '1', '--quiet']
  if (source.ref !== undefined) args.push('--branch', source.ref)
  args.push('--', source.url, dir)
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1 << 20,
      windowsHide: true,
      signal,
    }, (error, _stdout, stderr) => {
      if (error === null) {
        resolve()
        return
      }
      if (error.code === 'ENOENT') reject(new HostError('unavailable', 'Git is not installed or not on PATH; install Git to import skills from a repository'))
      else if (error.name === 'AbortError') reject(new HostError('unavailable', 'The import was cancelled because the plugin stopped'))
      else if (error.killed) reject(new HostError('git-failed', `git clone of ${source.label} timed out after ${GIT_TIMEOUT_MS / 1000} seconds`))
      else reject(new HostError('git-failed', `git clone of ${source.label} failed: ${gitStderr(stderr)}`))
    })
  })
}

/** Find SKILL.md folders under `root` (depth ≤ 5, skipping `.git`/`node_modules`, not following symlinks). */
async function findCandidates(root, rootName) {
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
  const fallback = key === '.' ? rootName : key.slice(key.lastIndexOf('/') + 1)
  const { total } = await listFiles(dir, FILE_COUNT)
  return {
    key,
    name: info.invalid === undefined ? info.name : fallback,
    description: info.description ?? '',
    valid: info.invalid === undefined,
    ...(info.invalid === undefined ? {} : { error: info.invalid }),
    fileCount: total,
    dir,
  }
}

/** Copy one candidate to `<root>/<name>`; returns `installed` or `skipped`. */
async function installCandidate(candidate, root, roots, overwrite) {
  const target = path.join(root.path, candidate.name)
  const flat = `${target}.md`
  await assertDirectChild(target, roots)
  const hasTarget = await exists(target)
  const hasFlat = await exists(flat)
  if ((hasTarget || hasFlat) && !overwrite) return 'skipped'
  // Copy next to the target first so a failed copy never removes the existing skill.
  const staging = path.join(root.path, `.${candidate.name}.installing-${randomUUID()}`)
  try {
    await fs.cp(candidate.dir, staging, {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
      filter: source => path.basename(source) !== '.git',
    })
    if (hasTarget) await removeEntry(target)
    if (hasFlat) await removeEntry(flat)
    await fs.rename(staging, target)
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true })
    throw error
  }
  return 'installed'
}

/** Scans kept between `skills-scan` and `skills-install`, with their temporary clones. */
export class SkillImporter {
  #scans = new Map()
  #disposed = false
  #abort = new AbortController()

  /** @param {import('./paths.js').SerialQueue} queue - serializes installs with other skill writes. */
  constructor(queue) {
    this.queue = queue
  }

  /** `skills-scan`: payload `{ source }`. */
  async scan(payload) {
    if (typeof payload.source !== 'string') throw new HostError('bad-request', SOURCE_HELP)
    const source = parseSource(payload.source)
    if (source.kind === 'local') {
      let info
      try {
        info = await fs.stat(source.path)
      } catch (error) {
        throw new HostError('not-found', `Folder ${source.label} cannot be opened: ${errorMessage(error)}`)
      }
      if (!info.isDirectory()) throw new HostError('bad-request', `${source.label} is not a folder`)
      const root = await fs.realpath(source.path)
      return this.#store(source.label, undefined, await findCandidates(root, path.basename(root)))
    }

    if (this.#disposed) throw new HostError('unavailable', 'The plugin is stopping')
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX))
    try {
      const repo = path.join(temp, 'repo')
      await cloneRepository(source, repo, this.#abort.signal)
      if (this.#disposed) throw new HostError('unavailable', 'The plugin is stopping')
      let root = await fs.realpath(repo)
      if (source.subpath !== undefined) {
        const folder = source.subpath.join('/')
        let real
        try {
          real = await fs.realpath(path.join(root, ...source.subpath))
        } catch {
          // Reported below as a missing folder.
          real = undefined
        }
        if (real === undefined || !(real.startsWith(root + path.sep)) || !(await fs.stat(real)).isDirectory()) {
          throw new HostError('not-found', `Folder "${folder}" does not exist in ${source.label}`)
        }
        root = real
      }
      const rootName = source.subpath === undefined ? source.repoName : source.subpath[source.subpath.length - 1]
      return this.#store(source.label, temp, await findCandidates(root, rootName))
    } catch (error) {
      await fs.rm(temp, { recursive: true, force: true })
      throw error
    }
  }

  /** `skills-install`: payload `{ scanId, cwd?, root, items: [{ key, overwrite }] }`. */
  async install(payload) {
    if (typeof payload.scanId !== 'string' || payload.scanId === '') throw new HostError('bad-request', 'Field "scanId" must be the id returned by skills-scan')
    const items = payload.items
    if (!Array.isArray(items) || items.length === 0) throw new HostError('bad-request', 'Field "items" must list at least one skill to install')
    if (items.length > MAX_INSTALL_ITEMS) throw new HostError('bad-request', `At most ${MAX_INSTALL_ITEMS} skills can be installed at once`)
    for (const item of items) {
      if (!isRecord(item) || typeof item.key !== 'string' || typeof item.overwrite !== 'boolean') {
        throw new HostError('bad-request', 'Each entry of "items" must be { key: string, overwrite: boolean }')
      }
    }
    return await this.queue.run(async () => {
      const scan = this.#scans.get(payload.scanId)
      if (scan === undefined) throw new HostError('not-found', 'This scan has expired or is unknown; scan the source again')
      const cwd = await resolveCwd(payload.cwd)
      const layout = await skillRoots(cwd)
      const root = rootById(layout, payload.root)
      try {
        await fs.mkdir(root.path, { recursive: true })
      } catch (error) {
        throw new HostError('forbidden', `Cannot create the skill folder ${displayPath(root.path)}: ${errorMessage(error)}`)
      }
      const installed = []
      const skipped = []
      const failed = []
      const names = new Set()
      try {
        for (const request of items) {
          const candidate = scan.candidates.find(entry => entry.key === request.key)
          if (candidate === undefined) {
            failed.push({ name: request.key, error: `No skill "${request.key}" in this scan` })
            continue
          }
          if (!candidate.valid) {
            failed.push({ name: candidate.name, error: candidate.error })
            continue
          }
          if (names.has(candidate.name)) {
            failed.push({ name: candidate.name, error: `Another selected skill is also named "${candidate.name}"` })
            continue
          }
          names.add(candidate.name)
          try {
            const outcome = await installCandidate(candidate, root, layout.roots, request.overwrite)
            ;(outcome === 'skipped' ? skipped : installed).push(candidate.name)
          } catch (error) {
            failed.push({ name: candidate.name, error: errorMessage(error) })
          }
        }
      } finally {
        await this.#drop(payload.scanId)
      }
      return { installed, skipped, failed }
    })
  }

  /** Remove every scan and temporary clone, and cancel clones in progress. */
  async dispose() {
    this.#disposed = true
    this.#abort.abort()
    await Promise.all([...this.#scans.keys()].map(id => this.#drop(id)))
  }

  #store(label, temp, candidates) {
    if (this.#disposed) throw new HostError('unavailable', 'The plugin is stopping')
    const scanId = randomUUID()
    const timer = setTimeout(() => { void this.#drop(scanId) }, SCAN_TTL_MS)
    timer.unref?.()
    this.#scans.set(scanId, { label, temp, candidates, timer })
    while (this.#scans.size > MAX_STORED_SCANS) void this.#drop(this.#scans.keys().next().value)
    return {
      scanId,
      label,
      candidates: candidates.map(({ dir: _dir, ...candidate }) => candidate),
    }
  }

  async #drop(scanId) {
    const scan = this.#scans.get(scanId)
    if (scan === undefined) return
    this.#scans.delete(scanId)
    clearTimeout(scan.timer)
    if (scan.temp === undefined) return
    try {
      await fs.rm(scan.temp, { recursive: true, force: true })
    } catch {
      // A clone that cannot be removed stays under os.tmpdir(), which the OS cleans; callers must not fail.
    }
  }
}
