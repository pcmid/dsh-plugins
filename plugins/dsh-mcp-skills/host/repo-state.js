/**
 * The repository state file `<dshHome>/mcp-skills/state.json` (docs/host-api.md, 「技能仓库」):
 * `{ version: 1, repositories: StoredRepository[], installs: InstallRecord[] }`.
 *
 * The file is re-read on every operation, so it never goes stale against the disk. Writes are atomic
 * (temporary file + rename) with mode 0600; callers run `load`/`save` inside the shared write queue. A file
 * that is not valid JSON, has another version, or has the wrong shape is never overwritten silently: `load`
 * renames it to `state.json.corrupt-<ms>`, logs a warning, and starts empty. Malformed entries inside a valid
 * file are dropped (and the drop is logged).
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { HostError, errorMessage } from './errors.js'
import { dshHome } from './paths.js'

export const STATE_VERSION = 1
const HASH = /^[0-9a-f]{64}$/
const REPO_ID = /^[0-9a-f]{12}$/
const COMMIT = /^[0-9a-f]{40,64}$/

/** @returns {string} `<dshHome>/mcp-skills`, resolved at call time. */
export function stateDir() {
  return path.join(dshHome(), 'mcp-skills')
}

/** @returns {string} the state file path. */
export function statePath() {
  return path.join(stateDir(), 'state.json')
}

/** @returns {string} the folder holding one git working copy per repository. */
export function reposDir() {
  return path.join(stateDir(), 'repos')
}

/** @returns {{ version: 1, repositories: object[], installs: object[] }} an empty state. */
export function emptyState() {
  return { version: STATE_VERSION, repositories: [], installs: [] }
}

const isText = value => typeof value === 'string' && value !== ''
const isTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const optional = (value, check) => value === undefined || check(value)

function validRepository(entry) {
  return typeof entry === 'object' && entry !== null
    && typeof entry.id === 'string' && REPO_ID.test(entry.id)
    && (entry.kind === 'git' || entry.kind === 'local')
    && isText(entry.source) && isText(entry.label) && isTime(entry.addedAt)
    && (entry.kind === 'git' ? isText(entry.url) : isText(entry.path) && path.isAbsolute(entry.path))
    && optional(entry.ref, isText) && optional(entry.subpath, isText) && optional(entry.webUrl, isText)
    && optional(entry.checkedAt, isTime) && optional(entry.commit, value => typeof value === 'string' && COMMIT.test(value))
    && optional(entry.lastError, value => typeof value === 'string')
}

function validInstall(entry) {
  return typeof entry === 'object' && entry !== null
    && isText(entry.path) && path.isAbsolute(entry.path)
    && typeof entry.repoId === 'string' && REPO_ID.test(entry.repoId)
    && isText(entry.key) && isText(entry.name)
    && typeof entry.sourceHash === 'string' && HASH.test(entry.sourceHash)
    && typeof entry.installedHash === 'string' && HASH.test(entry.installedHash)
    && isTime(entry.installedAt) && optional(entry.updatedAt, isTime)
    && optional(entry.commit, value => typeof value === 'string' && COMMIT.test(value))
}

/** Labels written before 0.2.0 ended in `/<subpath>`; the label now names the repository only. */
function withoutSubpathInLabel(entry) {
  const suffix = entry.subpath === undefined ? '' : `/${entry.subpath}`
  return suffix && entry.label.endsWith(suffix) && entry.label.length > suffix.length
    ? { ...entry, label: entry.label.slice(0, -suffix.length) }
    : entry
}

/**
 * Parse state text.
 * @param {string} text - file content.
 * @returns {{ state?: object, problem?: string, dropped: number }} the state, or why the file is unusable.
 */
export function parseState(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    return { problem: `not valid JSON (${errorMessage(error)})`, dropped: 0 }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { problem: 'not a JSON object', dropped: 0 }
  if (data.version !== STATE_VERSION) return { problem: `unsupported version ${JSON.stringify(data.version)}`, dropped: 0 }
  if (!Array.isArray(data.repositories) || !Array.isArray(data.installs)) return { problem: 'missing "repositories" or "installs"', dropped: 0 }
  const seen = new Set()
  const repositories = data.repositories.filter(entry => {
    if (!validRepository(entry) || seen.has(entry.id)) return false
    seen.add(entry.id)
    return true
  }).map(withoutSubpathInLabel)
  const paths = new Set()
  const installs = data.installs.filter(entry => {
    if (!validInstall(entry) || !seen.has(entry.repoId) || paths.has(entry.path)) return false
    paths.add(entry.path)
    return true
  })
  const dropped = data.repositories.length - repositories.length + data.installs.length - installs.length
  return { state: { version: STATE_VERSION, repositories, installs }, dropped }
}

/** Reads and writes the state file. */
export class StateStore {
  /** @param {{ warn?: Function } | undefined} logger - receives corruption warnings. */
  constructor(logger) {
    this.logger = logger
  }

  /**
   * Read the state without side effects (for read-only routes outside the write queue).
   * @returns {Promise<{ state: object, problem?: string }>} the state; an unusable or unreadable file reads
   *   as empty with `problem` set.
   */
  async peek() {
    let text
    try {
      text = await fs.readFile(statePath(), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return { state: emptyState() }
      return { state: emptyState(), problem: `cannot be read: ${errorMessage(error)}` }
    }
    const parsed = parseState(text)
    return parsed.state === undefined ? { state: emptyState(), problem: parsed.problem } : { state: parsed.state }
  }

  /**
   * Read the state for a mutation. Call inside the write queue: an unusable file is renamed aside first.
   * @returns {Promise<object>} the state.
   * @throws {HostError} `internal` when the file exists but cannot be read (it is left alone).
   */
  async load() {
    const file = statePath()
    let text
    try {
      text = await fs.readFile(file, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState()
      throw new HostError('internal', `Cannot read the skill repository list ${file}: ${errorMessage(error)}`)
    }
    const parsed = parseState(text)
    if (parsed.state !== undefined) {
      if (parsed.dropped > 0) this.logger?.warn?.(`mcp-skills: dropped ${parsed.dropped} malformed entries from ${file}`)
      return parsed.state
    }
    const aside = `${file}.corrupt-${Date.now()}`
    try {
      await fs.rename(file, aside)
    } catch (error) {
      throw new HostError('internal', `The skill repository list ${file} is unusable (${parsed.problem}) and could not be moved aside: ${errorMessage(error)}`)
    }
    this.logger?.warn?.(`mcp-skills: ${file} is unusable (${parsed.problem}); moved it to ${aside} and started with an empty repository list`)
    return emptyState()
  }

  /**
   * Write the state atomically with mode 0600. Call inside the write queue.
   * @param {object} state - state to write.
   */
  async save(state) {
    const file = statePath()
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = path.join(path.dirname(file), `.state.json.${randomUUID()}.tmp`)
    const text = `${JSON.stringify({ version: STATE_VERSION, repositories: state.repositories, installs: state.installs }, null, 2)}\n`
    try {
      await fs.writeFile(temp, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await fs.rename(temp, file)
    } catch (error) {
      await fs.rm(temp, { force: true })
      throw error
    }
  }
}
