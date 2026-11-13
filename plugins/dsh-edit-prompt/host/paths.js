/** Path helpers shared by the recorder and the rewind. */

import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

/**
 * @param {string} path - native relative path.
 * @returns {string} the same path with `/` separators.
 */
export function toPosix(path) {
  return path.split(sep).join('/')
}

/**
 * @param {string} root - absolute directory.
 * @param {string} path - absolute path.
 * @returns {boolean} whether `path` is `root` or lies under it.
 */
export function isInside(root, path) {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Symlink-resolved spelling of a path. A missing path resolves through its
 * nearest existing ancestor, so a file has one spelling before and after it exists.
 * @param {string} path - absolute path.
 * @returns {Promise<string>} the canonical path, as git reports it.
 */
export async function canonicalPath(path) {
  const missing = []
  let head = path
  while (true) {
    try {
      return join(await realpath(head), ...missing)
    } catch {
      // A missing component stays lexical under its nearest resolvable ancestor.
      const parent = dirname(head)
      if (parent === head) return path
      missing.unshift(basename(head))
      head = parent
    }
  }
}

/**
 * Canonical spellings of `/tmp` and the platform temp directory.
 * @returns {Promise<string[]>} directories whose scratch files are never recorded outside a repository.
 */
export async function temporaryRoots() {
  const roots = new Set()
  for (const root of ['/tmp', tmpdir()]) {
    roots.add(root)
    roots.add(await canonicalPath(root))
  }
  return [...roots]
}
