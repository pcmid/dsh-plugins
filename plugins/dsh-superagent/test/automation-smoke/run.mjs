// node plugins/dsh-superagent/test/automation-smoke/run.mjs — installed macOS Desktop, offline.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workerPersona,workerPreset } from './worker-tool.mjs'

const contents = join(process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app', 'Contents')
const runtime = join(contents, 'Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh')
const electron = join(contents, 'MacOS/DeepSeek Harness')
const temp = realpathSync(tmpdir()), root = mkdtempSync(join(temp, 'superagent-auto-'))
try {
  const home = join(root, 'home'), dsh = join(home, '.dsh'), work = join(root, 'work'), tmp = join(root, 'tmp')
  const profile = join(dsh, 'profiles', 'smoke')
  for (const dir of [profile, work, tmp]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const name of ['host','cordis.patch.yml','test/automation-smoke','node_modules/zod']) {
    cpSync(fileURLToPath(new URL('../../' + name, import.meta.url)), join(root, name), { recursive: true, dereference: true })
  }
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private:true, dsh:{profile:{bundles:[]}} }))
  const row = (pkg, config, id = pkg) => ({ id, name: '@deepseek-ai/dsh-' + pkg, ...(config && {config}) })
  const rows = ['llm','session','agent','tools','tool-executor-native','user-approval','system-prompt','working-directory','session-projection',
    'storage','attachment-local','workspace','api-remote-access','typert-registry','typert-loader','api-gateway',
    'commands','client-file-upload','api-session-controller','fs-local','config-editor'].map(pkg => row(pkg))
  rows.push(row('session-persistence-jsonl', {root:join(dsh,'sessions')}), row('session-query-sqlite', {path:':memory:',openAt:'never'}),
    row('storage-json', {root:join(dsh,'storages')}), row('storage-domain', {backend:'json'}),
    row('agent-loop', {agents:[]}), row('agent-preset-registry', {default:'default-fixture'}),
    row('agent-default-model', {provider:'offline',model:'global'}),
    row('agent-preset',{id:'default-fixture',plugins:[{name:join(root,'test/automation-smoke/preset-tool.mjs')}]},'preset-default-fixture'),
    row('agent-preset',{id:workerPreset,plugins:[row('persona',{prefix:workerPersona}),{name:join(root,'test/automation-smoke/worker-tool.mjs')}]},'preset-fixture-developer'),
    {id:'fixture',name:join(root,'test/automation-smoke/fixture.mjs')})
  // Let the native profile loader mount the shipped preset declarations. Only the fixture may start the Host.
  // This minimal Host has no shell, search, web, skill or compaction services, so the shipped presets keep
  // only their persona here; their tool plugins are checked on the full Desktop Host.
  const personaOnly=text=>{
    let skip=false
    return text.split('\n').filter(line=>{
      const indent=line.search(/\S/)
      if(indent===10 && line.trimStart().startsWith('- ')) skip=!/^ {10}- id: persona$/.test(line)
      else if(indent>=0 && indent<10) skip=false
      return !skip
    }).join('\n')
  }
  const declarations=personaOnly(readFileSync(join(root,'cordis.patch.yml'),'utf8'))
  assert.equal((declarations.match(/^ {10}- id: persona$/gm) ?? []).length,3,'each shipped preset keeps its persona')
  assert.doesNotMatch(declarations,/dsh-tool-|dsh-skill-|cordis:group|!!js/)
  const patch='- insert: '+JSON.stringify(rows)+'\n'+declarations+'\n- id: pcmid-superagent\n  disabled: true\n'
  const patchPath=join(profile,'cordis.patch.yml')
  writeFileSync(patchPath, patch)
  const policy = '(version 1)(allow default)(deny network*)(deny file-read* (subpath (param "PRIVATE_HOME")))'
    + '(deny file-write*)(allow file-write* (subpath (param "TEMP_ROOT")) (literal "/dev/null"))'
    + '(deny process-exec)(allow process-exec (literal (param "DSH_RUNTIME")))'
  for(const phase of ['prepare','release']) {
    const child = spawnSync('/usr/bin/sandbox-exec', ['-D', 'PRIVATE_HOME=' + realpathSync(homedir()), '-D', 'TEMP_ROOT=' + root,
      '-D', 'DSH_RUNTIME=' + electron, '-p', policy, electron, '--expose-internals', join(runtime,'lib/bin.js'), '--profile','smoke'], {
      cwd:work, encoding:'utf8', timeout:30_000, killSignal:'SIGKILL',
      env:{ELECTRON_RUN_AS_NODE:'1', SMOKE_INSTALL:join(runtime,'package.json'), SMOKE_PHASE:phase, HOME:home, USER:'smoke', LOGNAME:'smoke',
        DSH_HOME:dsh, DSH_PROFILE:'smoke', DSH_PROFILE_DIR:profile, TMPDIR:tmp, PATH:tmp},
    })
    if (child.error) throw child.error
    assert.equal(child.status, 0, child.stderr + child.stdout)
    assert.ok(child.stdout.includes('PASS automation: '+phase), child.stderr + child.stdout)
    assert.equal(readFileSync(patchPath, 'utf8'), patch, 'must not change profile-wide model or preset settings')
    console.log(child.stdout.trim())
  }
} finally {
  assert.equal(realpathSync(dirname(root)), temp)
  assert.match(basename(root), /^superagent-auto-[a-zA-Z0-9]+$/)
  rmSync(root, {recursive:true})
}
