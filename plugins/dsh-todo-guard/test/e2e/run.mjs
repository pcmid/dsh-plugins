#!/usr/bin/env node
/**
 * End-to-end check of @pcmid/dsh-todo-guard against an installed Harness.
 *
 * Boots the `web` profile in a temporary DSH_HOME with this plugin and the
 * scripted fixture linked into it. The fixture model writes a three-item task
 * list, reads a file in seven more steps without updating the list, and then
 * answers. With `stepThreshold: 3` the guard must attach a reminder in steps 4
 * and 7, so the model sees the first one in its fifth request and the second
 * in its eighth. With `autoCompleteOnTurnEnd: true` the stored log must end
 * with a completed list. The Harness CLI is the installed Desktop runtime
 * unless DSH_CLI names another `dsh` executable.
 *
 * Usage: node test/e2e/run.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import assert from 'node:assert/strict'

const PLUGIN = fileURLToPath(new URL('../..', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./fixture', import.meta.url))
const DESKTOP = '/Applications/DeepSeek Harness.app/Contents'
const ROOT = mkdtempSync(join(tmpdir(), 'todo-guard-e2e-'))
const HOME = join(ROOT, 'home')
const WORK = join(ROOT, 'work')
const RECORD = join(ROOT, 'requests.jsonl')
const NOTES = join(WORK, 'notes.txt')
const WORK_STEPS = 7
mkdirSync(WORK, { recursive: true })
writeFileSync(RECORD, '')
writeFileSync(NOTES, 'The notes.\n')

function command(args) {
  if (process.env.DSH_CLI) return { file: process.env.DSH_CLI, args, env: {} }
  return {
    file: join(DESKTOP, 'MacOS', 'DeepSeek Harness'),
    args: ['--expose-internals', join(DESKTOP, 'Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'), ...args],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }
}

function run(args) {
  const { file, args: argv, env } = command(args)
  const child = spawn(file, argv, { cwd: WORK, env: { ...process.env, ...env, DSH_HOME: HOME }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.output = ''
  child.stdout.on('data', (chunk) => { child.output += chunk })
  child.stderr.on('data', (chunk) => { child.output += chunk })
  child.exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })))
  return child
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const records = () => readFileSync(RECORD, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))

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

const reminders = request => request.users.filter(user => user.source?.kind === 'todo-guard')

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
    '- id: todo-guard',
    `  config: ${JSON.stringify({ stepThreshold: 3, callThreshold: 100, autoCompleteOnTurnEnd: true })}`,
    '- insert:',
    '    - id: todo-guard-fixture',
    "      name: '@pcmid-test/todo-guard-fixture'",
    `      config: ${JSON.stringify({ record: RECORD, cwd: WORK, notes: NOTES, workSteps: WORK_STEPS })}`,
    '',
  ].join('\n'))
  child = run(['--profile', 'web', '--patch', patch, '--no-open', '--port', '0'])

  const created = await waitFor('the fixture conversation', r => r.created || r.error, child)
  if (created.error) throw new Error(created.error)
  const id = created.created
  await waitFor('the final request', r => r.sessionId === id && r.replies === WORK_STEPS + 1, child)
  await sleep(1500)
  child.kill('SIGTERM')
  const exit = await Promise.race([child.exited, sleep(15_000).then(() => undefined)])
  if (exit === undefined) throw new Error(`boot did not exit after SIGTERM\n${child.output}`)

  const requests = records().filter(r => r.sessionId === id)
  assert.deepEqual(requests.map(r => r.replies), [...Array(WORK_STEPS + 2).keys()], 'one request per step, nothing extra')
  assert.ok(requests[0].tools.includes('todo_write') && requests[0].tools.includes('read'), `tools: ${requests[0].tools}`)
  assert.deepEqual(requests.map(r => reminders(r).length), [0, 0, 0, 0, 1, 1, 1, 2, 2])

  const [first] = reminders(requests[4])
  assert.deepEqual(first.source, { kind: 'todo-guard', form: 'notice', summary: 'Todo list 0/3 completed · Read the notes' })
  assert.match(first.text, /^Todo list check: 0\/3 completed, 3 step\(s\) and 3 tool call\(s\) since your last todo_write\./)
  assert.match(first.text, /\n1\. \[in_progress\] Read the notes\n2\. \[pending\] Summarize the notes\n3\. \[pending\] Report the summary\n/)

  const log = sessionLog(id)
  const stored = log.filter(event => event.type === 'user/message' && event.data.source.kind === 'todo-guard')
  assert.equal(stored.length, 2, 'both reminders are in the durable log')
  const writes = log.filter(event => event.type === 'todo/write')
  assert.equal(writes.length, 2, 'the model write and the turn-end completion')
  assert.ok(writes[1].data.todos.every(item => item.status === 'completed'))
  assert.deepEqual(log.findLast(event => event.type === 'turn/end').data.reason, { kind: 'completed' })
  assert.ok(writes[1].seq < log.findLast(event => event.type === 'turn/end').seq, 'completion is written inside the turn')
  console.log(`ok   todo-guard e2e ${JSON.stringify({ id, reminders: stored.map(event => event.seq), completion: writes[1].seq })}`)
} catch (error) {
  process.exitCode = 1
  console.log(`FAIL todo-guard e2e: ${error.stack ?? error}`)
} finally {
  if (child !== undefined && child.exitCode === null) {
    child.kill('SIGKILL')
    await child.exited
  }
  if (process.env.KEEP_E2E) console.log(`kept ${ROOT}`)
  else rmSync(ROOT, { recursive: true, force: true })
}
