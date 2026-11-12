/**
 * Content hash of a skill directory (docs/host-api.md, 「内容哈希」).
 *
 * The hash is a sha256 over the directory's files sorted by relative path: each regular file contributes
 * `F \0 <relpath> \0 <sha256 of content> \0`, each symlink `L \0 <relpath> \0 -> <target> \0`, an unreadable
 * entry `U \0 <relpath> \0`, and any other entry `O \0 <relpath> \0`. Hashing each file's content separately
 * keeps the framing unambiguous and lets large files stream; the result is only ever compared with other
 * results of this function and never leaves the Host. `.git` is skipped at every depth. Files deeper than 8
 * path segments are skipped, and the walk stops after 1000 files or 2000 directories; hitting any bound adds
 * a marker, so two trees that differ only beyond the bounds hash alike, but a bounded tree never hashes like
 * a truncated one.
 * The top-level directory may be a symlink (it is followed); symlinks inside it are not.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

/** Bounds of one directory hash. */
export const HASH_LIMITS = Object.freeze({ maxFiles: 1000, maxDepth: 8, maxDirectories: 2000 })

const SKIP = new Set(['.git'])

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Collect the entries to hash.
 * @param {string} dir - directory to walk (followed when it is a symlink).
 * @returns {Promise<{ entries: { rel: string, abs: string, kind: 'file' | 'link' | 'other' }[], truncated: boolean }>}
 *   entries in a deterministic order (sorted names, depth first) and whether a bound was hit.
 * @throws when `dir` itself cannot be read.
 */
async function collect(dir) {
  const entries = []
  let directories = 0
  let truncated = false
  // The file and directory bounds end the walk; the depth bound only skips the deeper folder.
  let stopped = false
  const walk = async (current, prefix, depth) => {
    directories++
    let children
    try {
      children = await fs.readdir(current, { withFileTypes: true })
    } catch (error) {
      if (depth === 1) throw error
      // An unreadable subdirectory is part of the content: record it so a permission change shows up.
      entries.push({ rel: `${prefix}/`, abs: current, kind: 'other' })
      return
    }
    children.sort((a, b) => compare(a.name, b.name))
    for (const child of children) {
      if (stopped) return
      if (SKIP.has(child.name)) continue
      const rel = prefix === '' ? child.name : `${prefix}/${child.name}`
      const abs = path.join(current, child.name)
      if (child.isDirectory()) {
        if (depth >= HASH_LIMITS.maxDepth) {
          truncated = true
          continue
        }
        if (directories >= HASH_LIMITS.maxDirectories) {
          truncated = stopped = true
          return
        }
        await walk(abs, rel, depth + 1)
        continue
      }
      if (entries.length >= HASH_LIMITS.maxFiles) {
        truncated = stopped = true
        return
      }
      entries.push({ rel, abs, kind: child.isSymbolicLink() ? 'link' : child.isFile() ? 'file' : 'other' })
    }
  }
  await walk(dir, '', 1)
  entries.sort((a, b) => compare(a.rel, b.rel))
  return { entries, truncated }
}

/** Add one file to the hash: its content is streamed into its own sha256, so large files are not buffered. */
async function addFile(hash, entry) {
  const content = createHash('sha256')
  try {
    for await (const chunk of createReadStream(entry.abs)) content.update(chunk)
  } catch {
    // An unreadable file hashes as a marker, so it still differs from a readable one.
    hash.update(`U\0${entry.rel}\0`)
    return
  }
  hash.update(`F\0${entry.rel}\0${content.digest('hex')}\0`)
}

/**
 * Hash a skill directory.
 * @param {string} dir - absolute directory path.
 * @returns {Promise<{ hash: string, files: number, truncated: boolean }>} hex sha256, the number of entries
 *   hashed, and whether a bound was hit.
 * @throws when `dir` is missing or is not a readable directory.
 */
export async function hashDirectory(dir) {
  const { entries, truncated } = await collect(dir)
  const hash = createHash('sha256')
  for (const entry of entries) {
    if (entry.kind === 'file') await addFile(hash, entry)
    else if (entry.kind === 'link') {
      let target
      try {
        target = await fs.readlink(entry.abs)
      } catch {
        // A link that vanished during the walk hashes as unreadable.
        target = undefined
      }
      hash.update(target === undefined ? `U\0${entry.rel}\0` : `L\0${entry.rel}\0-> ${target}\0`)
    } else hash.update(`O\0${entry.rel}\0`)
  }
  if (truncated) hash.update(`T\0truncated\0${HASH_LIMITS.maxFiles}\0${HASH_LIMITS.maxDepth}\0`)
  return { hash: hash.digest('hex'), files: entries.length, truncated }
}

/**
 * @param {string} dir - absolute directory path.
 * @returns {Promise<string | undefined>} its hash, or `undefined` when it cannot be hashed.
 */
export async function tryHashDirectory(dir) {
  try {
    return (await hashDirectory(dir)).hash
  } catch {
    // A missing or unreadable directory has no content to compare.
    return undefined
  }
}
