// Test-only resolution of the packages the Harness provides at runtime.
// Each package resolves from its *_ENTRY variable, then from a DSH source checkout beside this
// plugin or its repository, then through ordinary resolution.
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const checkouts = ['../../deepseek-harness', '../../../../deepseek-harness']

function locate(variable, relative) {
  if (process.env[variable] !== undefined) return process.env[variable]
  return checkouts
    .map(root => fileURLToPath(new URL(`${root}/${relative}`, import.meta.url)))
    .find(path => existsSync(path))
}

const entries = {
  '@deepseek-ai/schemastery': locate('SCHEMASTERY_ENTRY', 'vendor/schemastery/lib/index.mjs'),
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const entry = entries[specifier]
    if (entry !== undefined) return { url: pathToFileURL(entry).href, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
