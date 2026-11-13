/**
 * Durable storage of the file rewind: content-addressed copies of files as
 * they were before a turn changed them, one record per recorded turn, and a
 * journal of every restore so a restore can be undone.
 *
 * Layout under the storage directory:
 *   blobs/<2>/<sha1>      file bytes, named by the SHA-1 of their content
 *   turns/<key>.json      one recorded turn (see {@link turnKey})
 *   restores/<id>.json    what one restore overwrote
 */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readdir, readFile, readlink, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

/** Format version of turn records and restore journals. */
const RECORD_VERSION = 1
const DAY_MS = 24 * 60 * 60 * 1000

/** A file that grew past the copy limit while it was being copied. */
class GrewPastCap extends Error {}

/**
 * Identity of one turn that survives forking: a fork copies its parent's
 * events, so the first event's time and the turn start's position and time
 * are the same in every conversation that contains the turn.
 * @param {number} originTime - time of the conversation's event 0.
 * @param {number} seq - sequence number of the `turn/start` event.
 * @param {number} time - time of the `turn/start` event.
 * @returns {string} the record key.
 */
export function turnKey(originTime, seq, time) {
  return `${originTime}-${seq}-${time}`
}

/**
 * Whether two file states are known to be equal.
 * @param {Side} a - one state.
 * @param {Side} b - the other.
 * @returns {boolean} false whenever either side is unavailable.
 * @typedef {{ kind: 'absent' } | { kind: 'file', hash: string, exec: boolean } | { kind: 'link', target: string }
 *   | { kind: 'unavailable', reason: 'oversized' | 'unsupported' }} Side
 */
export function sameSide(a, b) {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'absent': return true
    case 'file': return a.hash === b.hash
    case 'link': return a.target === b.target
    default: return false
  }
}

/** Whether an error names a missing path. */
function isMissing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
}

/**
 * The current state of a path, with a content hash for a regular file of any size.
 * @param {string} path - absolute path.
 * @returns {Promise<Side>} the state; directories and special files are `unsupported`.
 */
export async function currentSide(path) {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (isMissing(error)) return { kind: 'absent' }
    throw error
  }
  if (info.isSymbolicLink()) return { kind: 'link', target: await readlink(path) }
  if (!info.isFile()) return { kind: 'unavailable', reason: 'unsupported' }
  const hash = createHash('sha1')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { kind: 'file', hash: hash.digest('hex'), exec: (info.mode & 0o111) !== 0 }
}

/** The plugin's durable storage directory. */
export class Store {
  /** @param {string} dir - storage directory, created on first write. */
  constructor(dir) {
    this.dir = dir
  }

  /** @param {string} hash - content SHA-1. @returns {string} the blob file. */
  blobPath(hash) {
    return join(this.dir, 'blobs', hash.slice(0, 2), hash)
  }

  /**
   * Read stored bytes.
   * @param {string} hash - content SHA-1.
   * @returns {Promise<Buffer>} the content.
   * @throws when the copy is missing.
   */
  readBlob(hash) {
    return readFile(this.blobPath(hash))
  }

  /**
   * Store a path's current content and describe it. The copy is streamed, so
   * a large file costs no more memory than one read chunk.
   * @param {string} path - absolute path.
   * @param {number} maxBytes - largest file stored; a larger one is `oversized`.
   * @returns {Promise<Side>} the state, restorable unless `unavailable`.
   */
  async capture(path, maxBytes) {
    let info
    try {
      info = await lstat(path)
    } catch (error) {
      if (isMissing(error)) return { kind: 'absent' }
      throw error
    }
    if (info.isSymbolicLink()) return { kind: 'link', target: await readlink(path) }
    if (!info.isFile()) return { kind: 'unavailable', reason: 'unsupported' }
    if (info.size > maxBytes) return { kind: 'unavailable', reason: 'oversized' }
    const temporary = join(this.dir, 'blobs', `${randomUUID()}.tmp`)
    await mkdir(dirname(temporary), { recursive: true })
    const hash = createHash('sha1')
    let size = 0
    try {
      await pipeline(createReadStream(path), async function* (source) {
        for await (const chunk of source) {
          size += chunk.length
          if (size > maxBytes) throw new GrewPastCap()
          hash.update(chunk)
          yield chunk
        }
      }, createWriteStream(temporary, { flags: 'wx' }))
    } catch (error) {
      await rm(temporary, { force: true })
      if (error instanceof GrewPastCap) return { kind: 'unavailable', reason: 'oversized' }
      throw error
    }
    const digest = hash.digest('hex')
    const file = this.blobPath(digest)
    await mkdir(dirname(file), { recursive: true })
    // Renaming over an existing copy replaces identical bytes and refreshes its time,
    // so pruning cannot remove a copy a running turn refers to.
    await rename(temporary, file)
    return { kind: 'file', hash: digest, exec: (info.mode & 0o111) !== 0 }
  }

  /**
   * Write one turn record, replacing an earlier one with the same key.
   * @param {string} key - {@link turnKey}.
   * @param {object} record - turn facts and `files: [{ path, before, after }]`.
   */
  writeTurn(key, record) {
    return this.writeJson(join(this.dir, 'turns', `${key}.json`), { version: RECORD_VERSION, ...record })
  }

  /**
   * @param {string} key - {@link turnKey}.
   * @returns {Promise<object | undefined>} the record, or undefined when the turn was not recorded.
   */
  async readTurn(key) {
    return this.readJson(join(this.dir, 'turns', `${key}.json`))
  }

  /**
   * Write a restore journal.
   * @param {object} journal - restore facts and `files: [{ path, previous, restored }]`.
   * @returns {Promise<string>} the journal id.
   */
  async writeRestore(journal) {
    const id = `${Date.now()}-${randomUUID()}`
    await this.writeJson(join(this.dir, 'restores', `${id}.json`), { version: RECORD_VERSION, id, ...journal })
    return id
  }

  /**
   * @param {string} id - journal id.
   * @returns {Promise<object | undefined>} the journal, or undefined for an unknown id.
   */
  readRestore(id) {
    if (!/^[\w-]+$/.test(id)) return Promise.resolve(undefined)
    return this.readJson(join(this.dir, 'restores', `${id}.json`))
  }

  /**
   * Remove turn records and journals older than the retention period, then
   * every copy that is older than it and no remaining file refers to.
   * @param {number} retentionDays - days a record is kept.
   * @param {number} [now] - current time.
   */
  async prune(retentionDays, now = Date.now()) {
    const cutoff = now - retentionDays * DAY_MS
    const referenced = new Set()
    for (const kind of ['turns', 'restores']) {
      for (const file of await listFiles(join(this.dir, kind))) {
        if ((await stat(file)).mtimeMs < cutoff) {
          await rm(file, { force: true })
          continue
        }
        const data = await this.readJson(file).catch(() => undefined)
        for (const entry of data?.files ?? []) {
          for (const side of [entry.before, entry.previous]) if (side?.kind === 'file') referenced.add(side.hash)
        }
      }
    }
    for (const shard of await listFiles(join(this.dir, 'blobs'))) {
      // A copy interrupted by a crash leaves its temporary file beside the shards.
      if (shard.endsWith('.tmp')) {
        if ((await stat(shard)).mtimeMs < cutoff) await rm(shard, { force: true })
        continue
      }
      for (const file of await listFiles(shard)) {
        const hash = file.slice(file.length - 40)
        if (!referenced.has(hash) && (await stat(file)).mtimeMs < cutoff) await rm(file, { force: true })
      }
    }
  }

  async writeJson(file, value) {
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(value)}\n`)
    await rename(temporary, file)
  }

  async readJson(file) {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
    const value = JSON.parse(text)
    if (value?.version !== RECORD_VERSION) throw new Error(`${file} has unsupported version ${value?.version}`)
    return value
  }
}

/** Entries of a directory as absolute paths; a missing directory is empty. */
async function listFiles(dir) {
  try {
    return (await readdir(dir)).map(name => join(dir, name))
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}
