// The DSH browser loader consumes one factory; ship its CSS and modules together.
import { readFile, writeFile } from 'node:fs/promises'
const root = new URL('../', import.meta.url)
const read = name => readFile(new URL(name, root), 'utf8')
const {name} = JSON.parse(await read('package.json'))
const src = names => Promise.all(names.map(name => read('src/' + name)))
const styles = await src(['base.css','theme.css','edition.css','team-settings.css'])
const modules = await src(['role-menu.js','roles.js','work-steps.js','edition.js','runtime.js'])
const code = [
  '// Generated from src by scripts/build-client.mjs.',
  'window.__ModuleLoader__.load({ id: ' + JSON.stringify(name) + ', factory(require) {',
  '"use strict"; const React = require("react"), h = React.createElement;',
  'const css = ' + JSON.stringify(styles.join('\n')) + ';',
  ...modules,
  "return { inject: ['slots','locale','connection','uiWorkspace','remote','remote.agentPresets'], apply: applySuperagent };",
  '} });', '',
].join('\n')
if (process.argv.includes('--check')) {
  if (await read('client.js') !== code) throw Error('Stale client bundle: npm run build')
} else await writeFile(new URL('client.js', root), code)
