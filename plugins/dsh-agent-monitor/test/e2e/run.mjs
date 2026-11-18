#!/usr/bin/env node
/**
 * End-to-end check of the Host half of @pcmid/dsh-agent-monitor against a Harness.
 *
 * Boots the `web` profile in a temporary DSH_HOME with this plugin and the
 * scripted fixture linked into it. The fixture's conversation has a goal and
 * delegates two subagents: `server` starts a background command that never
 * ends and ends its turn, and `tester` runs a foreground command. While that
 * command runs, the check signs in as the browser does and asks the plugin's
 * route what the agents are doing.
 *
 * A Harness that keeps a subagent loaded for its background job lists
 * `server` as waiting, with that job. One that unloads an idle subagent, such
 * as 0.2.2-rc.3, lists only `tester`. The check tells the two apart by what
 * the conversation's agent was told about `server`.
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
const ROOT = mkdtempSync(join(tmpdir(), 'agent-monitor-e2e-'))
const HOME = join(ROOT, 'home')
const WORK = join(ROOT, 'work')
const RECORD = join(ROOT, 'requests.jsonl')
/** Commands no other process on the machine runs, so that `pkill` finds only the fixture's. */
const SERVER = `sleep ${40_000 + process.pid}`
const TESTS = `sleep ${50_000 + process.pid}`
const ROUTE = '/api/pcmid/agent-monitor/snapshot'
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

async function waitFor(what, read, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = read()
    if (found !== undefined && found !== false) return found
    if (child.exitCode !== null) throw new Error(`boot exited while waiting for ${what}\n${child.output}`)
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${what}\n${JSON.stringify(records().map(r => [r.role, r.action]))}\n${child.output}`)
}

/** Sign in with the launch link, as the browser does, and return the session cookie. */
async function signIn(url) {
  const response = await fetch(url, { redirect: 'manual' })
  assert.equal(response.status, 303, 'the launch link answers with a redirect')
  const cookie = response.headers.getSetCookie().map(line => line.split(';', 1)[0]).join('; ')
  assert.notEqual(cookie, '', 'the launch link sets the session cookie')
  return cookie
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
    '- insert:',
    '    - id: agent-monitor-fixture',
    "      name: '@pcmid-test/agent-monitor-fixture'",
    `      config: ${JSON.stringify({ record: RECORD, cwd: WORK, server: SERVER, tests: TESTS })}`,
    '',
  ].join('\n'))
  child = run(['--profile', 'web', '--patch', patch, '--no-open', '--port', '0'])

  const launch = await waitFor('the Web address', () => /dsh web: (http\S+)/.exec(child.output)?.[1], child)
  const created = await waitFor('the fixture conversation', () => records().find(r => r.created || r.error), child)
  if (created.error) throw new Error(created.error)
  const lead = created.created
  // The tester's command is in flight, the server's turn has ended, and the lead was told about the server.
  const keeps = await waitFor('the agents to be at work', () => {
    const all = records()
    const told = all.filter(r => r.role === 'lead').flatMap(r => r.users)
    const kept = told.some(text => text.startsWith('Background subagent server ended its turn. Work it started is still running.'))
    const ended = told.some(text => text.startsWith('Background subagent server finished'))
    if (!all.some(r => r.role === 'tester' && Array.isArray(r.action)) || !(kept || ended)) return undefined
    // The answer is an object so that `false` is not mistaken for "not yet".
    return { kept }
  }, child)
  // The lead's turn for that notice has ended: its answer is in the record. Give the Host a moment to close the turn.
  await waitFor('the lead to be idle', () => records().filter(r => r.role === 'lead').at(-1)?.action === 'The server and the tester are at work.', child)
  await sleep(1500)

  const origin = new URL(launch).origin
  const cookie = await signIn(launch)
  let calls = 0
  const post = async (body, headers = { cookie }) => {
    const response = await fetch(`${origin}${ROUTE}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() }
  }
  const ask = async (sessionId) => {
    const rpcId = `e2e-${calls += 1}`
    const answer = await post({ type: 'client-request', rpcId, payload: { sessionId } })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.type, 'server-response')
    assert.equal(answer.body.rpcId, rpcId)
    assert.equal(answer.body.result.ok, true, JSON.stringify(answer.body.result))
    return answer.body.result.value.agents
  }

  const agents = await ask(lead)
  const names = agents.map(row => row.name)
  assert.deepEqual(names, keeps.kept ? ['', 'server', 'tester'] : ['', 'tester'], `agents listed: ${JSON.stringify(agents)}`)
  const [self] = agents
  const tester = agents.at(-1)
  const testerId = records().find(r => r.role === 'tester').sessionId

  // The conversation's own agent: stopped, with loaded subagents, and its goal held back by them.
  assert.equal(self.id, lead)
  assert.equal(self.depth, 0)
  assert.equal(self.state, 'waiting')
  assert.equal(self.subagents, agents.length - 1)
  assert.deepEqual(self.jobs, [])
  assert.equal(self.goalWaiting, true, 'the armed goal waits for the subagents')
  assert.equal(typeof self.since, 'number')
  assert.equal(self.label, undefined)

  // The tester: its foreground command is the call in flight, and is not listed as a background job.
  assert.equal(tester.id, testerId)
  assert.equal(tester.depth, 1)
  assert.equal(tester.label, 'Run the test suite')
  assert.equal(tester.state, 'running')
  assert.deepEqual(tester.activity, { tool: 'bash', summary: TESTS })
  assert.deepEqual(tester.jobs, [], 'a command that still runs in the foreground is not a background job')
  assert.equal(tester.subagents, 0)
  assert.equal(typeof tester.since, 'number')
  assert.equal(tester.goalWaiting, undefined)

  if (keeps.kept) {
    // The server: its turn ended, and it stays loaded for the command it started.
    const server = agents[1]
    assert.equal(server.depth, 1)
    assert.equal(server.label, 'Start the dev server')
    assert.equal(server.state, 'waiting')
    assert.equal(server.activity, undefined)
    assert.equal(server.jobs.length, 1)
    const [{ startedAt, ...job }] = server.jobs
    assert.deepEqual(job, { kind: 'bash', label: SERVER, status: 'running' })
    assert.equal(typeof startedAt, 'number')
    assert.equal(typeof server.since, 'number')
  }

  // A subagent viewed as the session: itself first, without a name or a label.
  const own = await ask(testerId)
  assert.deepEqual(own.map(row => [row.id, row.depth, row.name, row.label, row.state]), [[testerId, 0, '', undefined, 'running']])
  assert.equal(own[0].goalWaiting, undefined)

  // A session without a loaded agent, a request that is not the RPC envelope, and a request without the session cookie.
  assert.deepEqual(await ask('no-such-session'), [])
  const malformed = await post({ type: 'client-request', rpcId: 'e2e-bad', payload: {} })
  assert.equal(malformed.status, 200)
  assert.equal(malformed.body.result.ok, false)
  assert.equal(malformed.body.result.error.code, 'bad-request')
  const stranger = await post({ type: 'client-request', rpcId: 'e2e-anon', payload: { sessionId: lead } }, {})
  assert.equal(stranger.status, 401, `a request without the session cookie: ${JSON.stringify(stranger)}`)

  child.kill('SIGTERM')
  const exit = await Promise.race([child.exited, sleep(15_000).then(() => undefined)])
  if (exit === undefined) throw new Error(`boot did not exit after SIGTERM\n${child.output}`)
  console.log(`ok   agent-monitor e2e ${JSON.stringify({ keepsSubagents: keeps.kept, agents: agents.map(row => `${row.name === '' ? '(session)' : row.name}:${row.state}`) })}`)
} catch (error) {
  process.exitCode = 1
  console.log(`FAIL agent-monitor e2e: ${error.stack ?? error}`)
} finally {
  if (child !== undefined && child.exitCode === null) {
    child.kill('SIGKILL')
    await child.exited
  }
  spawnSync('pkill', ['-f', SERVER])
  spawnSync('pkill', ['-f', TESTS])
  if (process.env.KEEP_E2E) console.log(`kept ${ROOT}`)
  else rmSync(ROOT, { recursive: true, force: true })
}
