import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'

const invalid = () => Object.assign(new Error('invalid-cli-path'), {code:'invalid-cli-path'})

// Pass a single executable to spawn/execFile, never a command line.
export function cliExecutable(path) {
  if (path === undefined || path === '') return 'lark-cli'
  if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f\x7f]/u.test(path) ||
      basename(path) !== (process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli')) throw invalid()
  return path
}

export async function validateCliPath(input) {
  if (typeof input !== 'string') throw invalid()
  const path = input.trim()
  cliExecutable(path)
  if (path) {
    try {
      if (!(await stat(path)).isFile()) throw invalid()
      await access(path, constants.X_OK)
    } catch { throw invalid() }
  }
  return path
}
