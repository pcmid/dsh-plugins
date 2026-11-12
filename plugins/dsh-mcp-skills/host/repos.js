/**
 * Skill repositories (docs/host-api.md, 「技能仓库（0.2）」): the routes `repos-list`, `repos-add`, `repos-get`,
 * `repos-refresh`, `repos-remove`, `repos-install`, `repos-update`, and the install-record view used by
 * `skills-list` (`SkillItem.origin`) and `skills-delete`.
 *
 * Concurrency:
 * - The state file, every skill write, and every read or write of a git working copy in
 *   `<dshHome>/mcp-skills/repos/<id>/` run inside the shared {@link SerialQueue}, so installs never copy from a
 *   working copy that is being reset, and records never interleave with skill writes.
 * - Network work (clone, fetch) runs outside the queue, one operation per repository at a time; clones go to
 *   a private staging folder that is swapped in inside the queue. A failed fetch leaves the working copy
 *   untouched.
 * - Scans (candidates and their content hashes) are kept in memory per repository, keyed by the cached
 *   commit, so listings never touch the network and normally not the working copy either.
 * - Disposal aborts running git processes and waits (bounded) for queued writes.
 */

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { HostError, errorMessage } from './errors.js'
import { hashDirectory, tryHashDirectory } from './hash.js'
import {
  SOURCE_HELP, candidateDir, cloneRepository, copySkill, findCandidates, keyBasename, parseSource, parseSubpath, runGit,
} from './importer.js'
import { assertDirectChild, displayPath, entryKey, exists, realpathOr, resolveCwd, rootById, skillRoots } from './paths.js'
import { StateStore, reposDir } from './repo-state.js'

/**
 * Skills that may not be installed from a known repository because of their license, keyed by the
 * lowercase GitHub `owner/repo`. `dirs` are skill folder names (the last segment of the key).
 */
export const LICENSE_EXCLUSIONS = Object.freeze({
  'anthropics/skills': Object.freeze({
    dirs: Object.freeze(['docx', 'pdf', 'pptx', 'xlsx']),
    reason: 'Licensed for use within Anthropic products only; not installable',
  }),
})

export const NOT_DOWNLOADED = 'Not downloaded yet; check for updates'
const MAX_REPOSITORIES = 200
const MAX_ITEMS = 500
const DISPOSE_WAIT_MS = 10_000
const REPO_ID = /^[0-9a-f]{12}$/
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const GITHUB_CLONE_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\.git$/i
const LEFTOVER = /^\.[0-9a-f]{12}\.(?:staging|old)-/
const DENIED = new Set(['EACCES', 'EPERM', 'EROFS'])

function digest(identity) {
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 12)
}

/** Lowercase scheme and host and drop trailing slashes, so spelling variants of one URL share an id. */
function normalizeGitUrl(url) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      const parsed = new URL(url)
      return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`
    } catch {
      // Unparseable URLs are compared as typed.
    }
  }
  return url.replace(/\/+$/, '')
}

/** Hide a password embedded in a URL before showing it. */
function redactUrl(url) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url
  try {
    const parsed = new URL(url)
    if (parsed.password === '') return url
    parsed.password = '***'
    return parsed.href
  } catch {
    // Unparseable URLs carry no recognizable credentials.
    return url
  }
}

function repoNameOf(url) {
  const last = url.replace(/[/\\]+$/, '').split(/[/\\:]/).pop() ?? ''
  return last.replace(/\.git$/i, '') || 'repository'
}

/**
 * @param {string | undefined} url - clone URL.
 * @returns {string | undefined} lowercase `owner/repo` for GitHub clone URLs.
 */
function githubKeyOf(url) {
  const match = url === undefined ? null : GITHUB_CLONE_URL.exec(url)
  return match === null ? undefined : `${match[1]}/${match[2]}`.toLowerCase()
}

/**
 * Describe a parsed source as the stored repository fields plus its id. Local sources must already carry
 * the real path of the folder to scan (with any subpath applied). The label names the repository only; a
 * subfolder stays in `subpath` and `source`, never in the label.
 * @param {ReturnType<typeof parseSource>} parsed - parsed source.
 * @param {string[] | undefined} [subpath] - `subpath` field; wins over a folder in the link.
 * @returns {{ id: string, kind: 'git' | 'local', label: string, source: string, url?: string, webUrl?: string,
 *   ref?: string, subpath?: string, path?: string }} repository fields.
 */
export function describeSource(parsed, subpath) {
  if (parsed.kind === 'local') {
    return { id: digest(['local', parsed.path]), kind: 'local', label: displayPath(parsed.path), source: displayPath(parsed.path), path: parsed.path }
  }
  const segments = subpath ?? parsed.subpath
  const sub = segments === undefined || segments.length === 0 ? undefined : segments.join('/')
  const ref = parsed.ref
  let identityUrl
  let label
  let webUrl
  if (parsed.github !== undefined) {
    const { owner, repo } = parsed.github
    identityUrl = `https://github.com/${owner}/${repo}.git`.toLowerCase()
    label = `${owner}/${repo}`
    webUrl = `https://github.com/${owner}/${repo}`
    if (ref !== undefined || sub !== undefined) {
      webUrl += `/tree/${ref ?? 'HEAD'}`
      if (sub !== undefined) webUrl += `/${segments.map(encodeURIComponent).join('/')}`
    }
  } else {
    identityUrl = normalizeGitUrl(parsed.url)
    label = parsed.repoName
  }
  return {
    id: digest(['git', identityUrl, ref ?? '', sub ?? '']),
    kind: 'git',
    label,
    source: webUrl ?? redactUrl(parsed.url),
    url: parsed.url,
    ...(webUrl === undefined ? {} : { webUrl }),
    ...(ref === undefined ? {} : { ref }),
    ...(sub === undefined ? {} : { subpath: sub }),
  }
}

/**
 * Mark license-restricted candidates of a known repository as not installable.
 * @param {string | undefined} githubKey - lowercase `owner/repo`, or `undefined` for other sources.
 * @param {{ key: string, valid: boolean, error?: string, hash?: string }[]} candidates - scan candidates.
 * @param {string} rootName - name of the scan root (for the `'.'` key).
 */
export function applyLicenseExclusions(githubKey, candidates, rootName) {
  const rule = githubKey === undefined ? undefined : LICENSE_EXCLUSIONS[githubKey]
  if (rule === undefined) return
  for (const candidate of candidates) {
    if (!rule.dirs.includes(keyBasename(candidate.key, rootName))) continue
    candidate.valid = false
    candidate.error = rule.reason
    delete candidate.hash
  }
}

async function isDirectory(target) {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch {
    // Missing or unreadable counts as "not a folder".
    return false
  }
}

/** Whether an install record's folder is gone (missing, or no longer a folder); other errors keep it. */
async function isGone(target) {
  try {
    return !(await fs.stat(target)).isDirectory()
  } catch (error) {
    return error.code === 'ENOENT' || error.code === 'ENOTDIR'
  }
}

function problemScan(problem, extra = {}) {
  return { candidates: [], byKey: new Map(), problem, ...extra }
}

/** Scan a folder: candidates, license exclusions, and the content hash of every valid candidate. */
async function scanTree(root, rootName, githubKey) {
  const candidates = await findCandidates(root, rootName)
  applyLicenseExclusions(githubKey, candidates, rootName)
  for (const candidate of candidates) {
    if (!candidate.valid) continue
    try {
      candidate.hash = (await hashDirectory(candidateDir(root, candidate.key))).hash
    } catch (error) {
      candidate.valid = false
      candidate.error = `Cannot read the skill folder: ${errorMessage(error)}`
    }
  }
  // Every folder stays addressable by key (install records may name any of them); the listing shows one per name.
  return { root, candidates: foldSameName(candidates), byKey: new Map(candidates.map(candidate => [candidate.key, candidate])) }
}

const hiddenSegments = key => key.split('/').filter(segment => segment.startsWith('.')).length

/**
 * Keep one candidate per skill name. Repositories that support several agents often ship the same skill
 * again in agent folders such as `.openclaw/skills/<name>`; DSH can only install one skill per name, so
 * the listing keeps the copy a user would pick: a valid one, outside hidden folders, shallowest, then by
 * key. The kept candidate lists the other folders in `alsoAt`.
 * @param {{ key: string, name: string, valid: boolean }[]} candidates - scan candidates in key order.
 * @returns {object[]} one candidate per name, in the original order of the kept ones.
 */
export function foldSameName(candidates) {
  const rank = candidate => [candidate.valid ? 0 : 1, hiddenSegments(candidate.key), candidate.key.split('/').length]
  const better = (a, b) => {
    const [x, y] = [rank(a), rank(b)]
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i]
    return a.key < b.key
  }
  const kept = new Map()
  for (const candidate of candidates) {
    const current = kept.get(candidate.name)
    if (current === undefined || better(candidate, current)) kept.set(candidate.name, candidate)
  }
  return candidates.filter(candidate => kept.get(candidate.name) === candidate).map((candidate) => {
    const others = candidates.filter(other => other.name === candidate.name && other !== candidate).map(other => other.key)
    return others.length === 0 ? candidate : { ...candidate, alsoAt: others }
  })
}

/** Resolve the scan root inside a checkout; a subpath must stay inside it. */
async function locateRoot(checkout, repo) {
  const top = await fs.realpath(checkout)
  if (repo.subpath === undefined) return { root: top, rootName: repoNameOf(repo.url) }
  const segments = repo.subpath.split('/')
  let real
  try {
    real = await fs.realpath(path.join(top, ...segments))
  } catch {
    // Reported below as a missing folder.
    real = undefined
  }
  if (real === undefined || !real.startsWith(top + path.sep) || !(await isDirectory(real))) {
    return { problem: `Folder "${repo.subpath}" does not exist in ${redactUrl(repo.url)}` }
  }
  return { root: real, rootName: segments[segments.length - 1] }
}

async function scanCheckout(checkout, repo, commit) {
  const located = await locateRoot(checkout, repo)
  if (located.problem !== undefined) return problemScan(located.problem, { version: commit })
  const scan = await scanTree(located.root, located.rootName, githubKeyOf(repo.url))
  scan.version = commit
  return scan
}

function assertHasSkills(scan, label) {
  if (scan.candidates.some(candidate => candidate.valid)) return
  if (scan.candidates.length === 0) throw new HostError('invalid', `No SKILL.md found under ${label}`)
  const first = scan.candidates[0]
  throw new HostError('invalid', `No installable skill found under ${label}: ${scan.candidates.length} SKILL.md file(s), none valid (${first.key}: ${first.error})`)
}

function isUpdate(candidate, record) {
  return candidate !== undefined && candidate.valid && candidate.hash !== undefined && candidate.hash !== record.sourceHash
}

function requireRepoId(payload) {
  if (typeof payload.id !== 'string' || !REPO_ID.test(payload.id)) throw new HostError('bad-request', 'Field "id" must be a repository id from repos-list')
  return payload.id
}

function findRepo(state, id) {
  const repo = state.repositories.find(candidate => candidate.id === id)
  if (repo === undefined) throw new HostError('not-found', `Repository ${id} is not in the list; refresh the list and try again`)
  return repo
}

function requireItems(items, check, message) {
  if (!Array.isArray(items) || items.length === 0) throw new HostError('bad-request', 'Field "items" must list at least one skill')
  if (items.length > MAX_ITEMS) throw new HostError('bad-request', `At most ${MAX_ITEMS} skills can be handled at once`)
  for (const item of items) {
    if (typeof item !== 'object' || item === null || Array.isArray(item) || !check(item)) throw new HostError('bad-request', message)
  }
  return items
}

/** Map filesystem permission errors on a skill root to `forbidden`. */
function rootFailure(error, root) {
  if (DENIED.has(error?.code)) return new HostError('forbidden', `${displayPath(root)} is not writable: ${errorMessage(error)}`)
  return error
}

async function scopeOf(cwd) {
  const { roots } = await skillRoots(cwd)
  return new Set(await Promise.all(roots.map(root => realpathOr(root.path))))
}

function sortRepositories(repositories) {
  return [...repositories].sort((a, b) => a.addedAt - b.addedAt || a.label.localeCompare(b.label))
}

/** Repository list, working copies, scans, and install records. */
export class RepoManager {
  #scans = new Map()
  #locks = new Map()
  #staging = new Set()
  #abort = new AbortController()
  #disposed = false
  #swept = false

  /**
   * @param {{ queue: import('./paths.js').SerialQueue, catalog: import('./skills.js').SkillCatalog,
   *   logger?: { warn?: Function } }} options - the shared write queue, the skill catalog (for same-name
   *   copies in repos-get), and a logger for recoverable problems.
   */
  constructor({ queue, catalog, logger }) {
    this.queue = queue
    this.catalog = catalog
    this.logger = logger
    this.store = new StateStore(logger)
  }

  /** `repos-list`: payload `{ cwd? }`. */
  async list(payload) {
    const cwd = await resolveCwd(payload.cwd)
    return await this.queue.run(async () => {
      const state = await this.store.load()
      const records = await this.#records(state)
      if (records.pruned) await this.#saveQuietly(state)
      const scope = await scopeOf(cwd)
      const repositories = []
      for (const repo of sortRepositories(state.repositories)) {
        repositories.push(this.#describe(repo, await this.#scan(repo), records.live, scope))
      }
      return { repositories }
    })
  }

  /** `repos-add`: payload `{ source, subpath?, cwd? }`. */
  async add(payload) {
    if (typeof payload.source !== 'string') throw new HostError('bad-request', SOURCE_HELP)
    const parsed = parseSource(payload.source)
    const subpath = parseSubpath(payload.subpath)
    const cwd = await resolveCwd(payload.cwd)
    if (parsed.kind === 'local') {
      const folder = await this.#localFolder(parsed, subpath)
      const fields = describeSource({ kind: 'local', path: folder })
      return await this.#exclusive(fields.id, () => this.#addLocal(fields, cwd))
    }
    const fields = describeSource(parsed, subpath)
    return await this.#exclusive(fields.id, signal => this.#addGit(fields, cwd, signal))
  }

  /** `repos-get`: payload `{ id, cwd? }`; reads the cache only. */
  async get(payload) {
    const id = requireRepoId(payload)
    const cwd = await resolveCwd(payload.cwd)
    return await this.queue.run(async () => {
      const state = await this.store.load()
      return await this.#detail(state, findRepo(state, id), cwd)
    })
  }

  /** `repos-refresh`: payload `{ id, cwd? }`. */
  async refresh(payload) {
    const id = requireRepoId(payload)
    const cwd = await resolveCwd(payload.cwd)
    const { state } = await this.store.peek()
    const repo = findRepo(state, id)
    if (repo.kind === 'local') return await this.#exclusive(id, () => this.queue.run(() => this.#refreshLocal(id, cwd)))
    return await this.#exclusive(id, signal => this.#refreshGit(repo, cwd, signal))
  }

  /** `repos-remove`: payload `{ id }`. Installed skills stay; their records are forgotten. */
  async remove(payload) {
    const id = requireRepoId(payload)
    // A check or download of this repository in progress is pointless now.
    for (const controller of this.#locks.get(id)?.controllers ?? []) controller.abort()
    return await this.#exclusive(id, () => this.queue.run(async () => {
      const state = await this.store.load()
      const repo = findRepo(state, id)
      const before = state.installs.length
      state.installs = state.installs.filter(record => record.repoId !== id)
      state.repositories = state.repositories.filter(candidate => candidate.id !== id)
      await this.store.save(state)
      this.#scans.delete(id)
      if (repo.kind === 'git') await this.#removeTree(this.#cacheDir(id))
      return { removed: id, forgotten: before - state.installs.length }
    }))
  }

  /** `repos-install`: payload `{ id, cwd?, root, items: [{ key, overwrite }] }`. */
  async install(payload) {
    const id = requireRepoId(payload)
    const items = requireItems(payload.items,
      item => typeof item.key === 'string' && item.key !== '' && typeof item.overwrite === 'boolean',
      'Each entry of "items" must be { key: string, overwrite: boolean }')
    const cwd = await resolveCwd(payload.cwd)
    return await this.queue.run(async () => {
      const layout = await skillRoots(cwd)
      const root = rootById(layout, payload.root)
      const state = await this.store.load()
      const repo = findRepo(state, id)
      const scan = await this.#scan(repo)
      if (scan.root === undefined) throw new HostError('not-found', this.#problemOf(repo, scan) ?? `${repo.label} has no skills`)
      try {
        await fs.mkdir(root.path, { recursive: true })
      } catch (error) {
        throw new HostError('forbidden', `Cannot create the skill folder ${displayPath(root.path)}: ${errorMessage(error)}`)
      }
      const records = await this.#records(state)
      let changed = records.pruned
      const installed = []
      const skipped = []
      const failed = []
      const names = new Set()
      try {
        for (const request of items) {
          const candidate = scan.byKey.get(request.key)
          if (candidate === undefined) {
            failed.push({ name: request.key, error: `No skill "${request.key}" in ${repo.label}` })
            continue
          }
          if (!candidate.valid) {
            failed.push({ name: candidate.name, error: candidate.error ?? 'Not installable' })
            continue
          }
          if (names.has(candidate.name)) {
            failed.push({ name: candidate.name, error: `Another selected skill is also named "${candidate.name}"` })
            continue
          }
          names.add(candidate.name)
          try {
            const outcome = await this.#installOne({ state, records, repo, scan, candidate, root, layout, overwrite: request.overwrite })
            if (outcome.recorded) changed = true
            if (outcome.skipped !== undefined) skipped.push({ name: candidate.name, reason: outcome.skipped })
            else installed.push({ name: candidate.name, path: outcome.path })
          } catch (error) {
            failed.push({ name: candidate.name, error: errorMessage(rootFailure(error, root.path)) })
          }
        }
      } finally {
        if (changed) await this.store.save(state)
      }
      return { installed, skipped, failed }
    })
  }

  /** `repos-update`: payload `{ id, cwd?, items: [{ path, force }] }`; uses the cache only. */
  async update(payload) {
    const id = requireRepoId(payload)
    const items = requireItems(payload.items,
      item => typeof item.path === 'string' && item.path !== '' && typeof item.force === 'boolean',
      'Each entry of "items" must be { path: string, force: boolean }')
    const cwd = await resolveCwd(payload.cwd)
    return await this.queue.run(async () => {
      const layout = await skillRoots(cwd)
      const state = await this.store.load()
      const repo = findRepo(state, id)
      const scan = await this.#scan(repo)
      if (scan.root === undefined) throw new HostError('not-found', this.#problemOf(repo, scan) ?? `${repo.label} has no skills`)
      const records = await this.#records(state)
      let changed = records.pruned
      const updated = []
      const skipped = []
      const failed = []
      const handled = new Set()
      try {
        for (const request of items) {
          const target = request.path
          let found
          if (path.isAbsolute(target)) {
            const entry = await entryKey(path.resolve(target))
            found = records.live.find(candidate => candidate.entry === entry && candidate.record.repoId === repo.id)
          }
          if (found === undefined) {
            failed.push({ name: path.basename(target), path: target, error: 'forbidden' })
            continue
          }
          if (handled.has(found.entry)) continue
          handled.add(found.entry)
          const record = found.record
          try {
            await assertDirectChild(target, layout.roots)
          } catch {
            // Outside the user roots and this workspace's project roots.
            failed.push({ name: record.name, path: target, error: 'forbidden' })
            continue
          }
          const candidate = scan.byKey.get(record.key)
          if (candidate === undefined || !candidate.valid) {
            failed.push({ name: record.name, path: target, error: candidate?.error ?? `"${record.key}" is no longer in ${repo.label}` })
            continue
          }
          try {
            const outcome = await this.#updateOne({ repo, scan, candidate, record, target, force: request.force })
            if (outcome.changed) changed = true
            if (outcome.skipped !== undefined) skipped.push({ name: record.name, path: target, reason: outcome.skipped })
            else updated.push({ name: record.name, path: target })
          } catch (error) {
            failed.push({ name: record.name, path: target, error: errorMessage(rootFailure(error, path.dirname(target))) })
          }
        }
      } finally {
        if (changed) await this.store.save(state)
      }
      return { updated, skipped, failed }
    })
  }

  /**
   * Attach `origin` to listed skills that have install records, and drop records whose folder is gone.
   * Never touches the network.
   * @param {object[]} items - `SkillItem`s, modified in place.
   * @param {{ locked?: boolean }} [options] - `locked` when the caller already runs inside the write queue.
   */
  async attachOrigins(items, { locked = false } = {}) {
    const listed = items.filter(item => item.root !== null && item.layout === 'bundle' && typeof item.dir === 'string')
    if (!locked) {
      const peeked = await this.store.peek()
      if (peeked.problem === undefined && peeked.state.installs.length === 0) return
    }
    const read = async () => {
      const state = await this.store.load()
      if (state.installs.length === 0) return undefined
      const records = await this.#records(state)
      if (records.pruned) await this.#saveQuietly(state)
      if (listed.length === 0) return undefined
      const repositories = new Map(state.repositories.map(repo => [repo.id, repo]))
      const scans = new Map()
      for (const { record } of records.live) {
        const repo = repositories.get(record.repoId)
        if (repo !== undefined && !scans.has(repo.id)) scans.set(repo.id, await this.#scan(repo))
      }
      return { live: records.live, repositories, scans }
    }
    const snapshot = locked ? await read() : await this.queue.run(read)
    if (snapshot === undefined) return
    for (const item of listed) {
      const entry = await entryKey(item.dir)
      const found = snapshot.live.find(candidate => candidate.entry === entry)
      const repo = found === undefined ? undefined : snapshot.repositories.get(found.record.repoId)
      if (repo === undefined) continue
      const { record } = found
      item.origin = {
        repoId: repo.id,
        repoLabel: repo.label,
        key: record.key,
        updateAvailable: isUpdate(snapshot.scans.get(repo.id)?.byKey.get(record.key), record),
        modified: (await tryHashDirectory(item.dir)) !== record.installedHash,
        installedAt: record.installedAt,
      }
    }
  }

  /**
   * Forget the install records of deleted skill entries. Call inside the write queue.
   * @param {Set<string>} entries - {@link entryKey} identities computed before the deletion.
   */
  async forgetEntries(entries) {
    if (entries.size === 0) return
    const state = await this.store.load()
    const keep = []
    for (const record of state.installs) {
      if (!entries.has(await entryKey(record.path))) keep.push(record)
    }
    if (keep.length === state.installs.length) return
    state.installs = keep
    await this.store.save(state)
  }

  /** Cancel git processes and wait (bounded) for queued writes. */
  async dispose() {
    this.#disposed = true
    this.#abort.abort()
    let timer
    await Promise.race([
      this.queue.run(async () => {}),
      new Promise(resolve => {
        timer = setTimeout(resolve, DISPOSE_WAIT_MS)
        timer.unref?.()
      }),
    ])
    clearTimeout(timer)
  }

  // --- adding and refreshing ---

  async #localFolder(parsed, subpath) {
    let info
    try {
      info = await fs.stat(parsed.path)
    } catch (error) {
      throw new HostError('not-found', `Folder ${parsed.label} cannot be opened: ${errorMessage(error)}`)
    }
    if (!info.isDirectory()) throw new HostError('bad-request', `${parsed.label} is not a folder`)
    const real = await fs.realpath(parsed.path)
    if (subpath === undefined) return real
    const joined = path.join(real, ...subpath)
    if (!(await isDirectory(joined))) throw new HostError('not-found', `Folder ${displayPath(joined)} cannot be opened`)
    return await fs.realpath(joined)
  }

  /** Inside the queue: the existing repository's detail with `existing: true`, or `undefined`. */
  async #existing(id, cwd) {
    const state = await this.store.load()
    const repo = state.repositories.find(candidate => candidate.id === id)
    if (repo !== undefined) return { ...(await this.#detail(state, repo, cwd)), existing: true }
    if (state.repositories.length >= MAX_REPOSITORIES) throw new HostError('bad-request', `At most ${MAX_REPOSITORIES} repositories can be added; remove one first`)
    return undefined
  }

  async #addLocal(fields, cwd) {
    const existing = await this.queue.run(() => this.#existing(fields.id, cwd))
    if (existing !== undefined) return existing
    const scan = await scanTree(fields.path, path.basename(fields.path), undefined)
    assertHasSkills(scan, fields.label)
    return await this.queue.run(async () => {
      const again = await this.#existing(fields.id, cwd)
      if (again !== undefined) return again
      const state = await this.store.load()
      const now = Date.now()
      const repo = { ...fields, addedAt: now, checkedAt: now }
      state.repositories.push(repo)
      await this.store.save(state)
      this.#scans.set(repo.id, scan)
      return { ...(await this.#detail(state, repo, cwd)), existing: false }
    })
  }

  async #addGit(fields, cwd, signal) {
    // An existing source is returned without touching the network.
    const existing = await this.queue.run(() => this.#existing(fields.id, cwd))
    if (existing !== undefined) return existing
    const staging = await this.#clone(fields, signal)
    try {
      const commit = await this.#head(staging, fields.label, signal)
      return await this.queue.run(async () => {
        const again = await this.#existing(fields.id, cwd)
        if (again !== undefined) return again
        const cache = this.#cacheDir(fields.id)
        await this.#swapIntoCache(staging, cache)
        let scan
        let repo
        let state
        try {
          const now = Date.now()
          repo = { ...fields, addedAt: now, checkedAt: now, commit }
          scan = await scanCheckout(cache, repo, commit)
          if (scan.problem !== undefined) throw new HostError('not-found', scan.problem)
          assertHasSkills(scan, fields.label)
          state = await this.store.load()
          state.repositories.push(repo)
          await this.store.save(state)
        } catch (error) {
          // Nothing was saved, so the working copy goes too.
          await this.#removeTree(cache)
          throw error
        }
        this.#scans.set(repo.id, scan)
        return { ...(await this.#detail(state, repo, cwd)), existing: false }
      })
    } finally {
      await this.#dropStaging(staging)
    }
  }

  async #refreshLocal(id, cwd) {
    const state = await this.store.load()
    const repo = findRepo(state, id)
    if (!(await isDirectory(repo.path))) {
      const error = new HostError('not-found', `Folder ${displayPath(repo.path)} cannot be opened`)
      repo.lastError = error.message
      this.#scans.delete(id)
      await this.store.save(state)
      throw error
    }
    const scan = await scanTree(repo.path, path.basename(repo.path), undefined)
    repo.checkedAt = Date.now()
    delete repo.lastError
    this.#scans.set(id, scan)
    await this.store.save(state)
    return await this.#detail(state, repo, cwd)
  }

  async #refreshGit(repo, cwd, signal) {
    this.#assertRunning()
    const cache = this.#cacheDir(repo.id)
    let staging
    try {
      if (await this.#healthy(cache, repo, signal)) {
        await runGit(['-C', cache, 'fetch', '--depth', '1', '--quiet', 'origin', repo.ref ?? 'HEAD'], { signal, what: `git fetch of ${repo.label}` })
      } else {
        // A missing or broken working copy is replaced by a fresh clone.
        staging = await this.#clone(repo, signal)
      }
    } catch (error) {
      // A check cancelled by removal or shutdown is not a failure of the repository.
      if (!signal.aborted) await this.queue.run(() => this.#recordFailure(repo.id, error))
      throw error
    }
    try {
      return await this.queue.run(async () => {
        const state = await this.store.load()
        const current = findRepo(state, repo.id)
        let commit
        let scan
        try {
          if (staging === undefined) commit = await this.#resetToFetched(cache, current)
          else {
            commit = await this.#head(staging, current.label)
            await this.#swapIntoCache(staging, cache)
          }
          scan = await scanCheckout(cache, current, commit)
        } catch (error) {
          this.#scans.delete(current.id)
          current.lastError = errorMessage(error)
          await this.store.save(state)
          throw error
        }
        current.commit = commit
        current.checkedAt = Date.now()
        delete current.lastError
        this.#scans.set(current.id, scan)
        await this.store.save(state)
        return await this.#detail(state, current, cwd)
      })
    } finally {
      if (staging !== undefined) await this.#dropStaging(staging)
    }
  }

  /**
   * Inside the queue: move the working copy to the fetched commit, or back to the cached one on failure.
   * These local steps take no abort signal, so shutdown (which waits for the queue) cannot stop them halfway.
   */
  async #resetToFetched(cache, repo) {
    const what = `Updating the downloaded copy of ${repo.label}`
    try {
      await runGit(['-C', cache, 'reset', '--hard', '--quiet', 'FETCH_HEAD'], { what })
      await runGit(['-C', cache, 'clean', '-ffdx', '--quiet'], { what })
      return await this.#head(cache, repo.label)
    } catch (error) {
      if (repo.commit !== undefined) {
        try {
          await runGit(['-C', cache, 'reset', '--hard', '--quiet', repo.commit], { what })
          await runGit(['-C', cache, 'clean', '-ffdx', '--quiet'], { what })
        } catch {
          // The next check replaces a working copy that cannot be restored.
        }
      }
      throw error
    }
  }

  async #recordFailure(id, error) {
    try {
      const state = await this.store.load()
      const repo = state.repositories.find(candidate => candidate.id === id)
      if (repo === undefined) return
      repo.lastError = errorMessage(error)
      await this.store.save(state)
    } catch (saveError) {
      // The caller reports the original failure.
      this.logger?.warn?.(`mcp-skills: could not record the failed check of repository ${id}: ${errorMessage(saveError)}`)
    }
  }

  /** Whether the working copy has a commit and still points at the repository's URL. */
  async #healthy(cache, repo, signal) {
    if (!(await exists(path.join(cache, '.git')))) return false
    try {
      await runGit(['-C', cache, 'rev-parse', '--verify', '--quiet', 'HEAD'], { signal, what: 'git rev-parse' })
      const origin = (await runGit(['-C', cache, 'config', '--get', 'remote.origin.url'], { signal, what: 'git config' })).trim()
      return origin === repo.url
    } catch (error) {
      if (error instanceof HostError && error.code === 'unavailable') throw error
      return false
    }
  }

  /** Clone into a private staging folder next to the working copies; returns its path. */
  async #clone(source, signal) {
    this.#assertRunning()
    const parent = reposDir()
    await fs.mkdir(parent, { recursive: true, mode: 0o700 })
    const staging = path.join(parent, `.${source.id}.staging-${randomUUID()}`)
    this.#staging.add(staging)
    try {
      await cloneRepository(source, staging, signal)
    } catch (error) {
      await this.#dropStaging(staging)
      throw error
    }
    return staging
  }

  async #dropStaging(staging) {
    try {
      await fs.rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch (error) {
      this.logger?.warn?.(`mcp-skills: could not remove ${staging}: ${errorMessage(error)}`)
    } finally {
      this.#staging.delete(staging)
    }
  }

  async #head(checkout, label, signal) {
    const commit = (await runGit(['-C', checkout, 'rev-parse', 'HEAD'], { signal, what: `Reading the commit of ${label}` })).trim()
    if (!COMMIT.test(commit)) throw new HostError('git-failed', `git rev-parse returned an unexpected commit for ${label}: ${commit.slice(0, 80)}`)
    return commit
  }

  /** Inside the queue: replace the working copy with a staged clone; the old copy is removed afterwards. */
  async #swapIntoCache(staging, cache) {
    await this.#sweep()
    let old
    if (await exists(cache)) {
      old = path.join(path.dirname(cache), `.${path.basename(cache)}.old-${randomUUID()}`)
      await fs.rename(cache, old)
    }
    try {
      await fs.rename(staging, cache)
    } catch (error) {
      if (old !== undefined) {
        try {
          await fs.rename(old, cache)
          old = undefined
        } catch {
          // The old copy is swept on a later swap.
        }
      }
      throw error
    }
    if (old !== undefined) await this.#removeTree(old)
  }

  /** Once per process, inside the queue: remove staging folders left behind by an interrupted run. */
  async #sweep() {
    if (this.#swept) return
    this.#swept = true
    let names
    try {
      names = await fs.readdir(reposDir())
    } catch {
      // Nothing to sweep.
      return
    }
    for (const name of names) {
      const full = path.join(reposDir(), name)
      if (LEFTOVER.test(name) && !this.#staging.has(full)) await this.#removeTree(full)
    }
  }

  async #removeTree(target) {
    try {
      await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch (error) {
      this.logger?.warn?.(`mcp-skills: could not remove ${target}: ${errorMessage(error)}`)
    }
  }

  // --- install and update ---

  async #installOne({ state, records, repo, scan, candidate, root, layout, overwrite }) {
    const sourceDir = candidateDir(scan.root, candidate.key)
    const sourceHash = (await hashDirectory(sourceDir)).hash
    // Keep the scan in step with what is copied (a local folder can change between checks).
    candidate.hash = sourceHash
    const target = path.join(root.path, candidate.name)
    await assertDirectChild(target, layout.roots)
    const hasTarget = await exists(target)
    const hasFlat = await exists(`${target}.md`)
    if (hasTarget || hasFlat) {
      if (hasTarget && (await tryHashDirectory(target)) === sourceHash) {
        await this.#putRecord(state, records, { target, repo, candidate, sourceHash, installedHash: sourceHash, keepTime: true })
        return { skipped: 'identical', recorded: true }
      }
      if (!overwrite) return { skipped: 'exists', recorded: false }
    }
    await copySkill(sourceDir, target, { removeFlat: true })
    const installedHash = (await hashDirectory(target)).hash
    await this.#putRecord(state, records, { target, repo, candidate, sourceHash, installedHash, keepTime: false })
    return { path: target, recorded: true }
  }

  async #updateOne({ repo, scan, candidate, record, target, force }) {
    const sourceDir = candidateDir(scan.root, candidate.key)
    const current = (await hashDirectory(sourceDir)).hash
    candidate.hash = current
    const local = await tryHashDirectory(target)
    if (local === current || current === record.sourceHash) {
      // Nothing new upstream, or the local copy already matches: refresh the record so the flags clear.
      if (local === current && (record.sourceHash !== current || record.installedHash !== local)) {
        record.sourceHash = current
        record.installedHash = local
        this.#setCommit(record, repo)
        return { skipped: 'current', changed: true }
      }
      return { skipped: 'current', changed: false }
    }
    if (local !== record.installedHash && !force) return { skipped: 'modified', changed: false }
    await copySkill(sourceDir, target)
    record.sourceHash = current
    record.installedHash = (await hashDirectory(target)).hash
    record.name = candidate.name
    record.updatedAt = Date.now()
    this.#setCommit(record, repo)
    return { changed: true }
  }

  #setCommit(record, repo) {
    if (repo.commit === undefined) delete record.commit
    else record.commit = repo.commit
  }

  async #putRecord(state, records, { target, repo, candidate, sourceHash, installedHash, keepTime }) {
    const entry = await entryKey(target)
    const previous = records.live.find(candidate => candidate.entry === entry)
    const sameOrigin = previous !== undefined && previous.record.repoId === repo.id && previous.record.key === candidate.key
    const record = {
      path: target,
      repoId: repo.id,
      key: candidate.key,
      name: candidate.name,
      sourceHash,
      installedHash,
      ...(repo.commit === undefined ? {} : { commit: repo.commit }),
      installedAt: keepTime && sameOrigin ? previous.record.installedAt : Date.now(),
    }
    if (previous !== undefined) {
      state.installs = state.installs.filter(candidate => candidate !== previous.record)
      records.live = records.live.filter(candidate => candidate !== previous)
    }
    state.installs.push(record)
    records.live.push({ record, entry, parent: path.dirname(entry) })
  }

  // --- reading ---

  /**
   * Live install records with their entry identities; records whose folder is gone are removed from
   * `state.installs` (`pruned` tells the caller to write the state back).
   */
  async #records(state) {
    const live = []
    const keep = []
    for (const record of state.installs) {
      if (await isGone(record.path)) continue
      keep.push(record)
      const entry = await entryKey(record.path)
      live.push({ record, entry, parent: path.dirname(entry) })
    }
    const pruned = keep.length !== state.installs.length
    state.installs = keep
    return { live, pruned }
  }

  /** Inside the queue: the scan of a repository's cache, from memory when it matches the cached commit. */
  async #scan(repo) {
    const cache = this.#cacheDir(repo.id)
    // A working copy deleted behind our back reads as "not downloaded", whatever is in memory.
    if (repo.kind === 'git' && !(await exists(path.join(cache, '.git')))) {
      this.#scans.delete(repo.id)
      return problemScan(NOT_DOWNLOADED, { missing: true })
    }
    const cached = this.#scans.get(repo.id)
    if (cached !== undefined && (repo.kind === 'local' || cached.version === repo.commit)) return cached
    let scan
    if (repo.kind === 'local') {
      if (!(await isDirectory(repo.path))) return problemScan(`Folder ${displayPath(repo.path)} cannot be opened`)
      scan = await scanTree(repo.path, path.basename(repo.path), undefined)
    } else {
      scan = await scanCheckout(cache, repo, repo.commit)
      if (scan.problem !== undefined) return scan
    }
    this.#scans.set(repo.id, scan)
    return scan
  }

  #problemOf(repo, scan) {
    return scan.missing ? NOT_DOWNLOADED : repo.lastError ?? scan.problem
  }

  #describe(repo, scan, live, scope) {
    const keys = new Map()
    for (const { record, parent } of live) {
      if (record.repoId !== repo.id || !scope.has(parent)) continue
      keys.set(record.key, keys.get(record.key) === true || isUpdate(scan.byKey.get(record.key), record))
    }
    const lastError = this.#problemOf(repo, scan)
    return {
      id: repo.id,
      label: repo.label,
      kind: repo.kind,
      source: repo.source,
      ...(repo.kind === 'git' ? { url: redactUrl(repo.url) } : {}),
      ...(repo.webUrl === undefined ? {} : { webUrl: repo.webUrl }),
      ...(repo.ref === undefined ? {} : { ref: repo.ref }),
      ...(repo.subpath === undefined ? {} : { subpath: repo.subpath }),
      ...(repo.kind === 'local' ? { path: repo.path, displayPath: displayPath(repo.path) } : {}),
      addedAt: repo.addedAt,
      ...(repo.checkedAt === undefined ? {} : { checkedAt: repo.checkedAt }),
      ...(repo.commit === undefined ? {} : { commit: repo.commit }),
      ...(lastError === undefined ? {} : { lastError }),
      skillCount: scan.candidates.filter(candidate => candidate.valid).length,
      installedCount: keys.size,
      updateCount: [...keys.values()].filter(Boolean).length,
    }
  }

  /**
   * Inside the queue: the repository detail. Same-name copies in the workspace's four roots are listed per
   * candidate; an untracked copy identical to the repository's version is adopted (a record is written).
   */
  async #detail(state, repo, cwd) {
    const scan = await this.#scan(repo)
    const records = await this.#records(state)
    let changed = records.pruned
    const items = scan.candidates.length === 0
      ? []
      : (await this.catalog.collectItems(cwd)).filter(item => item.root !== null && typeof item.dir === 'string')
    const byName = new Map()
    for (const item of items) {
      const group = byName.get(item.name)
      if (group === undefined) byName.set(item.name, [item])
      else group.push(item)
    }
    const skills = []
    for (const candidate of scan.candidates) {
      const installs = []
      for (const item of byName.get(candidate.name) ?? []) {
        const entry = await entryKey(item.dir)
        const found = records.live.find(live => live.entry === entry)
        let tracked = false
        let updateAvailable = false
        let modified = false
        if (found !== undefined) {
          if (found.record.repoId === repo.id && found.record.key === candidate.key) {
            tracked = true
            updateAvailable = isUpdate(candidate, found.record)
            modified = (await tryHashDirectory(item.dir)) !== found.record.installedHash
          }
        } else if (candidate.valid && item.layout === 'bundle' && (await tryHashDirectory(item.dir)) === candidate.hash) {
          await this.#putRecord(state, records, { target: item.dir, repo, candidate, sourceHash: candidate.hash, installedHash: candidate.hash, keepTime: false })
          changed = true
          tracked = true
        }
        installs.push({
          skillId: item.id,
          root: item.root,
          path: item.dir,
          displayPath: displayPath(item.dir),
          tracked,
          updateAvailable,
          modified,
          active: item.active,
        })
      }
      skills.push({
        key: candidate.key,
        name: candidate.name,
        description: candidate.description,
        valid: candidate.valid,
        ...(candidate.error === undefined ? {} : { error: candidate.error }),
        ...(candidate.alsoAt === undefined ? {} : { alsoAt: candidate.alsoAt }),
        fileCount: candidate.fileCount,
        installs,
      })
    }
    if (changed) await this.#saveQuietly(state)
    return { repository: this.#describe(repo, scan, records.live, await scopeOf(cwd)), skills }
  }

  /** Write state from a read route: a failure is logged, not reported. */
  async #saveQuietly(state) {
    try {
      await this.store.save(state)
    } catch (error) {
      this.logger?.warn?.(`mcp-skills: could not update the skill repository list: ${errorMessage(error)}`)
    }
  }

  // --- plumbing ---

  #cacheDir(id) {
    return path.join(reposDir(), id)
  }

  #assertRunning() {
    if (this.#disposed) throw new HostError('unavailable', 'The plugin is stopping')
  }

  /**
   * Run `task` after earlier operations on the same repository, with a signal that aborts on dispose or
   * when the repository is removed.
   */
  async #exclusive(id, task) {
    let lock = this.#locks.get(id)
    if (lock === undefined) {
      lock = { tail: Promise.resolve(), controllers: new Set(), users: 0 }
      this.#locks.set(id, lock)
    }
    const controller = new AbortController()
    lock.controllers.add(controller)
    lock.users++
    const signal = AbortSignal.any([this.#abort.signal, controller.signal])
    const run = lock.tail.then(() => task(signal))
    lock.tail = run.catch(() => {})
    try {
      return await run
    } finally {
      lock.controllers.delete(controller)
      lock.users--
      if (lock.users === 0 && this.#locks.get(id) === lock) this.#locks.delete(id)
    }
  }
}
