#!/usr/bin/env node
/**
 * End-to-end check of @pcmid/dsh-async-agents against a Harness.
 *
 * Boots the `web` profile in a temporary DSH_HOME with this plugin and the
 * scripted fixture linked into it, and lets one subagent be loaded at a time.
 * The fixture's conversation delegates a `server` subagent, which starts a
 * background command that never ends and ends its turn.
 *
 * What follows depends on the Harness, and the fixture reports which it is:
 *
 * - One that keeps the subagent loaded for its job and can close a subagent.
 *   The subagent must have the four changes. The lead's next delegation fails
 *   at the limit and must carry the hint; `close_agent` must unload the
 *   subagent and stop its command; the delegation must then succeed, and the
 *   `tester` subagent must report.
 * - One that cannot, such as 0.2.2-rc.3. The subagent must be as the Harness
 *   made it, the lead must have the changes of version 0.1.0 and no
 *   `close_agent`, and the lead must be told when the subagent has ended.
 *
 * The Harness CLI is the installed Desktop runtime unless DSH_APP names
 * another application bundle or DSH_CLI names a `dsh` executable.
 *
 * Usage: node test/e2e/run.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const PLUGIN = fileURLToPath(new URL('../..', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./fixture', import.meta.url))
const APP = join(process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app', 'Contents')
const ROOT = mkdtempSync(join(tmpdir(), 'async-agents-e2e-'))
const HOME = join(ROOT, 'home')
const WORK = join(ROOT, 'work')
const RECORD = join(ROOT, 'requests.jsonl')
/** A command no other process on the machine runs, so that `pgrep` finds only the subagent's. */
const SERVER = `sleep ${40_000 + process.pid}`
const WAIT_DESCRIPTION = 'Foreground wait in milliseconds: defaults to 10000, capped at 60000. On expiry the command moves to the background as a job instead of being killed.'
const JOBS_REWRITTEN = 'When only waiting for a job remains, end your turn instead of sleeping or polling; its completion notice starts a new turn.'
const JOBS_ORIGINAL = 'set wait: true only when you are genuinely blocked on it'
mkdirSync(WORK, { recursive: true })
writeFileSync(RECORD, '')

function command(args) {
  if (process.env.DSH_CLI) return { file: process.env.DSH_CLI, args, env: {} }
  return {
    file: join(APP, 'MacOS', 'DeepSeek Harness'),
    args: ['--expose-internals', join(APP, 'Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'), ...args],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }
}

function run(args) {
  const { file, args: argv, env } = command(args)
  // The fixture's commands run without an approval prompt, which nothing here could answer.
  const child = spawn(file, argv, {
    cwd: WORK,
    env: { ...process.env, ...env, DSH_HOME: HOME, DSH_PERMISSION_MODE: 'danger-full-access' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.output = ''
  child.stdout.on('data', (chunk) => { child.output += chunk })
  child.stderr.on('data', (chunk) => { child.output += chunk })
  child.exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })))
  return child
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const records = () => readFileSync(RECORD, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
const serverRuns = () => spawnSync('pgrep', ['-f', SERVER]).status === 0

async function waitFor(what, predicate, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = records().find(predicate)
    if (found !== undefined) return found
    if (child.exitCode !== null) throw new Error(`boot exited while waiting for ${what}\n${child.output}`)
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${what}\n${JSON.stringify(records().map(r => [r.role, r.action]))}\n${child.output}`)
}

/** Whether a request is one in which a role gave the answer that ends its turn. */
const answered = (role, answer) => r => r.role === role && r.action === answer

/** The four changes, as one request of an agent shows them. */
function assertChanged(request, who) {
  assert.ok(!request.tools.includes('wait_agent'), `${who} has no wait_agent`)
  assert.deepEqual(request.jobOutputParameters, ['job_id'], `${who} cannot wait in job_output`)
  assert.equal(request.bashWait, WAIT_DESCRIPTION, `${who} has the short bash wait`)
  assert.ok(request.system.includes(JOBS_REWRITTEN) && !request.system.includes(JOBS_ORIGINAL), `${who} is told to end its turn`)
}

function assertAsTheHarnessMadeIt(request, who) {
  assert.ok(request.tools.includes('wait_agent'), `${who} keeps wait_agent`)
  assert.ok(request.jobOutputParameters.includes('wait'), `${who} can wait in job_output`)
  assert.notEqual(request.bashWait, WAIT_DESCRIPTION, `${who} keeps the Harness bash wait`)
  assert.ok(request.system.includes(JOBS_ORIGINAL) && !request.system.includes(JOBS_REWRITTEN), `${who} keeps the Harness guidance`)
  assert.ok(!request.tools.includes('close_agent'), `${who} has no close_agent`)
}

let child
try {
  const install = run(['plugin', '--profile', 'web', 'add', `link:${PLUGIN}`, `link:${FIXTURE}`])
  const installed = await install.exited
  if (installed.code !== 0) throw new Error(`plugin install failed\n${install.output}`)

  const patch = join(ROOT, 'boot.yml')
  writeFileSync(patch, [
    '- id: hmr',
    '  disabled: true',
    '- id: session-title-llm',
    '  disabled: true',
    '- id: subagent',
    '  config:',
    '    maxActiveSubagents: 1',
    '- insert:',
    '    - id: async-agents-fixture',
    "      name: '@pcmid-test/async-agents-fixture'",
    `      config: ${JSON.stringify({ record: RECORD, cwd: WORK, server: SERVER })}`,
    '',
  ].join('\n'))
  child = run(['--profile', 'web', '--patch', patch, '--no-open', '--port', '0'])

  const created = await waitFor('the fixture conversation', r => r.created || r.error, child)
  if (created.error) throw new Error(created.error)
  const { closes } = created
  await waitFor('the last answer of the lead', answered('lead', 'All done.'), child)
  await sleep(1000)

  const all = records()
  const lead = all.filter(r => r.role === 'lead')
  const server = all.filter(r => r.role === 'server')
  const tester = all.filter(r => r.role === 'tester')
  /** Everything the lead was sent, and every call it made with its result, as its last request holds them. */
  const told = lead.at(-1).users.map(user => user.text)
  const called = lead.at(-1).calls
  assert.equal(all.filter(r => r.role === 'unknown').length, 0, 'every request belongs to a scripted role')
  assert.ok(lead[0].tools.includes('subagent') && lead[0].tools.includes('list_agents'), `tools of the lead: ${lead[0].tools}`)
  assertChanged(lead[0], 'the lead')
  const [background] = server.at(-1).calls
  assert.ok(!background.result.isError && /job/.test(background.result.text), `the server command: ${JSON.stringify(background.result)}`)

  if (closes) {
    assert.ok(lead[0].tools.includes('close_agent'), 'the lead has close_agent')
    for (const request of server) assertChanged(request, 'the server subagent')
    assert.ok(server[0].tools.includes('close_agent'), 'a subagent that has list_agents has close_agent too')

    const report = told.find(text => text.startsWith('Background subagent server ended its turn. Work it started is still running.'))
    assert.ok(report?.includes(`- background job (bash: ${SERVER})`), `the report of the kept server: ${report}`)

    const delegations = called.filter(call => call.name === 'subagent' && call.args.name === 'tester')
    assert.equal(delegations.length, 2, 'the lead delegates the tester twice')
    const [refused, accepted] = delegations
    assert.ok(refused.result.isError, 'the delegation at the limit fails')
    assert.match(refused.result.text, /subagent limit reached \(active child limit: 1\)/)
    assert.ok(
      refused.result.text.endsWith('\n\nIdle subagents you can close with close_agent to free a slot: server. Closing one cancels the background jobs it started.'),
      `the hint: ${refused.result.text}`,
    )

    const closed = called.filter(call => call.name === 'close_agent')
    assert.deepEqual(closed.map(call => call.result), [{ isError: false, text: `closed server; cancelled background job (bash: ${SERVER})` }])
    assert.ok(!serverRuns(), 'closing the subagent stopped its command')
    assert.ok(told.some(text => text.startsWith('Background subagent server was stopped before it finished.')), 'the lead is told the server was stopped')

    assert.ok(!accepted.result.isError && /tester/.test(accepted.result.text), `the delegation after the close: ${JSON.stringify(accepted.result)}`)
    for (const request of tester) assertChanged(request, 'the tester subagent')
    assert.match(tester.at(-1).calls[0].result.text, /tests passed/)
    assert.ok(told.some(text => text.startsWith('Background subagent tester finished') && text.endsWith('The tests pass.')), 'the lead gets the tester\'s answer')
  } else {
    assert.ok(!lead[0].tools.includes('close_agent'), 'the lead has no close_agent')
    for (const request of server) assertAsTheHarnessMadeIt(request, 'the server subagent')
    assert.ok(told.some(text => text.startsWith('Background subagent server finished')), 'the lead is told the server has ended')
    assert.equal(tester.length, 0, 'the lead delegates once')
  }

  child.kill('SIGTERM')
  const exit = await Promise.race([child.exited, sleep(15_000).then(() => undefined)])
  if (exit === undefined) throw new Error(`boot did not exit after SIGTERM\n${child.output}`)
  assert.ok(!serverRuns(), 'no command of the fixture outlives the Harness')
  console.log(`ok   async-agents e2e ${JSON.stringify({ closes, requests: all.length - 1, lead: lead.map(r => Array.isArray(r.action) ? `${r.action[0]}(${r.action[1].name ?? r.action[1].agent})` : r.action) })}`)
} catch (error) {
  process.exitCode = 1
  console.log(`FAIL async-agents e2e: ${error.stack ?? error}`)
} finally {
  if (child !== undefined && child.exitCode === null) {
    child.kill('SIGKILL')
    await child.exited
  }
  spawnSync('pkill', ['-f', SERVER])
  if (process.env.KEEP_E2E) console.log(`kept ${ROOT}`)
  else rmSync(ROOT, { recursive: true, force: true })
}
