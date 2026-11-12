// Compile client/00-core.js plus the given parts as one factory body without
// running it, so a part can be syntax-checked while other parts are mid-edit.
//   node scripts/check-part.mjs 10-mcp.js
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const parts = ['00-core.js', ...process.argv.slice(2)]
const body = parts.map(name => readFileSync(join(root, 'client', name), 'utf8')).join('\n')
try {
  new vm.Script(`(function factory(require) {\n'use strict';\n${body}\n})`, { filename: parts.join('+') })
  console.log(`ok: ${parts.join(' + ')}`)
} catch (error) {
  console.error(error.stack ?? String(error))
  process.exit(1)
}
