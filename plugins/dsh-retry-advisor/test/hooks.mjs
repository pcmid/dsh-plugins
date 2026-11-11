// Test-only resolution of the packages the Harness provides at runtime.
// Each package resolves from its *_ENTRY variable, then from a DSH source checkout beside this
// plugin or its repository (dsh-session needs `pnpm run build:artifacts` there), then through
// ordinary resolution (the package's devDependencies after `npm install`).
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
  '@deepseek-ai/dsh-session': locate('DSH_SESSION_ENTRY', 'packages/core/session/lib/index.js'),
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const entry = entries[specifier]
    if (entry !== undefined) return { url: pathToFileURL(entry).href, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
