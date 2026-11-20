// node plugins/dsh-superagent/test/smoke/run.mjs — installed Desktop rc.3, no network or installs.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const contents = join(process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app', 'Contents')
const runtime = join(contents, 'Resources/app.asar/dsh/node_modules/@deepseek-ai')
const electron = join(contents, 'MacOS/DeepSeek Harness')
const temp = realpathSync(tmpdir())
const root = mkdtempSync(join(temp, 'superagent-host-'))
try {
  const home = join(root, 'home'), dsh = join(home, '.dsh'), work = join(root, 'work')
  const profile = join(dsh, 'profiles', 'smoke')
  for (const dir of [profile, work, join(root, 'tmp')]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Copy only the code under test so Seatbelt can deny reads of the entire real home.
  for (const [source, target] of [['./fixture.mjs','test/smoke/fixture.mjs'], ['../../host/executor.js','host/executor.js'],
    ['../../../dsh-workspace-agent-preset/route.js','workspace-route.mjs']]) {
    const copy = join(root, target)
    mkdirSync(dirname(copy), { recursive: true })
    copyFileSync(fileURLToPath(new URL(source, import.meta.url)), copy)
  }
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  const policy = '(version 1)(allow default)(deny network*)(deny file-read* (subpath (param "PRIVATE_HOME")))'
    + '(deny file-write*)(allow file-write* (subpath (param "TEMP_ROOT")) (literal "/dev/null"))'
  const row = (pkg, config, id = pkg) => ({ id, name: '@deepseek-ai/dsh-' + pkg, ...(config && { config }) })
  const patch = JSON.stringify([{ insert: [
    ...['llm','session','agent','tools','tool-executor-native','system-prompt','working-directory','session-projection',
      'storage','attachment-local','workspace','api-remote-access','typert-registry','typert-loader','api-gateway',
      'commands','client-file-upload','api-session-controller','fs-local','config-editor'].map(pkg => row(pkg)),
    row('session-persistence-jsonl', { root: join(dsh, 'sessions') }),
    row('session-query-sqlite', { path: ':memory:', openAt: 'never' }),
    row('storage-json', { root: join(dsh, 'storages') }), row('storage-domain', { backend: 'json' }),
    row('agent-loop', { agents: [] }), row('agent-preset-registry', { default: 'other' }),
    row('agent-default-model', { provider: 'offline', model: 'global', reasoningEffort: 'low' }),
    ...['other','worker'].map(id => row('agent-preset', { id, plugins: [] }, 'preset-' + id)),
    { id: 'smoke', name: join(root, 'test/smoke/fixture.mjs') },
  ] }])
  const patchPath = join(profile, 'cordis.patch.yml')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }))
  writeFileSync(patchPath, patch)
  for (const step of ['create','resume']) {
    const child = spawnSync('/usr/bin/sandbox-exec', ['-D', 'PRIVATE_HOME=' + realpathSync(homedir()),
      '-D', 'TEMP_ROOT=' + root, '-p', policy, electron, '--expose-internals', join(runtime, 'dsh/lib/bin.js'), '--profile', 'smoke'], {
      cwd: work, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
      env: {
        HOME: home, USER: 'smoke', LOGNAME: 'smoke', DSH_HOME: dsh, DSH_PROFILE: 'smoke', DSH_PROFILE_DIR: profile,
        TMPDIR: join(root, 'tmp'), PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1',
        SMOKE_STEP: step, SMOKE_INSTALL: join(runtime, 'dsh/package.json'), SMOKE_WORKSPACE_ROUTE: join(root,'workspace-route.mjs'),
      },
    })
    if (child.error) throw child.error
    assert.equal(child.status, 0, child.stderr + child.stdout)
    assert.ok(child.stdout.includes('PASS ' + step), child.stderr + child.stdout)
    assert.equal(readFileSync(patchPath, 'utf8'), patch, 'host settings/preset patch changed')
    console.log(child.stdout.trim())
  }
} finally {
  assert.equal(realpathSync(dirname(root)), temp)
  assert.match(basename(root), /^superagent-host-[a-zA-Z0-9]+$/)
  rmSync(root, { recursive: true })
}
