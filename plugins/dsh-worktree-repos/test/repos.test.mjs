// Repository scanning and the Host operations, against temporary directories and stub services.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { HostError, createOperations, insideGitCheckout, listed, normalizePath, scanRepositories } from '../repos.js'

let root
let workspace

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-worktree-repos-')))
  workspace = join(root, 'workspace')
  await mkdir(join(workspace, 'beta', '.git'), { recursive: true })
  await mkdir(join(workspace, 'alpha'), { recursive: true })
  await writeFile(join(workspace, 'alpha', '.git'), 'gitdir: /elsewhere\n')
  await mkdir(join(workspace, 'plain', 'nested', '.git'), { recursive: true })
  await mkdir(join(workspace, '.hidden', '.git'), { recursive: true })
  await writeFile(join(workspace, 'file.txt'), '')
  await mkdir(join(root, 'outside', '.git'), { recursive: true })
  await symlink(join(root, 'outside'), join(workspace, 'linked'))
  await mkdir(join(root, 'checkout', '.git'), { recursive: true })
  await mkdir(join(root, 'checkout', 'sub'), { recursive: true })
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('normalizePath / listed', () => {
  it('ignores trailing separators but keeps roots', () => {
    assert.equal(normalizePath('/a/b/'), '/a/b')
    assert.equal(normalizePath('/'), '/')
    assert.equal(normalizePath('C:\\'), 'C:\\')
  })

  it('matches listed directories only', () => {
    assert.equal(listed(['/a/b/'], '/a/b'), true)
    assert.equal(listed(['/a/b'], '/a/c'), false)
    assert.equal(listed(undefined, '/a/b'), false)
    assert.equal(listed({ '/a/b': true }, '/a/b'), false)
  })
})

describe('insideGitCheckout', () => {
  it('finds a .git entry in the directory or a parent', async () => {
    assert.equal(await insideGitCheckout(join(root, 'checkout')), true)
    assert.equal(await insideGitCheckout(join(root, 'checkout', 'sub')), true)
  })

  it('reports a directory outside any checkout', async () => {
    // The temporary directory sits outside a checkout unless the machine's tmp is one.
    const expected = await insideGitCheckout(root)
    assert.equal(await insideGitCheckout(workspace), expected)
  })
})

describe('scanRepositories', () => {
  it('lists first-level repositories by name, skipping hidden, plain, and nested ones', async () => {
    assert.deepEqual(await scanRepositories(workspace), [
      { name: 'alpha', path: join(workspace, 'alpha') },
      { name: 'beta', path: join(workspace, 'beta') },
      { name: 'linked', path: join(root, 'outside') },
    ])
  })

  it('rejects a missing workspace', async () => {
    await assert.rejects(scanRepositories(join(root, 'missing')))
  })
})

/** Stub services around one Session whose header names `cwd`. */
function setup({ cwd = workspace, current = cwd, workspaces = [workspace], started = false, loaded = true, requested = false } = {}) {
  const session = { id: 's1', header: { cwd } }
  const agent = { session }
  const moves = []
  let directory = current
  let request = requested
  const operations = createOperations({
    workspaces: () => workspaces,
    agentOf: id => loaded && id === 's1' ? agent : undefined,
    started: () => started,
    cwdOf: () => directory,
    changeDirectory: async (target, path) => {
      assert.equal(target, agent)
      moves.push(path)
      directory = path
      const withdrawn = request
      request = false
      return withdrawn
    },
  })
  return { operations, moves }
}

describe('repositories', () => {
  it('lists the repositories of a scanned workspace', async () => {
    const { operations } = setup()
    const state = await operations.repositories({ sessionId: 's1' })
    assert.equal(state.workspace, workspace)
    assert.equal(state.current, workspace)
    assert.deepEqual(state.repositories.map(repository => repository.name), ['alpha', 'beta', 'linked'])
  })

  it('keeps the picker of a Session already in a repository after scanning is turned off', async () => {
    const beta = join(workspace, 'beta')
    const state = await setup({ workspaces: [], current: beta }).operations.repositories({ sessionId: 's1' })
    assert.equal(state.current, beta)
    assert.equal(await setup({ workspaces: [], current: join(workspace, 'plain') }).operations.repositories({ sessionId: 's1' }), null)
  })

  it('does not apply when scanning is off, the Session started or is not loaded, or the workspace is a checkout', async () => {
    assert.equal(await setup({ workspaces: [] }).operations.repositories({ sessionId: 's1' }), null)
    assert.equal(await setup({ started: true }).operations.repositories({ sessionId: 's1' }), null)
    assert.equal(await setup({ loaded: false }).operations.repositories({ sessionId: 's1' }), null)
    const checkout = join(root, 'checkout')
    assert.equal(await setup({ cwd: checkout, workspaces: [checkout] }).operations.repositories({ sessionId: 's1' }), null)
  })

  it('rejects a request without a Session id', async () => {
    await assert.rejects(setup().operations.repositories({}), error => error instanceof HostError && error.code === 'bad-request')
  })
})

describe('choose', () => {
  it('moves the Session into a repository and back to the workspace', async () => {
    const { operations, moves } = setup({ requested: true })
    const beta = join(workspace, 'beta')
    const first = await operations.choose({ sessionId: 's1', path: beta })
    assert.equal(first.state.current, beta)
    assert.equal(first.withdrawn, true)
    const again = await operations.choose({ sessionId: 's1', path: beta })
    assert.equal(again.state.current, beta)
    assert.equal(again.withdrawn, false)
    const back = await operations.choose({ sessionId: 's1', path: null })
    assert.equal(back.state.current, workspace)
    assert.equal(back.withdrawn, false)
    assert.deepEqual(moves, [beta, workspace])
  })

  it('lets a Session go back to the workspace after scanning is turned off, then hides the picker', async () => {
    const { operations } = setup({ workspaces: [], current: join(workspace, 'beta') })
    const back = await operations.choose({ sessionId: 's1', path: null })
    assert.equal(back.state, null)
  })

  it('refuses a directory that is not one of the repositories', async () => {
    const { operations, moves } = setup()
    await assert.rejects(operations.choose({ sessionId: 's1', path: join(workspace, 'plain') }),
      error => error instanceof HostError && error.code === 'not-found')
    assert.deepEqual(moves, [])
  })

  it('refuses a Session that can no longer change', async () => {
    await assert.rejects(setup({ started: true }).operations.choose({ sessionId: 's1', path: null }),
      error => error instanceof HostError && error.code === 'unavailable')
  })
})

describe('probe', () => {
  it('tells a checkout from a plain directory', async () => {
    const { operations } = setup()
    assert.deepEqual(await operations.probe({ path: join(root, 'checkout') }), { git: true })
    await assert.rejects(operations.probe({ path: 'relative' }), error => error instanceof HostError)
  })
})
