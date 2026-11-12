// Test-only resolution of the schemastery package the Harness provides at runtime.
// Order: SCHEMASTERY_ENTRY, then `deepseek-harness/vendor/schemastery` beside any ancestor of this plugin
// (a DSH source checkout next to the repository or its worktrees), then ordinary resolution.
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

function findCheckoutEntry() {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = path.join(dir, 'deepseek-harness', 'vendor', 'schemastery', 'lib', 'index.mjs')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

const entry = process.env.SCHEMASTERY_ENTRY ?? findCheckoutEntry()

if (entry !== undefined) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@deepseek-ai/schemastery') return { url: pathToFileURL(entry).href, shortCircuit: true }
      return nextResolve(specifier, context)
    },
  })
}
