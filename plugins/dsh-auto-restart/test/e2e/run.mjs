#!/usr/bin/env node
/**
 * End-to-end check of @pcmid/dsh-auto-restart against an installed Harness.
 *
 * Boots the `web` profile in a temporary DSH_HOME with this plugin and the
 * scripted fixture linked into it, stops the process while a turn runs, boots
 * it again, and reads the model requests, the candidate file, and the Session
 * logs. The Harness CLI is the installed Desktop runtime unless DSH_CLI names
 * another `dsh` executable.
 *
 * Usage: node test/e2e/run.mjs [graceful|crash|loop|subagent|goal ...]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import assert from 'node:assert/strict'

const PLUGIN = fileURLToPath(new URL('../..', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./fixture', import.meta.url))
const DESKTOP = '/Applications/DeepSeek Harness.app/Contents'
const ROOT = mkdtempSync(join(tmpdir(), 'auto-restart-e2e-'))
const HOME = join(ROOT, 'home')
const WORK = join(ROOT, 'work')
const RECORD = join(ROOT, 'requests.jsonl')
const STATE = join(HOME, 'auto-restart', 'web.json')
mkdirSync(WORK, { recursive: true })
writeFileSync(RECORD, '')

function command(args) {
  if (process.env.DSH_CLI) return { file: process.env.DSH_CLI, args, env: {} }
  return {
    file: join(DESKTOP, 'MacOS', 'DeepSeek Harness'),
    args: ['--expose-internals', join(DESKTOP, 'Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'), ...args],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }
}

const live = new Set()

function run(args, options = {}) {
  const { file, args: argv, env } = command(args)
  const child = spawn(file, argv, { cwd: WORK, env: { ...process.env, ...env, DSH_HOME: HOME }, stdio: ['ignore', 'pipe', 'pipe'], ...options })
  child.output = ''
  child.stdout.on('data', (chunk) => { child.output += chunk })
  child.stderr.on('data', (chunk) => { child.output += chunk })
  live.add(child)
  child.exited = new Promise(resolve => child.on('exit', (code, signal) => { live.delete(child); resolve({ code, signal }) }))
  return child
}

/** Kill every boot a failed scenario left running. */
async function killAll() {
  const running = [...live]
  for (const child of running) child.kill('SIGKILL')
  await Promise.all(running.map(child => child.exited))
}

let boots = 0
/** Boot the web profile with one fixture phase. */
function boot(phase, fixture = {}) {
  const patch = join(ROOT, `boot-${++boots}.yml`)
  const fixtureConfig = { phase, record: RECORD, cwd: WORK, ...fixture }
  writeFileSync(patch, [
    '- id: hmr',
    '  disabled: true',
    '- id: session-title-llm',
    '  disabled: true',
    '- id: auto-restart',
    `  config: ${JSON.stringify({ startDelaySeconds: 1 })}`,
    '- insert:',
    '    - id: auto-restart-fixture',
    "      name: '@pcmid-test/auto-restart-fixture'",
    `      config: ${JSON.stringify(fixtureConfig)}`,
    '',
  ].join('\n'))
  const child = run(['--profile', 'web', '--patch', patch, '--no-open', '--port', '0'])
  child.phase = phase
  return child
}

async function stop(child, signal) {
  child.kill(signal)
  const result = await Promise.race([child.exited, sleep(15_000).then(() => undefined)])
  if (result === undefined) {
    child.kill('SIGKILL')
    throw new Error(`boot ${child.pid} did not exit after ${signal}\n${child.output}`)
  }
  return result
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function records() {
  return readFileSync(RECORD, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

async function waitFor(what, predicate, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = records().find(predicate)
    if (found !== undefined) return found
    if (child.exitCode !== null) throw new Error(`boot exited while waiting for ${what}\n${child.output}`)
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${what}\n${child.output}`)
}

function state() {
  return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')).sessions : {}
}

function sessionLog(id) {
  const base = join(HOME, 'sessions')
  for (const workspace of readdirSync(base)) {
    const dir = join(base, workspace, id)
    if (!existsSync(dir)) continue
    const file = readdirSync(dir).find(name => name.startsWith('session.') && (name.endsWith('.zstd') || name.endsWith('.jsonl')))
    const raw = readFileSync(join(dir, file))
    const text = file.endsWith('.zstd') ? zlib.zstdDecompressSync(raw).toString() : raw.toString()
    return text.split('\n').filter(Boolean).slice(1).map(line => JSON.parse(line))
  }
  throw new Error(`no stored log for ${id}`)
}

const lastTurnEnd = id => sessionLog(id).findLast(event => event.type === 'turn/end')?.data.reason
const notices = (id, pid) => records().filter(r => r.sessionId === id && (pid === undefined || r.pid === pid)
  && r.users?.some(user => user.kind === 'auto-restart'))

/** Start a conversation whose first request stays open; returns its Session id. */
async function startRunning(fixture) {
  const child = boot('start', fixture)
  const created = await waitFor('the fixture conversation', r => r.pid === child.pid && (r.created || r.error), child)
  if (created.error) throw new Error(created.error)
  await waitFor('its first model request', r => r.pid === child.pid && r.sessionId === created.created, child)
  return { child, id: created.created }
}

async function continued(id, phase = 'continue', fixture) {
  const child = boot(phase, fixture)
  const request = await waitFor('the continuation notice', r => r.pid === child.pid && r.sessionId === id && r.users?.some(u => u.kind === 'auto-restart'), child)
  return { child, request, notice: request.users.findLast(u => u.kind === 'auto-restart') }
}

async function settle(id, child) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (state()[id] === undefined) return
    await sleep(200)
  }
  throw new Error(`candidate ${id} stayed after the continued turn\n${child.output}`)
}

const scenarios = {
  async graceful() {
    const { child, id } = await startRunning()
    const exit = await stop(child, 'SIGTERM')
    assert.equal(exit.code, 0, child.output)
    assert.deepEqual(lastTurnEnd(id), { kind: 'aborted', reason: { kind: 'disposed' } })
    assert.deepEqual(state()[id], { root: true, children: [] })
    const next = await continued(id)
    assert.equal(next.notice.attempt, 1)
    assert.match(next.notice.text, /was shut down while you were working/)
    await settle(id, next.child)
    await stop(next.child, 'SIGTERM')
    assert.deepEqual(lastTurnEnd(id), { kind: 'completed' })
    assert.equal(notices(id).length, 1)
    return { id, tools: records().find(r => r.sessionId === id)?.tools }
  },

  async crash() {
    const { child, id } = await startRunning()
    await stop(child, 'SIGKILL')
    assert.deepEqual(state()[id], { root: true, children: [] })
    const next = await continued(id)
    assert.match(next.notice.text, /stopped unexpectedly/)
    await settle(id, next.child)
    await stop(next.child, 'SIGTERM')
    const log = sessionLog(id)
    assert.ok(log.some(event => event.type === 'turn/end' && event.data.reason.kind === 'interrupted'), 'crash closer stored')
    assert.deepEqual(lastTurnEnd(id), { kind: 'completed' })
    return { id }
  },

  async loop() {
    const { child, id } = await startRunning()
    await stop(child, 'SIGKILL')
    for (const attempt of [1, 2, 3]) {
      const next = await continued(id, 'hang')
      assert.equal(next.notice.attempt, attempt)
      if (attempt > 1) assert.match(next.notice.text, new RegExp(`automatic continuation ${attempt} in a row`))
      await stop(next.child, 'SIGKILL')
    }
    const last = boot('hang')
    // The fourth boot judges the candidate and drops it without sending a notice.
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && state()[id] !== undefined) await sleep(200)
    assert.equal(state()[id], undefined, `candidate ${id} was not dropped\n${last.output}`)
    await sleep(1500)
    assert.equal(notices(id, last.pid).length, 0)
    await stop(last, 'SIGTERM')
    assert.equal(notices(id).length, 3)
    return { id }
  },

  async subagent(tool) {
    const spawnArgs = { description: 'Long research', prompt: 'Research the topic thoroughly.' }
    const { child, id } = await startRunning({ spawn: { tool, args: spawnArgs } })
    const childRequest = await waitFor('the subagent request', r => r.pid === child.pid && r.child === true, child)
    // The lead ends its turn after the spawn result and waits for the subagent.
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && lastTurnEnd(id)?.kind !== 'completed') await sleep(200)
    assert.deepEqual(lastTurnEnd(id), { kind: 'completed' })
    assert.deepEqual(state()[id], { root: false, children: [childRequest.sessionId] })
    await stop(child, 'SIGTERM')
    const next = await continued(id)
    assert.match(next.notice.text, /subagents you started were still working/)
    assert.equal(next.notice.attempt, 1)
    await settle(id, next.child)
    await stop(next.child, 'SIGTERM')
    assert.deepEqual(lastTurnEnd(id), { kind: 'completed' })
    return { id, child: childRequest.sessionId }
  },

  async goal() {
    const { child, id } = await startRunning({ goal: true })
    await stop(child, 'SIGTERM')
    const stoppedBy = lastTurnEnd(id)
    assert.equal(stoppedBy.kind, 'aborted')
    const next = await continued(id)
    // After the notice turn, the rearmed goal starts its next round on its own.
    const round = await waitFor('a goal round after the notice', r => r.pid === next.child.pid && r.sessionId === id
      && r.users?.findLastIndex(u => u.kind === 'goal') > r.users?.findLastIndex(u => u.kind === 'auto-restart'), next.child, 20_000)
    await stop(next.child, 'SIGTERM')
    return { id, stoppedBy: stoppedBy.reason.kind, roundAfterNotice: round.users.findLast(u => u.kind === 'goal').text.slice(0, 60) }
  },
}

const selected = process.argv.slice(2)
const order = selected.length > 0 ? selected : ['graceful', 'crash', 'loop', 'subagent', 'goal']
let failed = false
try {
  const install = run(['plugin', '--profile', 'web', 'add', `link:${PLUGIN}`, `link:${FIXTURE}`])
  const installed = await install.exited
  if (installed.code !== 0) throw new Error(`plugin install failed\n${install.output}`)
  let tools
  for (const name of order) {
    const started = Date.now()
    try {
      const subagentTool = process.env.SUBAGENT_TOOL ?? tools?.find(tool => /^subagent$/i.test(tool)) ?? 'subagent'
      const result = await scenarios[name](subagentTool)
      tools ??= result.tools
      console.log(`ok   ${name} (${((Date.now() - started) / 1000).toFixed(1)}s) ${JSON.stringify(result)}`)
    } catch (error) {
      failed = true
      console.log(`FAIL ${name}: ${error.stack ?? error}`)
    } finally {
      await killAll()
    }
  }
} finally {
  await killAll()
  if (process.env.KEEP_E2E) console.log(`kept ${ROOT}`)
  else rmSync(ROOT, { recursive: true, force: true })
}
process.exitCode = failed ? 1 : 0
