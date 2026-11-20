// node plugins/dsh-superagent/test/settings-smoke/run.mjs — macOS Desktop rc.3. No installs.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const contents = join(process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app', 'Contents')
const runtime = join(contents, 'Resources/app.asar/dsh/node_modules/@deepseek-ai')
const electron = join(contents, 'MacOS/DeepSeek Harness')
const temp = realpathSync(tmpdir()), root = mkdtempSync(join(temp, 'superagent-settings-'))
try {
  const home = join(root, 'home'), dsh = join(home, '.dsh'), profile = join(dsh, 'profiles', 'smoke')
  const bundle = '@pcmid/dsh-superagent'
  const plugin = join(profile, 'node_modules', bundle), work = join(root, 'work')
  for (const dir of [profile, plugin, work, join(root, 'tmp')]) mkdirSync(dir, { recursive: true })
  // The workspace's already installed package dependencies are needed; never run a package manager here.
  for (const name of ['index.js','host','package.json','node_modules','cordis.patch.yml']) {
    cpSync(fileURLToPath(new URL('../../' + name, import.meta.url)), join(plugin, name), { recursive: true })
  }
  cpSync(fileURLToPath(new URL('./fixture.mjs', import.meta.url)), join(root, 'fixture.mjs'))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [bundle] } } }))
  const row = (pkg, config) => ({ id: pkg, name: '@deepseek-ai/dsh-' + pkg, ...(config && { config }) })
  const rows = ['config-editor','storage','session','session-projection','agent'].map(pkg => row(pkg))
  rows.push(row('storage-json', { root: join(dsh, 'storages') }), row('storage-domain', { backend: 'json' }),
    row('agent-preset-registry', { default: 'unused' }), row('agent-default-model', { provider: 'unused', model: 'keep-model' }),
    { id: 'fixture', name: join(root, 'fixture.mjs') })
  const patch = join(profile, 'cordis.patch.yml')
  writeFileSync(patch, '# Retain the unrelated settings\n' + JSON.stringify([{ insert: rows }]) + '\n')
  const policy = '(version 1)(allow default)(deny network*)(deny file-read* (subpath (param "PRIVATE_HOME")))'
    + '(deny file-write*)(allow file-write* (subpath (param "TEMP_ROOT")) (literal "/dev/null"))'
    + '(deny process-exec)(allow process-exec (literal (param "DSH_RUNTIME")) (literal (param "FIXTURE_CLI")))'
  const cliPath=join(work,'lark-cli')
  writeFileSync(cliPath,'#!/bin/sh\nexit 42\n',{mode:0o700}) // must never run when editing settings
  for (const step of ['save','reopen']) {
    const child = spawnSync('/usr/bin/sandbox-exec', ['-D', 'PRIVATE_HOME=' + realpathSync(homedir()), '-D', 'TEMP_ROOT=' + root,
      '-D', 'DSH_RUNTIME=' + electron, '-D', 'FIXTURE_CLI=' + cliPath, '-p', policy, electron, '--expose-internals', join(runtime, 'dsh/lib/bin.js'), '--profile', 'smoke'], {
      cwd: work, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
      env: { ELECTRON_RUN_AS_NODE: '1', SMOKE_INSTALL: join(runtime, 'dsh/package.json'), SMOKE_STEP: step, SMOKE_CLI_PATH: cliPath,
        HOME: home, USER: 'smoke', LOGNAME: 'smoke', DSH_HOME: dsh, DSH_PROFILE: 'smoke', DSH_PROFILE_DIR: profile,
        PATH: join(root, 'tmp'), TMPDIR: join(root, 'tmp') },
    })
    if (child.error) throw child.error
    assert.equal(child.status, 0, child.stderr + child.stdout)
    assert.ok(child.stdout.includes('PASS ' + step), child.stderr + child.stdout)
    assert.ok(readFileSync(patch, 'utf8').includes('# Retain the unrelated settings'))
    console.log(child.stdout.trim())
  }
} finally {
  assert.equal(realpathSync(dirname(root)), temp)
  assert.match(basename(root), /^superagent-settings-[a-zA-Z0-9]+$/)
  rmSync(root, { recursive: true })
}
