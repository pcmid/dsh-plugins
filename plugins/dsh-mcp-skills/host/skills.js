/**
 * Skill catalog routes: `skills-list`, `skills-read`, `skills-save`, `skills-delete`.
 *
 * The listing scans the direct children of the four skill roots itself and merges the winners of DSH's
 * skill registry (`ctx.skills`, viewed through the default agent preset's scope) to mark the active skill
 * of each name and to add skills from other sources as read-only built-ins. Every operation that takes an
 * id re-lists the same workspace and accepts only ids from that fresh listing. Skills installed from a
 * skill repository carry `origin`, read from the repository manager's install records (host/repos.js).
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { HostError, errorMessage } from './errors.js'
import { MAX_SKILL_NAME_LENGTH, inspectSkill, isSkillName, serializeSkill, updateSkillText } from './frontmatter.js'
import {
  assertDirectChild, displayPath, entryKey, exists, isWritable, listFiles, realpathOr, removeEntry, resolveCwd, rootById,
  skillRoots, writeAtomic,
} from './paths.js'

const SCOPE_ORDER = { project: 0, user: 1, builtin: 2 }
/** Upper bound for one registry snapshot or skill load, so a stuck provider cannot hang a route. */
const REGISTRY_TIMEOUT_MS = 15_000
/** `skills-read` file list: depth ≤ 4, first 50 paths, count stops at 1000. */
const FILE_LIST = { maxDepth: 4, keep: 50, countLimit: 1000, skip: new Set(['.git', 'node_modules']), excludeTop: 'SKILL.md' }
const DENIED = new Set(['EACCES', 'EPERM', 'EROFS'])

/**
 * Run `read` with the default agent preset's scope, or with the global view when presets are absent or
 * the default preset cannot be acquired. The scope lease is released afterwards.
 */
async function withDefaultScope(ctx, read) {
  const presets = ctx.get('agentPresets')
  let lease
  if (presets !== undefined) {
    try {
      lease = await presets.acquireScope()
    } catch {
      // An unusable default preset falls back to the global registry view.
      lease = undefined
    }
  }
  try {
    return await read(lease?.key)
  } finally {
    const dispose = lease?.[Symbol.asyncDispose]
    if (typeof dispose === 'function') {
      try {
        await dispose.call(lease)
      } catch {
        // Releasing a read-only lease cannot affect the result already read.
      }
    }
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Map filesystem permission and absence errors on `subject` to API errors; rethrow anything else. */
function fsFailure(error, subject) {
  if (DENIED.has(error?.code)) return new HostError('forbidden', `${displayPath(subject)} is not writable: ${errorMessage(error)}`)
  if (error?.code === 'ENOENT') return new HostError('not-found', `${displayPath(subject)} no longer exists`)
  return error
}

/** Scan the direct children of one root into listing records, in name order. */
async function scanRoot(root) {
  let entries
  try {
    entries = await fs.readdir(root.path, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []
    throw error
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  const editable = await isWritable(root.path)
  const records = []
  for (const entry of entries) {
    // Dot entries, including `<dshHome>/skills/.system`, are not listed.
    if (entry.name.startsWith('.')) continue
    const entryPath = path.join(root.path, entry.name)
    let kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : undefined
    if (kind === undefined && entry.isSymbolicLink()) {
      try {
        const info = await fs.stat(entryPath)
        kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : undefined
      } catch {
        // A dangling link is not a skill.
        kind = undefined
      }
    }
    if (kind === 'directory') {
      const file = path.join(entryPath, 'SKILL.md')
      try {
        if (!(await fs.stat(file)).isFile()) continue
      } catch {
        // A directory without SKILL.md is not a skill.
        continue
      }
      records.push(await readRecord(root, { entryPath, file, layout: 'bundle', fallback: entry.name, editable }))
    } else if (kind === 'file' && entry.name.endsWith('.md')) {
      const fallback = entry.name.slice(0, -3)
      records.push(await readRecord(root, { entryPath, file: entryPath, layout: 'flat', fallback, editable }))
    }
  }
  return records
}

async function readRecord(root, { entryPath, file, layout, fallback, editable }) {
  let info
  let realPath = file
  try {
    realPath = await fs.realpath(file)
    info = inspectSkill(await fs.readFile(file, 'utf8'))
  } catch (error) {
    info = { modelInvocable: true, userInvocable: true, invalid: `Cannot read ${displayPath(file)}: ${errorMessage(error)}` }
  }
  const item = {
    id: file,
    name: info.invalid === undefined ? info.name : fallback,
    description: info.description ?? '',
    ...(info.whenToUse === undefined ? {} : { whenToUse: info.whenToUse }),
    modelInvocable: info.modelInvocable,
    userInvocable: info.userInvocable,
    root: root.id,
    scope: root.scope,
    source: root.id,
    path: file,
    displayPath: displayPath(file),
    dir: entryPath,
    layout,
    editable,
    active: false,
    ...(info.invalid === undefined ? {} : { invalid: info.invalid }),
  }
  return { item, realPath, rank: root.rank, valid: info.invalid === undefined }
}

/** A registry winner from outside the four roots: read-only, `root: null`. */
function builtinRecord(summary, realPath) {
  const file = typeof summary.path === 'string' ? summary.path : undefined
  const dir = summary.resourceBase?.kind === 'directory' ? summary.resourceBase.path : file === undefined ? undefined : path.dirname(file)
  const item = {
    id: file ?? `builtin:${summary.name}`,
    name: summary.name,
    description: typeof summary.description === 'string' ? summary.description : '',
    ...(typeof summary.whenToUse === 'string' && summary.whenToUse !== '' ? { whenToUse: summary.whenToUse } : {}),
    modelInvocable: summary.invocation?.modelInvocable !== false,
    userInvocable: summary.invocation?.userInvocable !== false,
    root: null,
    scope: 'builtin',
    source: String(summary.source ?? summary.provider ?? 'unknown'),
    ...(file === undefined ? {} : { path: file, displayPath: displayPath(file) }),
    ...(dir === undefined ? {} : { dir }),
    layout: 'builtin',
    editable: false,
    active: false,
  }
  return { item, realPath, rank: Number.POSITIVE_INFINITY, valid: true }
}

/**
 * Validate the `skills-save` fields.
 * @returns {{ name: string, description: string, whenToUse?: string, modelInvocable: boolean,
 *   userInvocable: boolean, body: string }} fields with `description` trimmed.
 */
function saveFields(payload) {
  const { name, description, whenToUse, modelInvocable, userInvocable, body } = payload
  if (typeof name !== 'string' || !isSkillName(name)) {
    throw new HostError('bad-request', `Skill name ${JSON.stringify(name)} is invalid: use lowercase letters, digits, and single hyphens, such as "my-skill"`)
  }
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    throw new HostError('bad-request', `Skill name "${name}" is longer than ${MAX_SKILL_NAME_LENGTH} characters`)
  }
  if (typeof description !== 'string' || description.trim() === '') {
    throw new HostError('bad-request', 'Field "description" must not be empty')
  }
  if (whenToUse !== undefined && typeof whenToUse !== 'string') {
    throw new HostError('bad-request', 'Field "whenToUse" must be text')
  }
  if (typeof modelInvocable !== 'boolean') throw new HostError('bad-request', 'Field "modelInvocable" must be true or false')
  if (typeof userInvocable !== 'boolean') throw new HostError('bad-request', 'Field "userInvocable" must be true or false')
  if (typeof body !== 'string') throw new HostError('bad-request', 'Field "body" must be text')
  return { name, description: description.trim(), whenToUse, modelInvocable, userInvocable, body }
}

function assertValidText(text) {
  const info = inspectSkill(text)
  if (info.invalid !== undefined) {
    throw new HostError('invalid', `The skill file would not load in DSH after saving: ${info.invalid}. Fix that part of SKILL.md in a text editor.`)
  }
}

function requireId(payload) {
  if (typeof payload.id !== 'string' || payload.id === '') throw new HostError('bad-request', 'Field "id" must be a skill id from skills-list')
  return payload.id
}

/** `skills-delete` takes at most this many ids. */
const MAX_DELETE = 200

/** `skills-delete` ids: `ids` (0.2), or the legacy single `id`; duplicates are dropped. */
function requireIds(payload) {
  if (payload.ids === undefined && typeof payload.id === 'string' && payload.id !== '') return [payload.id]
  const { ids } = payload
  if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== 'string' || id === '')) {
    throw new HostError('bad-request', 'Field "ids" must list skill ids from skills-list')
  }
  if (ids.length > MAX_DELETE) throw new HostError('bad-request', `At most ${MAX_DELETE} skills can be deleted at once`)
  return [...new Set(ids)]
}

/** A display name for an id that is not in the listing: the folder (or flat file) name. */
function nameFromId(id) {
  if (id.startsWith('builtin:')) return id.slice('builtin:'.length)
  const base = path.basename(id)
  if (base === 'SKILL.md') return path.basename(path.dirname(id))
  return base.endsWith('.md') ? base.slice(0, -3) : base
}

/** Skill listing and editing over the four skill roots and DSH's registry. */
export class SkillCatalog {
  /**
   * Install records; set by the plugin after construction. Without it skills carry no `origin`.
   * @type {import('./repos.js').RepoManager | undefined}
   */
  repos = undefined

  /**
   * @param {object} ctx - plugin context; `skills` and `agentPresets` are read lazily with `ctx.get`.
   * @param {import('./paths.js').SerialQueue} queue - serializes writes with the repository manager.
   * @param {{ warn?: Function }} [logger] - receives recoverable problems.
   */
  constructor(ctx, queue, logger) {
    this.ctx = ctx
    this.queue = queue
    this.logger = logger
  }

  /** `skills-list`: payload `{ cwd? }`. */
  async list(payload) {
    const cwd = await resolveCwd(payload.cwd)
    const { layout, roots, records, complete } = await this.#collect(cwd)
    const skills = records.map(record => record.item)
    await this.#attachOrigins(skills, false)
    return {
      ...(layout.projectRoot === undefined ? {} : { projectRoot: layout.projectRoot }),
      roots,
      skills,
      complete,
    }
  }

  /**
   * The listed skills of a workspace, without `origin`; for the repository manager inside the write queue.
   * @param {string | undefined} cwd - validated workspace directory.
   * @returns {Promise<object[]>} `SkillItem`s.
   */
  async collectItems(cwd) {
    return (await this.#collect(cwd)).records.map(record => record.item)
  }

  /** `skills-read`: payload `{ id, cwd? }`. */
  async read(payload) {
    const id = requireId(payload)
    const cwd = await resolveCwd(payload.cwd)
    const { item } = await this.#find(cwd, id)
    await this.#attachOrigins([item], false)
    if (item.root === null) {
      const skills = this.ctx.get('skills')
      if (skills === undefined) throw new HostError('unavailable', 'The DSH skill registry is not available, so built-in skills cannot be read')
      const definition = await withDefaultScope(this.ctx, scope =>
        skills.get(item.name, { cwd, scope, signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) }))
      if (definition === undefined) throw new HostError('not-found', `Built-in skill "${item.name}" is no longer available`)
      const listing = item.path !== undefined && path.basename(item.path) === 'SKILL.md'
        ? await listFiles(path.dirname(item.path), FILE_LIST)
        : { files: [], total: 0 }
      return { item, body: typeof definition.content === 'string' ? definition.content : '', files: listing.files, filesTotal: listing.total }
    }
    let raw
    try {
      raw = await fs.readFile(item.path, 'utf8')
    } catch (error) {
      throw new HostError('not-found', `Cannot read ${item.displayPath}: ${errorMessage(error)}`)
    }
    const listing = item.layout === 'bundle' ? await listFiles(item.dir, FILE_LIST) : { files: [], total: 0 }
    return { item, body: inspectSkill(raw).body, files: listing.files, filesTotal: listing.total }
  }

  /** `skills-save`: create a bundle skill in a root, or edit a listed editable skill. */
  async save(payload) {
    const fields = saveFields(payload)
    const target = payload.target
    if (!isRecord(target) || typeof target.create !== 'boolean') {
      throw new HostError('bad-request', 'Field "target" must be { create: true, root } or { create: false, id }')
    }
    return await this.queue.run(async () => {
      const cwd = await resolveCwd(payload.cwd)
      const id = target.create ? await this.#create(cwd, target.root, fields) : await this.#edit(cwd, target.id, fields)
      const { records } = await this.#collect(cwd)
      const record = records.find(candidate => candidate.item.id === id)
      if (record === undefined) throw new Error(`Saved ${displayPath(id)}, but it is missing from the refreshed skill list`)
      await this.#attachOrigins([record.item], true)
      return { item: record.item }
    })
  }

  /**
   * `skills-delete`: payload `{ ids, cwd? }` (or the legacy `{ id }`). Each id must be listed and editable;
   * the others are reported in `failed` without affecting the rest. Install records of deleted skills are
   * forgotten.
   */
  async remove(payload) {
    const ids = requireIds(payload)
    return await this.queue.run(async () => {
      const cwd = await resolveCwd(payload.cwd)
      const { records, layout } = await this.#collect(cwd)
      const removed = []
      const failed = []
      const entries = new Set()
      for (const id of ids) {
        const record = records.find(candidate => candidate.item.id === id)
        if (record === undefined) {
          failed.push({ id, name: nameFromId(id), error: `Skill ${displayPath(id)} is not in the skill list for this workspace; refresh the list and try again` })
          continue
        }
        const { item } = record
        try {
          this.#assertEditable(item)
          await assertDirectChild(item.dir, layout.roots)
          const entry = await entryKey(item.dir)
          try {
            await removeEntry(item.dir)
          } catch (error) {
            throw fsFailure(error, item.dir)
          }
          entries.add(entry)
          removed.push({ id, name: item.name, path: item.dir })
        } catch (error) {
          failed.push({ id, name: item.name, error: errorMessage(error) })
        }
      }
      if (this.repos !== undefined && entries.size > 0) {
        try {
          await this.repos.forgetEntries(entries)
        } catch (error) {
          // The skills are gone; their records are dropped as stale on the next read.
          this.logger?.warn?.(`mcp-skills: could not forget the install records of deleted skills: ${errorMessage(error)}`)
        }
      }
      return { removed, failed }
    })
  }

  /** Attach `origin` from the install records; a failure only drops the origins. */
  async #attachOrigins(items, locked) {
    if (this.repos === undefined) return
    try {
      await this.repos.attachOrigins(items, { locked })
    } catch (error) {
      this.logger?.warn?.(`mcp-skills: could not read the skill repository install records: ${errorMessage(error)}`)
    }
  }

  async #create(cwd, rootId, fields) {
    const layout = await skillRoots(cwd)
    const root = rootById(layout, rootId)
    try {
      await fs.mkdir(root.path, { recursive: true })
    } catch (error) {
      throw new HostError('forbidden', `Cannot create the skill folder ${displayPath(root.path)}: ${errorMessage(error)}`)
    }
    const dir = path.join(root.path, fields.name)
    await assertDirectChild(dir, layout.roots)
    for (const existing of [dir, `${dir}.md`]) {
      if (await exists(existing)) throw new HostError('exists', `A skill named "${fields.name}" already exists at ${displayPath(existing)}`)
    }
    const text = serializeSkill(fields)
    assertValidText(text)
    try {
      await fs.mkdir(dir)
    } catch (error) {
      if (error.code === 'EEXIST') throw new HostError('exists', `A skill named "${fields.name}" already exists at ${displayPath(dir)}`)
      throw fsFailure(error, root.path)
    }
    const file = path.join(dir, 'SKILL.md')
    try {
      await writeAtomic(file, text)
    } catch (error) {
      // The directory was created by this call, so removing it restores the previous state.
      await fs.rm(dir, { recursive: true, force: true })
      throw fsFailure(error, dir)
    }
    return file
  }

  async #edit(cwd, id, fields) {
    if (typeof id !== 'string' || id === '') throw new HostError('bad-request', 'Field "target.id" must be a skill id from skills-list')
    const { item, layout } = await this.#find(cwd, id)
    this.#assertEditable(item)
    if (fields.name !== item.name) {
      throw new HostError('bad-request', `Renaming a skill is not supported; keep the name "${item.name}"`)
    }
    await assertDirectChild(item.dir, layout.roots)
    let raw
    try {
      raw = await fs.readFile(item.path, 'utf8')
    } catch (error) {
      throw fsFailure(error, item.path)
    }
    const text = updateSkillText(raw, fields)
    assertValidText(text)
    // Writing to the resolved file keeps a symlinked SKILL.md (or flat file) a symlink.
    const target = await fs.realpath(item.path)
    try {
      await writeAtomic(target, text)
    } catch (error) {
      throw fsFailure(error, target)
    }
    return id
  }

  #assertEditable(item) {
    if (item.root === null) throw new HostError('forbidden', `"${item.name}" is a built-in skill and is read-only`)
    if (!item.editable) throw new HostError('forbidden', `${displayPath(item.dir)} is read-only`)
  }

  async #find(cwd, id) {
    const collected = await this.#collect(cwd)
    const record = collected.records.find(candidate => candidate.item.id === id)
    if (record === undefined) {
      throw new HostError('not-found', `Skill ${displayPath(id)} is not in the skill list for this workspace; refresh the list and try again`)
    }
    return { item: record.item, layout: collected.layout }
  }

  /** Scan the roots, merge the registry, and resolve `active` / `shadowedBy`. */
  async #collect(cwd) {
    const layout = await skillRoots(cwd)
    const roots = []
    const records = []
    const rootReals = []
    let complete = true
    for (const root of layout.roots) {
      let present = false
      try {
        present = (await fs.stat(root.path)).isDirectory()
      } catch {
        // A missing root lists nothing.
        present = false
      }
      roots.push({ id: root.id, scope: root.scope, path: root.path, displayPath: displayPath(root.path), rank: root.rank, exists: present })
      if (!present) continue
      rootReals.push(await realpathOr(root.path))
      try {
        records.push(...await scanRoot(root))
      } catch {
        // An unreadable root is left out; `complete: false` tells the Client the list is partial.
        complete = false
      }
    }

    const registry = await this.#registry(cwd)
    if (registry === undefined || registry.complete !== true) complete = false
    const winners = new Map()
    const insideRoots = real => rootReals.some(root => real === root || real.startsWith(root + path.sep))
    for (const summary of registry?.skills ?? []) {
      if (!isRecord(summary) || typeof summary.name !== 'string') continue
      const real = typeof summary.path === 'string' ? await realpathOr(summary.path) : undefined
      const match = real === undefined
        ? undefined
        : records.find(record => record.valid && record.realPath === real && record.item.name === summary.name)
      if (match !== undefined) {
        winners.set(summary.name, match)
        continue
      }
      // A winner inside a root that the scan did not list (for example a dot entry) is not shown.
      if (real !== undefined && insideRoots(real)) continue
      const builtin = builtinRecord(summary, real)
      records.push(builtin)
      winners.set(summary.name, builtin)
    }

    const groups = new Map()
    for (const record of records) {
      if (!record.valid) continue
      const group = groups.get(record.item.name)
      if (group === undefined) groups.set(record.item.name, [record])
      else group.push(record)
    }
    for (const [name, group] of groups) {
      const winner = winners.get(name) ?? group.reduce((best, record) => (record.rank < best.rank ? record : best))
      winner.item.active = true
      for (const record of group) {
        if (record === winner) continue
        record.item.shadowedBy = {
          id: winner.item.id,
          ...(winner.item.displayPath === undefined ? {} : { displayPath: winner.item.displayPath }),
          root: winner.item.root,
        }
      }
    }

    records.sort((a, b) =>
      SCOPE_ORDER[a.item.scope] - SCOPE_ORDER[b.item.scope]
      || a.item.name.localeCompare(b.item.name)
      || a.rank - b.rank)
    return { layout, roots, records, complete }
  }

  /** Read the registry snapshot, or `undefined` when the registry is absent or fails. */
  async #registry(cwd) {
    const skills = this.ctx.get('skills')
    if (skills === undefined) return undefined
    try {
      const snapshot = await withDefaultScope(this.ctx, scope =>
        skills.snapshot({ cwd, scope, signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) }))
      return isRecord(snapshot) && Array.isArray(snapshot.skills) ? snapshot : undefined
    } catch {
      // Without the registry the listing falls back to rank order and reports `complete: false`.
      return undefined
    }
  }
}
