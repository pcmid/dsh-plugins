// Records real turns in temporary git repositories and directories, then rewinds them.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { GitRunner, locateRepository, snapshotTree } from '../host/git.js'
import { canonicalPath, temporaryRoots } from '../host/paths.js'
import { TurnRecorder } from '../host/recorder.js'
import { planRewind, rewindFiles, undoRewind } from '../host/rewind.js'
import { Store, turnKey } from '../host/store.js'

const ORIGIN = 1_000

let base
let work
let store
let warnings

beforeEach(async () => {
  base = await canonicalPath(await mkdtemp(join(tmpdir(), 'edit-prompt-test-')))
  work = join(base, 'work')
  await mkdir(work)
  store = new Store(join(base, 'store'))
  warnings = []
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

function git(...args) {
  return execFileSync('git', args, { cwd: work, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString()
}

function recorder({ withGit = true, maxFileBytes = 1024 * 1024 } = {}) {
  const session = { id: 'session-a', header: { cwd: work } }
  return new TurnRecorder(session, {
    git: async () => withGit ? new GitRunner('git', { timeoutMs: 30_000, outputMaxBytes: 1024 * 1024 }) : null,
    store,
    maxFileBytes,
    privateDirs: [store.dir],
    temporaryRoots: temporaryRoots(),
    cwdOf: () => work,
    originTime: async () => ORIGIN,
    warn: message => warnings.push(message),
  })
}

/** Run one turn: `body` changes files (calling `tool(path)` before a file-tool mutation). */
async function turn(rec, seq, body) {
  rec.start({ seq, time: seq * 100, data: { turn: seq } })
  await rec.settled()
  await body(async (path) => {
    rec.capture(path)
    await rec.settled()
  })
  rec.observe({ data: { turn: seq } })
  rec.end(seq)
  await rec.settled()
}

const events = (...seqs) => [
  { seq: 0, type: 'session/start', time: ORIGIN },
  ...seqs.map(seq => ({ seq, type: 'turn/start', time: seq * 100 })),
]

const read = path => readFile(join(work, path), 'utf8')
const exists = path => stat(join(work, path)).then(() => true, () => false)

describe('recording and rewinding inside a repository', () => {
  beforeEach(async () => {
    git('init', '-q')
    await writeFile(join(work, '.gitignore'), 'build/\n')
    await writeFile(join(work, 'a.txt'), 'a0\n')
    await writeFile(join(work, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
    git('add', '.')
    git('commit', '-qm', 'init')
    await writeFile(join(work, 'untracked.txt'), 'u0\n')
    await mkdir(join(work, 'build'))
    await writeFile(join(work, 'build', 'out.txt'), 'o0\n')
  })

  it('records shell and file-tool changes, rewinds them, and undoes the rewind', async () => {
    const objectsBefore = git('count-objects')
    const rec = recorder()
    await turn(rec, 10, async (tool) => {
      await writeFile(join(work, 'a.txt'), 'a1\n')
      await writeFile(join(work, 'new.txt'), 'n1\n')
      await rm(join(work, 'untracked.txt'))
      await writeFile(join(work, 'run.sh'), '#!/bin/sh\necho 1\n')
      await tool(join(work, 'build', 'out.txt'))
      await writeFile(join(work, 'build', 'out.txt'), 'o1\n')
    })
    await turn(rec, 20, async () => {
      await writeFile(join(work, 'a.txt'), 'a2\n')
    })
    // A turn that started before the cut stays as it is.
    const record = await store.readTurn(turnKey(ORIGIN, 10, 1000))
    assert.deepEqual(record.files.map(file => file.path).sort(), ['a.txt', 'build/out.txt', 'new.txt', 'run.sh', 'untracked.txt'].map(path => join(work, ...path.split('/'))))
    assert.deepEqual(warnings, [])
    // Snapshots write nothing into the repository itself.
    assert.equal(git('count-objects'), objectsBefore)

    const plan = await planRewind(store, events(10, 20), 10)
    const result = await rewindFiles(store, plan, { force: false, journal: { sessionId: 'session-a', fromSeq: 10 } })
    assert.equal(result.status, 'restored')
    assert.equal(result.files, 5)
    assert.equal(await read('a.txt'), 'a0\n')
    assert.equal(await read('untracked.txt'), 'u0\n')
    assert.equal(await read('build/out.txt'), 'o0\n')
    assert.equal(await read('run.sh'), '#!/bin/sh\n')
    assert.equal((await stat(join(work, 'run.sh'))).mode & 0o111, 0o111)
    assert.equal(await exists('new.txt'), false)

    const undone = await undoRewind(store, result.restoreId)
    assert.deepEqual(undone, { files: 5, skipped: [] })
    assert.equal(await read('a.txt'), 'a2\n')
    assert.equal(await read('new.txt'), 'n1\n')
    assert.equal(await exists('untracked.txt'), false)
  })

  it('rewinds only the turns from the cut onward, including those a fork inherited', async () => {
    const rec = recorder()
    await turn(rec, 10, async () => { await writeFile(join(work, 'a.txt'), 'a1\n') })
    await turn(rec, 20, async () => { await writeFile(join(work, 'a.txt'), 'a2\n') })
    const plan = await planRewind(store, events(10, 20), 20)
    await rewindFiles(store, plan, { force: false, journal: {} })
    assert.equal(await read('a.txt'), 'a1\n')
    // A fork holds the same events up to its cut, so it finds the parent's records.
    const forkPlan = await planRewind(store, [...events(10), { seq: 15, type: 'turn/start', time: 99 }], 10)
    await rewindFiles(store, forkPlan, { force: false, journal: {} })
    assert.equal(await read('a.txt'), 'a0\n')
  })

  it('asks before overwriting a later change, and undo brings that change back', async () => {
    const rec = recorder()
    await turn(rec, 10, async () => { await writeFile(join(work, 'a.txt'), 'a1\n') })
    await writeFile(join(work, 'a.txt'), 'mine\n')
    const plan = await planRewind(store, events(10), 10)
    const asked = await rewindFiles(store, plan, { force: false, journal: {} })
    assert.deepEqual(asked, { status: 'attention', files: [{ path: join(work, 'a.txt'), reason: 'modified' }] })
    assert.equal(await read('a.txt'), 'mine\n')
    const forced = await rewindFiles(store, plan, { force: true, journal: {} })
    assert.equal(await read('a.txt'), 'a0\n')
    await undoRewind(store, forced.restoreId)
    assert.equal(await read('a.txt'), 'mine\n')
  })

  it('reports a file whose earlier content was too large to keep', async () => {
    await writeFile(join(work, 'big.txt'), 'x'.repeat(64))
    git('add', 'big.txt')
    const rec = recorder({ maxFileBytes: 16 })
    await turn(rec, 10, async () => { await writeFile(join(work, 'big.txt'), 'y') })
    const plan = await planRewind(store, events(10), 10)
    assert.deepEqual(await rewindFiles(store, plan, { force: false, journal: {} }), {
      status: 'attention', files: [{ path: join(work, 'big.txt'), reason: 'oversized' }],
    })
    const forced = await rewindFiles(store, plan, { force: true, journal: {} })
    assert.deepEqual(forced, { status: 'restored', files: 0, skipped: [{ path: join(work, 'big.txt'), reason: 'oversized' }] })
  })

  it('records nothing for a turn without tool results', async () => {
    const rec = recorder()
    rec.start({ seq: 10, time: 1000, data: { turn: 10 } })
    await writeFile(join(work, 'a.txt'), 'by hand\n')
    rec.end(10)
    await rec.settled()
    assert.equal(await store.readTurn(turnKey(ORIGIN, 10, 1000)), undefined)
  })
})

describe('snapshots', () => {
  it('see a file rewritten with the same size in the second its index was written', async () => {
    git('init', '-q')
    const runner = new GitRunner('git', { timeoutMs: 30_000, outputMaxBytes: 1024 * 1024 })
    const repository = await locateRepository(runner, work, await canonicalPath(await mkdtemp(join(base, 'scratch-'))), [], undefined)
    // Commit and rewrite inside one second, then snapshot in a later one, as a quick tool edit after a commit does.
    for (let attempt = 0; ; attempt++) {
      await writeFile(join(work, 'a.txt'), 'a0\n')
      git('add', 'a.txt')
      await writeFile(join(work, 'a.txt'), 'a1\n')
      const second = ms => Math.floor(ms / 1000)
      if (second((await stat(join(work, 'a.txt'))).ctimeMs) === second((await stat(join(work, '.git', 'index'))).mtimeMs)) break
      assert.ok(attempt < 10, 'could not rewrite the file within the index write second')
    }
    await new Promise(resolve => setTimeout(resolve, 1100))
    const tree = await snapshotTree(runner, repository, undefined)
    const recorded = await runner.run(['rev-parse', `${tree}:a.txt`], { cwd: work, env: repository.env })
    assert.equal(recorded.stdout.toString(), git('hash-object', 'a.txt'))
  })
})

describe('recording without a repository', () => {
  it('rewinds file-tool edits only, links included', async () => {
    await writeFile(join(work, 'a.txt'), 'a0\n')
    const rec = recorder()
    await turn(rec, 10, async (tool) => {
      await tool(join(work, 'a.txt'))
      await writeFile(join(work, 'a.txt'), 'a1\n')
      await tool(join(work, 'link'))
      await symlink('a.txt', join(work, 'link'))
      // A shell edit outside any repository is not seen.
      await writeFile(join(work, 'shell.txt'), 's\n')
    })
    const plan = await planRewind(store, events(10), 10)
    const result = await rewindFiles(store, plan, { force: false, journal: {} })
    assert.equal(result.files, 2)
    assert.equal(await read('a.txt'), 'a0\n')
    assert.equal(await exists('link'), false)
    assert.equal(await read('shell.txt'), 's\n')
    await undoRewind(store, result.restoreId)
    assert.equal(await readlink(join(work, 'link')), 'a.txt')
  })

  it('treats a missing git like a missing repository', async () => {
    git('init', '-q')
    await writeFile(join(work, 'a.txt'), 'a0\n')
    const rec = recorder({ withGit: false })
    await turn(rec, 10, async (tool) => {
      await tool(join(work, 'a.txt'))
      await writeFile(join(work, 'a.txt'), 'a1\n')
    })
    const result = await rewindFiles(store, await planRewind(store, events(10), 10), { force: false, journal: {} })
    assert.equal(result.files, 1)
    assert.equal(await read('a.txt'), 'a0\n')
  })
})

describe('pruning', () => {
  it('drops old records, old journals, and the copies only they referred to', async () => {
    await writeFile(join(work, 'a.txt'), 'old\n')
    const old = await store.capture(join(work, 'a.txt'), 1024)
    await writeFile(join(work, 'a.txt'), 'kept\n')
    const kept = await store.capture(join(work, 'a.txt'), 1024)
    await store.writeTurn('old', { files: [{ path: 'x', before: old, after: { kind: 'absent' } }] })
    await store.writeTurn('new', { files: [{ path: 'x', before: kept, after: { kind: 'absent' } }] })
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    await utimes(join(store.dir, 'turns', 'old.json'), longAgo, longAgo)
    await utimes(store.blobPath(old.hash), longAgo, longAgo)
    await utimes(store.blobPath(kept.hash), longAgo, longAgo)
    await store.prune(30)
    assert.equal(await store.readTurn('old'), undefined)
    assert.ok(await store.readTurn('new'))
    await assert.rejects(store.readBlob(old.hash))
    assert.equal((await store.readBlob(kept.hash)).toString(), 'kept\n')
  })
})

describe('plugin', () => {
  it('records through the Session, tool, and filesystem events and rewinds through its route', async () => {
    const plugin = await import('../index.js')
    const config = plugin.Config({})
    assert.deepEqual({ ...config, archiveSource: undefined }, { archiveSource: undefined, maxFileBytes: 16 * 1024 * 1024, retentionDays: 30, gitTimeoutMs: 60_000 })
    git('init', '-q')
    await writeFile(join(work, 'a.txt'), 'a0\n')
    await writeFile(join(work, 'notes.txt'), 'n0\n')
    const session = { id: 'session-p', header: { cwd: work }, eventAt: seq => seq === 0 ? { time: ORIGIN } : undefined }
    const cancelled = []
    // Cancelling ends the turn, then the Agent goes idle, as the agent loop does.
    let endTurn
    const agent = {
      session,
      status: 'idle',
      cancel(cause) {
        cancelled.push(cause)
        setTimeout(() => {
          endTurn()
          this.status = 'idle'
        }, 20)
      },
    }
    const listeners = {}
    const routes = {}
    const disposers = []
    const services = { profileContext: { home: base }, fs: { processPath: target => target.path } }
    plugin.apply({
      get: name => services[name],
      logger: { warn: message => warnings.push(message), info() {} },
      effect: (callback) => { disposers.push(callback()) },
      on: (name, listener) => { (listeners[name] ??= []).push(listener) },
      connection: { fetch: { register: (route) => { routes[route.path] = route } } },
      sessionQuery: { listEvents: async () => events(10) },
      agents: { list: () => [agent] },
    }, config)
    const emit = (name, ...args) => Promise.all(listeners[name].map(listener => listener(...args)))
    const call = async (operation, payload) => {
      const response = await routes[`/api/pcmid/edit-prompt/${operation}`].fetch(new Request('http://host/', {
        method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'r', payload }),
      }))
      return (await response.json()).result
    }
    try {
      await emit('session/event', session, { type: 'turn/start', seq: 10, time: 1000, data: { turn: 10 } })
      const exec = { agent }
      assert.equal(await listeners['tools/pre-execute'][0](exec, async () => 'allowed'), 'allowed')
      const intent = await listeners['fs/edit-intent'][0]({ path: join(work, 'a.txt') }, exec, async () => undefined)
      assert.equal(intent, undefined)
      await writeFile(join(work, 'a.txt'), 'a1\n')
      await writeFile(join(work, 'notes.txt'), 'by a shell command\n')
      await emit('session/event', session, { type: 'tool/result', seq: 12, data: { turn: 10 } })
      agent.status = 'running'
      endTurn = () => emit('session/event', session, { type: 'turn/end', seq: 13, data: { turn: 10 } })
      const result = await call('rewind', { sessionId: 'session-p', fromSeq: 10 })
      assert.deepEqual(cancelled, [{ kind: 'user' }])
      assert.equal(result.ok, true)
      assert.equal(result.value.files, 2)
      assert.equal(await read('a.txt'), 'a0\n')
      assert.equal(await read('notes.txt'), 'n0\n')
      assert.equal((await stat(join(base, 'edit-prompt', 'turns', `${turnKey(ORIGIN, 10, 1000)}.json`))).isFile(), true)
      assert.deepEqual((await call('undo', { restoreId: result.value.restoreId })).value, { files: 2, skipped: [] })
      assert.equal(await read('a.txt'), 'a1\n')
      assert.deepEqual(await call('undo', { restoreId: 'missing' }), { ok: false, error: { code: 'not-found', message: 'no restore missing', details: {} } })
      assert.equal((await call('rewind', { sessionId: 'session-p' })).error.code, 'bad-request')
      assert.deepEqual(warnings, [])
    } finally {
      for (const dispose of disposers) dispose?.()
    }
  })
})
