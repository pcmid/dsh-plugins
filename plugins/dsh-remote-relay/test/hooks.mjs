// Test-only resolution of the schemastery package the Harness provides at runtime.
// Order: SCHEMASTERY_ENTRY, then a DSH source checkout beside this plugin or its repository,
// then ordinary resolution (the package's devDependency after `npm install`).
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const checkoutEntry = ['../../deepseek-harness', '../../../../deepseek-harness']
  .map(root => fileURLToPath(new URL(`${root}/vendor/schemastery/lib/index.mjs`, import.meta.url)))
  .find(path => existsSync(path))
const entry = process.env.SCHEMASTERY_ENTRY ?? checkoutEntry

if (entry !== undefined) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@deepseek-ai/schemastery') return { url: pathToFileURL(entry).href, shortCircuit: true }
      return nextResolve(specifier, context)
    },
  })
}
