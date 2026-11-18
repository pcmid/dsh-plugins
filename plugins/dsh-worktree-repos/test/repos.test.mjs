// Repository scanning and the Host operations, against temporary directories and stub services.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { HostError, createOperations, currentBranch, insideGitCheckout, normalizePath, scanRepositories } from '../repos.js'

let root
let workspace

/** A repository directory whose HEAD names `head`. */
async function repository(path, head = 'ref: refs/heads/main') {
  await mkdir(join(path, '.git'), { recursive: true })
  await writeFile(join(path, '.git', 'HEAD'), `${head}\n`)
}

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-worktree-repos-')))
  workspace = join(root, 'workspace')
  await repository(join(workspace, 'beta'), 'ref: refs/heads/feature/x')
  // A worktree checkout: `.git` is a file pointing at its Git directory.
  await repository(join(root, 'alpha-git'), '0123456789abcdef0123456789abcdef01234567')
  await mkdir(join(workspace, 'alpha'), { recursive: true })
  await writeFile(join(workspace, 'alpha', '.git'), 'gitdir: ../../alpha-git/.git\n')
  await repository(join(workspace, 'group', 'nested'))
  await repository(join(workspace, 'group', 'deeper', 'deepest'))
  await repository(join(workspace, 'beta', 'inner'))
  await repository(join(workspace, '.hidden'))
  await writeFile(join(workspace, 'file.txt'), '')
  await mkdir(join(workspace, 'plain', 'empty'), { recursive: true })
  await repository(join(root, 'outside'))
  await symlink(join(root, 'outside'), join(workspace, 'linked'))
  await symlink(workspace, join(workspace, 'group', 'loop'))
  await repository(join(root, 'checkout'))
  await mkdir(join(root, 'checkout', 'sub'), { recursive: true })
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('normalizePath', () => {
  it('ignores trailing separators but keeps roots', () => {
    assert.equal(normalizePath('/a/b/'), '/a/b')
    assert.equal(normalizePath('/'), '/')
    assert.equal(normalizePath('C:\\'), 'C:\\')
  })
})

describe('insideGitCheckout', () => {
  it('finds a .git entry in the directory or a parent', async () => {
    assert.equal(await insideGitCheckout(join(root, 'checkout')), true)
    assert.equal(await insideGitCheckout(join(root, 'checkout', 'sub')), true)
  })

  it('reports a directory outside any checkout', async () => {
    // The temporary directory sits outside a checkout unless the machine's tmp is one.
    assert.equal(await insideGitCheckout(workspace), await insideGitCheckout(root))
  })
})

describe('currentBranch', () => {
  it('reads the branch, a detached commit, and a worktree checkout', async () => {
    assert.equal(await currentBranch(join(workspace, 'beta')), 'feature/x')
    assert.equal(await currentBranch(join(workspace, 'alpha')), '0123456')
    assert.equal(await currentBranch(join(workspace, 'group')), null)
  })
})

describe('scanRepositories', () => {
  it('lists the direct subdirectories that are repositories by default', async () => {
    assert.deepEqual(await scanRepositories(workspace), [
      { name: 'alpha', path: join(workspace, 'alpha'), branch: '0123456' },
      { name: 'beta', path: join(workspace, 'beta'), branch: 'feature/x' },
      { name: 'linked', path: join(root, 'outside'), branch: 'main' },
    ])
  })

  it('goes deeper with a larger depth, without entering repositories or following links', async () => {
    assert.deepEqual((await scanRepositories(workspace, 2)).map(repository => repository.name),
      ['alpha', 'beta', 'group/nested', 'linked'])
    assert.deepEqual((await scanRepositories(workspace, 5)).map(repository => repository.name),
      ['alpha', 'beta', 'group/deeper/deepest', 'group/nested', 'linked'])
  })

  it('rejects a missing workspace', async () => {
    await assert.rejects(scanRepositories(join(root, 'missing')))
  })
})

/** Stub services around one Session whose header names `cwd`. */
function setup({ cwd = workspace, current = cwd, depth = 1, started = false, loaded = true, requested = false } = {}) {
  const session = { id: 's1', header: { cwd } }
  const agent = { session }
  const moves = []
  let directory = current
  let request = requested
  const operations = createOperations({
    depth: () => depth,
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
  it('lists the repositories of a workspace that is not a checkout', async () => {
    const state = await setup().operations.repositories({ sessionId: 's1' })
    assert.equal(state.workspace, workspace)
    assert.equal(state.current, workspace)
    assert.deepEqual(state.repositories.map(repository => repository.name), ['alpha', 'beta', 'linked'])
  })

  it('follows the configured depth', async () => {
    const state = await setup({ depth: 2 }).operations.repositories({ sessionId: 's1' })
    assert.ok(state.repositories.some(repository => repository.name === 'group/nested'))
  })

  it('does not apply once the Session started, when it is not loaded, in a checkout, or without repositories', async () => {
    assert.equal(await setup({ started: true }).operations.repositories({ sessionId: 's1' }), null)
    assert.equal(await setup({ loaded: false }).operations.repositories({ sessionId: 's1' }), null)
    assert.equal(await setup({ cwd: join(root, 'checkout') }).operations.repositories({ sessionId: 's1' }), null)
    assert.equal(await setup({ cwd: join(workspace, 'plain') }).operations.repositories({ sessionId: 's1' }), null)
  })

  it('rejects a request without a Session id', async () => {
    await assert.rejects(setup().operations.repositories({}), error => error instanceof HostError && error.code === 'bad-request')
  })
})

describe('choose', () => {
  it('moves the Session into a repository and back to the workspace root', async () => {
    const { operations, moves } = setup({ requested: true })
    const beta = join(workspace, 'beta')
    const first = await operations.choose({ sessionId: 's1', path: beta })
    assert.equal(first.state.current, beta)
    assert.equal(first.withdrawn, true)
    const again = await operations.choose({ sessionId: 's1', path: beta })
    assert.equal(again.withdrawn, false)
    const back = await operations.choose({ sessionId: 's1', path: null })
    assert.equal(back.state.current, workspace)
    assert.equal(back.withdrawn, false)
    assert.deepEqual(moves, [beta, workspace])
  })

  it('refuses a directory that is not one of the repositories', async () => {
    const { operations, moves } = setup()
    await assert.rejects(operations.choose({ sessionId: 's1', path: join(workspace, 'group') }),
      error => error instanceof HostError && error.code === 'not-found')
    assert.deepEqual(moves, [])
  })

  it('refuses a Session that can no longer change', async () => {
    await assert.rejects(setup({ started: true }).operations.choose({ sessionId: 's1', path: null }),
      error => error instanceof HostError && error.code === 'unavailable')
  })
})
