// Test support for skill repositories: local git repositories served over file:// (never the network).

import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { put } from './support.mjs'

/** Whether git can run here; git-backed tests are skipped otherwise. */
export const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    // Reported by the skip reason of the tests.
    return false
  }
})()

const GIT_ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']

/**
 * Isolate git from the user's and the system's configuration (the plugin's git runs inherit this).
 * @returns {() => void} restores the previous values.
 */
export function isolateGit() {
  const saved = Object.fromEntries(GIT_ENV_KEYS.map(key => [key, process.env[key]]))
  process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  return () => {
    for (const key of GIT_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim()
}

/**
 * Create a working repository with `files`, commit it, and publish it as a bare repository.
 * @param {string} base - folder to create the repositories in.
 * @param {Record<string, string>} files - relative path → content.
 * @param {string} [name] - bare repository folder name.
 * @returns {Promise<{ work: string, bare: string, url: string, head(): string, commit(files: Record<string, string | null>, message?: string): Promise<string> }>}
 *   `commit` writes (or, for `null`, deletes) files, commits, pushes to the bare repository, and returns the new commit.
 */
export async function createGitRepo(base, files, name = 'skills.git') {
  const work = path.join(base, `${name}-work`)
  await fs.mkdir(work, { recursive: true })
  for (const [file, text] of Object.entries(files)) await put(path.join(work, file), text)
  git(work, 'init', '-q', '-b', 'main')
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'initial')
  const bare = path.join(base, name)
  git(base, 'clone', '-q', '--bare', work, bare)
  git(work, 'remote', 'add', 'origin', bare)
  return {
    work,
    bare,
    url: pathToFileURL(bare).href,
    head: () => git(work, 'rev-parse', 'HEAD'),
    async commit(changes, message = 'update') {
      for (const [file, text] of Object.entries(changes)) {
        if (text === null) await fs.rm(path.join(work, file), { recursive: true, force: true })
        else await put(path.join(work, file), text)
      }
      git(work, 'add', '-A')
      git(work, 'commit', '-q', '-m', message)
      git(work, 'push', '-q', 'origin', 'main')
      return git(work, 'rev-parse', 'HEAD')
    },
  }
}

/**
 * Copy a folder (for identical "already installed" copies).
 * @param {string} from - source folder.
 * @param {string} to - destination folder.
 */
export async function copyDir(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.cp(from, to, { recursive: true, verbatimSymlinks: true, filter: source => path.basename(source) !== '.git' })
}

/**
 * @param {string} dshHome - sandbox DSH home.
 * @returns {Promise<object | undefined>} the parsed repository state file, or `undefined` when absent.
 */
export async function readState(dshHome) {
  try {
    return JSON.parse(await fs.readFile(path.join(dshHome, 'mcp-skills', 'state.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}
