// Evaluate client parts in a VM with a stub React so pure helpers can be unit
// tested. `names` lists top-level identifiers to return from the factory scope.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export function loadPart(parts, names) {
  const body = ['00-core.js', ...parts].map(name => readFileSync(join(root, 'client', name), 'utf8')).join('\n')
  const source = `(function factory(require) {\n'use strict';\n${body}\nreturn { ${names.join(', ')} };\n})`
  const stubReact = {
    createElement: () => null, Fragment: 'Fragment', forwardRef: fn => fn,
    useCallback: fn => fn, useEffect: () => {}, useId: () => 'id', useLayoutEffect: () => {}, useMemo: fn => fn(), useRef: v => ({ current: v }), useState: v => [v, () => {}],
  }
  const factory = vm.runInNewContext(source, { window: {}, CSS: { escape: s => s }, console, URL, JSON, Math, Date, Intl, structuredClone })
  return factory((id) => (id === 'react' ? stubReact : {}))
}
