/**
 * Rewinding files to the state they had when a turn started, and undoing a rewind.
 *
 * A rewind reads the conversation's own log, so a fork rewinds the turns it
 * inherited as well as its own and never the turns of a branch it does not
 * contain. For every path a recorded turn at or after the cut changed, the
 * wanted state is the one before the earliest such turn. A path is restored
 * without asking when it still holds what the latest such turn left; a path
 * changed since, one whose earlier content was too large to keep, and one that
 * is now a directory need confirmation. Everything a rewind overwrites is
 * stored and journaled before the first write, and a failed write puts back
 * every path written before it.
 */

import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { currentSide, sameSide, turnKey } from './store.js'

/**
 * Merge the recorded turns of a conversation from one turn start onward.
 * @param {import('./store.js').Store} store - durable storage.
 * @param {ReadonlyArray<{ seq: number, type: string, time: number }>} events - the conversation's events in log order.
 * @param {number} fromSeq - sequence number of the first rewound `turn/start`.
 * @returns {Promise<Map<string, { before: object, after: object }>>} per path, the state to restore and the state the turns left.
 */
export async function planRewind(store, events, fromSeq) {
  const files = new Map()
  const origin = events.find(event => event.seq === 0)
  if (origin === undefined) return files
  for (const start of events.filter(event => event.type === 'turn/start' && event.seq >= fromSeq)) {
    const record = await store.readTurn(turnKey(origin.time, start.seq, start.time))
    for (const { path, before, after } of record?.files ?? []) {
      const known = files.get(path)
      if (known === undefined) files.set(path, { before, after })
      else known.after = after
    }
  }
  return files
}

/**
 * Restore planned paths.
 * @param {import('./store.js').Store} store - durable storage.
 * @param {Map<string, { before: object, after: object }>} plan - {@link planRewind}.
 * @param {{ force: boolean, journal: object }} options - `force` confirms the paths
 *   that need it; `journal` carries facts saved with the restore journal.
 * @returns {Promise<{ status: 'attention', files: Array<{ path: string, reason: string }> }
 *   | { status: 'restored', restoreId?: string, files: number, skipped: Array<{ path: string, reason: string }> }>}
 *   the paths needing confirmation (nothing written), or what was restored and the paths it could not restore.
 */
export async function rewindFiles(store, plan, options) {
  const attention = []
  const changes = []
  for (const [path, { before, after }] of plan) {
    const current = await currentSide(path)
    if (sameSide(current, before)) continue
    if (before.kind === 'unavailable') attention.push({ path, reason: before.reason })
    else if (current.kind === 'unavailable') attention.push({ path, reason: 'unsupported' })
    else {
      if (!sameSide(current, after)) attention.push({ path, reason: 'modified' })
      changes.push({ path, restored: before })
    }
  }
  if (attention.length > 0 && !options.force) return { status: 'attention', files: attention }
  const skipped = attention.filter(item => item.reason !== 'modified')
  if (changes.length === 0) return { status: 'restored', files: 0, skipped }
  // Store what is about to be overwritten before the first write, so a crash midway can still be undone.
  for (const change of changes) change.previous = await store.capture(change.path, Infinity)
  const restoreId = await store.writeRestore({ ...options.journal, time: Date.now(), files: changes })
  await applyAll(store, changes.map(({ path, restored, previous }) => ({ path, from: previous, to: restored })))
  return { status: 'restored', restoreId, files: changes.length, skipped }
}

/**
 * Put back what one restore overwrote, for every path that still holds what the restore wrote.
 * @param {import('./store.js').Store} store - durable storage.
 * @param {string} restoreId - journal id from {@link rewindFiles}.
 * @returns {Promise<{ files: number, skipped: string[] }>} paths put back, and paths changed since the restore.
 * @throws when the journal does not exist.
 */
export async function undoRewind(store, restoreId) {
  const journal = await store.readRestore(restoreId)
  if (journal === undefined) throw Object.assign(new Error(`no restore ${restoreId}`), { code: 'not-found' })
  const writes = []
  const skipped = []
  for (const { path, previous, restored } of journal.files) {
    if (sameSide(await currentSide(path), restored)) writes.push({ path, from: restored, to: previous })
    else skipped.push(path)
  }
  await applyAll(store, writes)
  return { files: writes.length, skipped }
}

/** Apply writes in order; on a failure, return every applied path to its `from` state and rethrow. */
async function applyAll(store, writes) {
  const applied = []
  try {
    for (const write of writes) {
      await applySide(store, write.path, write.to)
      applied.push(write)
    }
  } catch (error) {
    for (const write of applied.reverse()) {
      await applySide(store, write.path, write.from).catch(() => {
        // The journal keeps the content; the original failure is the one to report.
      })
    }
    throw error
  }
}

/**
 * Make a path hold one recorded state. A file is written beside its target and renamed over it.
 * @param {import('./store.js').Store} store - durable storage holding file content.
 * @param {string} path - absolute path.
 * @param {object} side - `absent`, `file`, or `link` state.
 */
async function applySide(store, path, side) {
  switch (side.kind) {
    case 'absent':
      await rm(path, { force: true })
      return
    case 'link':
      await rm(path, { force: true })
      await mkdir(dirname(path), { recursive: true })
      await symlink(side.target, path)
      return
    case 'file': {
      const bytes = await store.readBlob(side.hash)
      await mkdir(dirname(path), { recursive: true })
      const existing = await lstat(path).catch(() => undefined)
      let mode = existing?.isFile() ? existing.mode & 0o777 : 0o644
      mode = side.exec ? mode | ((mode & 0o444) >> 2) : mode & ~0o111
      const temporary = `${path}.${randomUUID()}.dsh-edit-prompt`
      try {
        await writeFile(temporary, bytes, { mode })
        await chmod(temporary, mode)
        await rename(temporary, path)
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
      return
    }
    default:
      throw new Error(`cannot restore ${path}: its earlier content was not kept`)
  }
}
