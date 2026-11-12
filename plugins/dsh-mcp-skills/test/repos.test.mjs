// Route-level tests of the skill repositories (docs/host-api.md, 「技能仓库（0.2）」) against real folders and
// local git repositories served over file://.

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import { copyDir, createGitRepo, gitAvailable, isolateGit, readState } from './repo-support.mjs'
import { createHost, createSandbox, put, skillText } from './support.mjs'

let sandbox
let restoreGit
beforeEach(async () => {
  sandbox = await createSandbox()
  restoreGit = isolateGit()
})
afterEach(async () => {
  restoreGit()
  await sandbox.restore()
})

const NOT_DOWNLOADED = 'Not downloaded yet; check for updates'
const gitSkip = gitAvailable ? false : 'git is not installed'

/** Repository files: two valid skills, one invalid, and a README. */
function repoFiles() {
  return {
    'README.md': 'collection\n',
    'skills/pdf/SKILL.md': skillText('pdf', 'Read PDFs'),
    'skills/pdf/reference.md': 'ref\n',
    'skills/docx/SKILL.md': skillText('docx', 'Edit documents'),
    'skills/bad/SKILL.md': '---\nname: bad\n---\nno description\n',
  }
}

function userDsh() {
  return path.join(sandbox.dshHome, 'skills')
}

function userAgents() {
  return path.join(sandbox.agentsHome, 'skills')
}

function cacheDir(id) {
  return path.join(sandbox.dshHome, 'mcp-skills', 'repos', id)
}

function skillByKey(detail, key) {
  const skill = detail.skills.find(candidate => candidate.key === key)
  assert.ok(skill, `skill ${key} is listed`)
  return skill
}

async function originOf(host, name, payload = {}) {
  const listed = await host.value('skill-settings/list', payload)
  return listed.skills.filter(item => item.name === name).map(item => item.origin ?? null)
}

describe('skill-settings/repos-add', { skip: gitSkip }, () => {
  it('adds a git repository over file://, lists counts, and returns an existing source without fetching', async () => {
    const repo = await createGitRepo(sandbox.base, repoFiles())
    const host = createHost()
    const added = await host.value('skill-settings/repos-add', { source: repo.url })
    assert.equal(added.existing, false)
    const { repository } = added
    assert.match(repository.id, /^[0-9a-f]{12}$/)
    assert.equal(repository.kind, 'git')
    assert.equal(repository.label, 'skills')
    assert.equal(repository.source, repo.url)
    assert.equal(repository.url, repo.url)
    assert.equal(repository.commit, repo.head())
    assert.equal(typeof repository.checkedAt, 'number')
    assert.equal(repository.lastError, undefined)
    assert.deepEqual([repository.skillCount, repository.installedCount, repository.updateCount], [2, 0, 0])
    assert.deepEqual(added.skills.map(skill => [skill.key, skill.name, skill.valid, skill.fileCount, skill.installs.length]), [
      ['skills/bad', 'bad', false, 1, 0],
      ['skills/docx', 'docx', true, 1, 0],
      ['skills/pdf', 'pdf', true, 2, 0],
    ])
    assert.match(skillByKey(added, 'skills/bad').error, /description/)
    await fs.access(path.join(cacheDir(repository.id), '.git'))

    const stateFile = path.join(sandbox.dshHome, 'mcp-skills', 'state.json')
    if (process.platform !== 'win32') assert.equal((await fs.stat(stateFile)).mode & 0o777, 0o600)
    const state = await readState(sandbox.dshHome)
    assert.equal(state.version, 1)
    assert.deepEqual(state.repositories.map(entry => entry.id), [repository.id])

    // The same source (another spelling) is returned as is; the network is not touched.
    await fs.rename(repo.bare, `${repo.bare}.moved`)
    const again = await host.value('skill-settings/repos-add', { source: `${repo.url}/` })
    assert.equal(again.existing, true)
    assert.equal(again.repository.id, repository.id)
    await fs.rename(`${repo.bare}.moved`, repo.bare)

    // A subpath is another source.
    const sub = await host.value('skill-settings/repos-add', { source: repo.url, subpath: 'skills' })
    assert.equal(sub.existing, false)
    assert.notEqual(sub.repository.id, repository.id)
    assert.equal(sub.repository.label, 'skills', 'the label names the repository, not its subfolder')
    assert.equal(sub.repository.subpath, 'skills')
    assert.deepEqual(sub.skills.map(skill => skill.key), ['bad', 'docx', 'pdf'])

    const listed = await host.value('skill-settings/repos-list', {})
    assert.deepEqual(listed.repositories.map(entry => [entry.id, entry.skillCount, entry.installedCount, entry.updateCount]), [
      [repository.id, 2, 0, 0],
      [sub.repository.id, 2, 0, 0],
    ])
    // No staging folders are left behind.
    assert.deepEqual((await fs.readdir(path.join(sandbox.dshHome, 'mcp-skills', 'repos'))).sort(), [repository.id, sub.repository.id].sort())
  })

  it('adds a local folder, applying a subpath', async () => {
    const folder = path.join(sandbox.base, 'local-skills')
    await put(path.join(folder, 'one', 'SKILL.md'), skillText('one', 'first skill'))
    await put(path.join(folder, 'nested', 'two', 'SKILL.md'), skillText('two', 'second skill'))
    const host = createHost()
    const added = await host.value('skill-settings/repos-add', { source: folder })
    assert.equal(added.existing, false)
    assert.deepEqual(
      [added.repository.kind, added.repository.path, added.repository.displayPath, added.repository.label, added.repository.skillCount],
      ['local', folder, folder, folder, 2],
    )
    assert.equal(added.repository.commit, undefined)
    assert.deepEqual(added.skills.map(skill => skill.key), ['nested/two', 'one'])
    assert.equal((await host.value('skill-settings/repos-add', { source: `${folder}/` })).existing, true)

    const nested = await host.value('skill-settings/repos-add', { source: folder, subpath: 'nested' })
    assert.equal(nested.existing, false)
    assert.equal(nested.repository.path, path.join(folder, 'nested'))
    assert.deepEqual(nested.skills.map(skill => skill.key), ['two'])
    // The same folder through its own path is the same repository.
    assert.equal((await host.value('skill-settings/repos-add', { source: path.join(folder, 'nested') })).existing, true)
  })

  it('saves nothing for sources without skills, clone failures, or missing folders', async () => {
    const host = createHost()
    const empty = path.join(sandbox.base, 'empty')
    await put(path.join(empty, 'README.md'), 'nothing here\n')
    const none = await host.error('skill-settings/repos-add', { source: empty })
    assert.equal(none.code, 'invalid')
    assert.match(none.message, /No SKILL\.md found under/)

    const invalidOnly = path.join(sandbox.base, 'invalid-only')
    await put(path.join(invalidOnly, 'bad', 'SKILL.md'), '---\nname: bad\n---\n')
    assert.equal((await host.error('skill-settings/repos-add', { source: invalidOnly })).code, 'invalid')

    const noSkills = await createGitRepo(sandbox.base, { 'README.md': 'nothing\n' }, 'empty.git')
    const gitNone = await host.error('skill-settings/repos-add', { source: noSkills.url })
    assert.equal(gitNone.code, 'invalid')
    assert.match(gitNone.message, /No SKILL\.md found under empty/)

    const missing = await host.error('skill-settings/repos-add', { source: pathToFileURL(path.join(sandbox.base, 'missing.git')).href })
    assert.equal(missing.code, 'git-failed')
    assert.match(missing.message, /git clone of .*missing/)

    const withSkills = await createGitRepo(sandbox.base, repoFiles())
    const badSub = await host.error('skill-settings/repos-add', { source: withSkills.url, subpath: 'no/such/folder' })
    assert.equal(badSub.code, 'not-found')

    assert.equal((await host.error('skill-settings/repos-add', { source: path.join(sandbox.base, 'missing') })).code, 'not-found')
    assert.equal((await host.error('skill-settings/repos-add', { source: 'relative/path/here' })).code, 'bad-request')
    assert.equal((await host.error('skill-settings/repos-add', { source: 'https://example.com/repo' })).code, 'bad-request')
    assert.equal((await host.error('skill-settings/repos-add', {})).code, 'bad-request')
    assert.equal((await host.error('skill-settings/repos-add', { source: withSkills.url, subpath: '../x' })).code, 'bad-request')

    assert.equal(await readState(sandbox.dshHome), undefined)
    const reposFolder = path.join(sandbox.dshHome, 'mcp-skills', 'repos')
    assert.deepEqual(await fs.readdir(reposFolder).catch(() => []), [])
    assert.deepEqual((await host.value('skill-settings/repos-list', {})).repositories, [])
  })

  it('clones a source once when it is added twice at the same time', async () => {
    const repo = await createGitRepo(sandbox.base, repoFiles())
    const host = createHost()
    const results = await Promise.all([
      host.value('skill-settings/repos-add', { source: repo.url }),
      host.value('skill-settings/repos-add', { source: `${repo.url}/` }),
    ])
    assert.deepEqual(results.map(result => result.existing), [false, true])
    assert.equal(results[0].repository.id, results[1].repository.id)
    assert.equal((await readState(sandbox.dshHome)).repositories.length, 1)
    assert.deepEqual(await fs.readdir(path.join(sandbox.dshHome, 'mcp-skills', 'repos')), [results[0].repository.id])
  })

  it('refuses to clone after the plugin is disposed', async () => {
    const repo = await createGitRepo(sandbox.base, repoFiles())
    const host = createHost()
    await host.dispose()
    assert.equal((await host.error('skill-settings/repos-add', { source: repo.url })).code, 'unavailable')
  })
})

describe('skill-settings/repos-get', { skip: gitSkip }, () => {
  it('adopts an identical untracked copy and leaves different or foreign copies untracked', async () => {
    const repo = await createGitRepo(sandbox.base, repoFiles())
    const host = createHost()
    const { repository } = await host.value('skill-settings/repos-add', { source: repo.url })
    await copyDir(path.join(repo.work, 'skills', 'pdf'), path.join(userDsh(), 'pdf'))
    await put(path.join(userAgents(), 'docx', 'SKILL.md'), skillText('docx', 'My own docx'))

    const detail = await host.value('skill-settings/repos-get', { id: repository.id })
    const [pdfCopy] = skillByKey(detail, 'skills/pdf').installs
    assert.deepEqual(pdfCopy, {
      skillId: path.join(userDsh(), 'pdf', 'SKILL.md'),
      root: 'user-dsh',
      path: path.join(userDsh(), 'pdf'),
      displayPath: path.join(userDsh(), 'pdf'),
      tracked: true,
      updateAvailable: false,
      modified: false,
      active: true,
    })
    const [docxCopy] = skillByKey(detail, 'skills/docx').installs
    assert.equal(docxCopy.tracked, false)
    assert.equal(docxCopy.root, 'user-agents')
    assert.deepEqual([detail.repository.installedCount, detail.repository.updateCount], [1, 0])

    const state = await readState(sandbox.dshHome)
    assert.deepEqual(state.installs.map(record => [record.path, record.repoId, record.key, record.name, record.commit]), [
      [path.join(userDsh(), 'pdf'), repository.id, 'skills/pdf', 'pdf', repo.head()],
    ])
    assert.equal(state.installs[0].sourceHash, state.installs[0].installedHash)

    const [origin] = await originOf(host, 'pdf')
    assert.deepEqual({ ...origin, installedAt: typeof origin.installedAt }, {
      repoId: repository.id, repoLabel: 'skills', key: 'skills/pdf', updateAvailable: false, modified: false, installedAt: 'number',
    })
    assert.deepEqual(await originOf(host, 'docx'), [null])

    // Another repository with the same pdf sees the copy as recorded for someone else.
    const other = path.join(sandbox.base, 'other-source')
    await copyDir(path.join(repo.work, 'skills', 'pdf'), path.join(other, 'pdf'))
    const second = await host.value('skill-settings/repos-add', { source: other })
    const [foreign] = skillByKey(second, 'pdf').installs
    assert.equal(foreign.tracked, false)
    assert.equal((await readState(sandbox.dshHome)).installs.length, 1)

    assert.equal((await host.error('skill-settings/repos-get', { id: 'aaaaaaaaaaaa' })).code, 'not-found')
    assert.equal((await host.error('skill-settings/repos-get', { id: '../etc' })).code, 'bad-request')
  })

  it('lists project copies only for the given workspace', async () => {
    const repo = await createGitRepo(sandbox.base, repoFiles())
    const project = path.join(sandbox.base, 'project')
    await fs.mkdir(path.join(project, '.git'), { recursive: true })
    await copyDir(path.join(repo.work, 'skills', 'docx'), path.join(project, '.agents', 'skills', 'docx'))
    const host = createHost()
    const { repository } = await host.value('skill-settings/repos-add', { source: repo.url, cwd: project })
    assert.deepEqual(skillByKey(await host.value('skill-settings/repos-get', { id: repository.id }), 'skills/docx').installs, [])
    const [copy] = skillByKey(await host.value('skill-settings/repos-get', { id: repository.id, cwd: project }), 'skills/docx').installs
    assert.deepEqual([copy.root, copy.tracked], ['project-agents', true])
    // Counts follow the workspace too.
    assert.equal((await host.value('skill-settings/repos-list', {})).repositories[0].installedCount, 0)
    assert.equal((await host.value('skill-settings/repos-list', { cwd: project })).repositories[0].installedCount, 1)
  })
})

describe('skill-settings/repos-install', { skip: gitSkip }, () => {
  it('installs new skills, records identical copies, and skips or overwrites existing ones', async () => {
    const repo = await createGitRepo(sandbox.base, repoFiles())
    await fs.symlink('reference.md', path.join(repo.work, 'skills', 'pdf', 'ref-link'))
    await repo.commit({}, 'add a link')
    const host = createHost()
    const { repository } = await host.value('skill-settings/repos-add', { source: repo.url })
    await put(path.join(userDsh(), 'docx', 'SKILL.md'), skillText('docx', 'old version'))
    await put(path.join(userDsh(), 'docx', 'old.txt'), 'old\n')

    const first = await host.value('skill-settings/repos-install', {
      id: repository.id,
      root: 'user-dsh',
      items: [
        { key: 'skills/pdf', overwrite: false },
        { key: 'skills/docx', overwrite: false },
        { key: 'skills/bad', overwrite: false },
        { key: 'nope', overwrite: true },
      ],
    })
    assert.deepEqual(first, {
      installed: [{ name: 'pdf', path: path.join(userDsh(), 'pdf') }],
      skipped: [{ name: 'docx', reason: 'exists' }],
      failed: [
        { name: 'bad', error: 'Frontmatter field "description" is missing or is not text' },
        { name: 'nope', error: 'No skill "nope" in skills' },
      ],
    })
    assert.deepEqual((await fs.readdir(path.join(userDsh(), 'pdf'))).sort(), ['SKILL.md', 'ref-link', 'reference.md'])
    assert.equal(await fs.readlink(path.join(userDsh(), 'pdf', 'ref-link')), 'reference.md')
    assert.match(await fs.readFile(path.join(userDsh(), 'docx', 'SKILL.md'), 'utf8'), /old version/)

    const identical = await host.value('skill-settings/repos-install', { id: repository.id, root: 'user-dsh', items: [{ key: 'skills/pdf', overwrite: false }] })
    assert.deepEqual(identical, { installed: [], skipped: [{ name: 'pdf', reason: 'identical' }], failed: [] })

    const overwrite = await host.value('skill-settings/repos-install', { id: repository.id, root: 'user-dsh', items: [{ key: 'skills/docx', overwrite: true }] })
    assert.deepEqual(overwrite, { installed: [{ name: 'docx', path: path.join(userDsh(), 'docx') }], skipped: [], failed: [] })
    assert.deepEqual(await fs.readdir(path.join(userDsh(), 'docx')), ['SKILL.md'])
    assert.deepEqual((await fs.readdir(userDsh())).filter(name => name.startsWith('.')), [])

    const state = await readState(sandbox.dshHome)
    assert.deepEqual(state.installs.map(record => [record.name, record.key]).sort(), [['docx', 'skills/docx'], ['pdf', 'skills/pdf']])
    const listed = await host.value('skill-settings/list', {})
    assert.deepEqual(listed.skills.map(item => [item.name, item.origin?.key, item.origin?.updateAvailable, item.origin?.modified]), [
      ['docx', 'skills/docx', false, false],
      ['pdf', 'skills/pdf', false, false],
    ])
    assert.equal((await host.value('skill-settings/repos-list', {})).repositories[0].installedCount, 2)

    // The detail and editor routes carry the origin too; an edit marks the skill as modified.
    const id = path.join(userDsh(), 'pdf', 'SKILL.md')
    assert.equal((await host.value('skill-settings/read', { id })).item.origin.key, 'skills/pdf')
    const saved = await host.value('skill-settings/save', {
      target: { create: false, id }, name: 'pdf', description: 'My PDFs', whenToUse: '', modelInvocable: true, userInvocable: true, body: '# pdf\n',
    })
    assert.deepEqual([saved.item.origin.repoId, saved.item.origin.updateAvailable, saved.item.origin.modified], [repository.id, false, true])
  })

  it('installs into another root and project roots, and validates the request', async () => {
    const repo = await createGitRepo(sandbox.base, repoFiles())
    const host = createHost()
    const { repository } = await host.value('skill-settings/repos-add', { source: repo.url })
    const project = path.join(sandbox.base, 'project')
    await fs.mkdir(path.join(project, '.git'), { recursive: true })
    const result = await host.value('skill-settings/repos-install', { id: repository.id, cwd: project, root: 'project-dsh', items: [{ key: 'skills/pdf', overwrite: false }] })
    assert.deepEqual(result.installed, [{ name: 'pdf', path: path.join(project, '.dsh', 'skills', 'pdf') }])

    const call = payload => host.error('skill-settings/repos-install', { id: repository.id, root: 'user-dsh', items: [{ key: 'skills/pdf', overwrite: false }], ...payload })
    assert.equal((await call({ items: [] })).code, 'bad-request')
    assert.equal((await call({ items: [{ key: 'skills/pdf' }] })).code, 'bad-request')
    assert.equal((await call({ items: Array.from({ length: 501 }, () => ({ key: 'x', overwrite: false })) })).code, 'bad-request')
    assert.equal((await call({ root: 'project-dsh' })).code, 'bad-request')
    assert.equal((await call({ root: 'elsewhere' })).code, 'bad-request')
    assert.equal((await call({ id: 'aaaaaaaaaaaa' })).code, 'not-found')
  })
})

describe('updates', { skip: gitSkip }, () => {
  it('finds a new commit on refresh, flags updates and local edits, and updates on request', async () => {
    const repo = await createGitRepo(sandbox.base, repoFiles())
    const host = createHost()
    const added = await host.value('skill-settings/repos-add', { source: repo.url })
    const id = added.repository.id
    const firstCommit = added.repository.commit
    const pdf = path.join(userDsh(), 'pdf')
    await host.value('skill-settings/repos-install', { id, root: 'user-dsh', items: [{ key: 'skills/pdf', overwrite: false }, { key: 'skills/docx', overwrite: false }] })

    const newCommit = await repo.commit({ 'skills/pdf/SKILL.md': skillText('pdf', 'Read PDFs, better') })
    // Nothing changes before a check: the cache is read, not the network.
    assert.equal(skillByKey(await host.value('skill-settings/repos-get', { id }), 'skills/pdf').installs[0].updateAvailable, false)

    const refreshed = await host.value('skill-settings/repos-refresh', { id })
    assert.equal(refreshed.repository.commit, newCommit)
    assert.notEqual(newCommit, firstCommit)
    assert.deepEqual([refreshed.repository.installedCount, refreshed.repository.updateCount], [2, 1])
    assert.equal(skillByKey(refreshed, 'skills/pdf').installs[0].updateAvailable, true)
    assert.equal(skillByKey(refreshed, 'skills/docx').installs[0].updateAvailable, false)
    assert.equal(skillByKey(await host.value('skill-settings/repos-get', { id }), 'skills/pdf').installs[0].updateAvailable, true)
    assert.deepEqual((await originOf(host, 'pdf')).map(origin => [origin.updateAvailable, origin.modified]), [[true, false]])
    assert.equal((await host.value('skill-settings/repos-list', {})).repositories[0].updateCount, 1)

    await fs.writeFile(path.join(pdf, 'reference.md'), 'my notes\n')
    assert.deepEqual((await originOf(host, 'pdf')).map(origin => [origin.updateAvailable, origin.modified]), [[true, true]])
    assert.equal(skillByKey(await host.value('skill-settings/repos-get', { id }), 'skills/pdf').installs[0].modified, true)

    const kept = await host.value('skill-settings/repos-update', { id, items: [{ path: pdf, force: false }] })
    assert.deepEqual(kept, { updated: [], skipped: [{ name: 'pdf', path: pdf, reason: 'modified' }], failed: [] })
    assert.equal(await fs.readFile(path.join(pdf, 'reference.md'), 'utf8'), 'my notes\n')

    const forced = await host.value('skill-settings/repos-update', { id, items: [{ path: pdf, force: true }] })
    assert.deepEqual(forced, { updated: [{ name: 'pdf', path: pdf }], skipped: [], failed: [] })
    assert.equal(await fs.readFile(path.join(pdf, 'reference.md'), 'utf8'), 'ref\n')
    assert.match(await fs.readFile(path.join(pdf, 'SKILL.md'), 'utf8'), /better/)
    assert.deepEqual((await originOf(host, 'pdf')).map(origin => [origin.updateAvailable, origin.modified]), [[false, false]])
    const record = (await readState(sandbox.dshHome)).installs.find(entry => entry.name === 'pdf')
    assert.equal(record.commit, newCommit)
    assert.equal(typeof record.updatedAt, 'number')
    assert.equal((await host.value('skill-settings/repos-list', {})).repositories[0].updateCount, 0)

    const current = await host.value('skill-settings/repos-update', { id, items: [{ path: pdf, force: false }, { path: path.join(userDsh(), 'docx'), force: false }] })
    assert.deepEqual(current.skipped.map(entry => [entry.name, entry.reason]), [['pdf', 'current'], ['docx', 'current']])
  })

  it('updates only recorded installs inside the allowed roots', async () => {
    const repo = await createGitRepo(sandbox.base, repoFiles())
    const host = createHost()
    const { repository } = await host.value('skill-settings/repos-add', { source: repo.url })
    const projectA = path.join(sandbox.base, 'project-a')
    const projectB = path.join(sandbox.base, 'project-b')
    for (const project of [projectA, projectB]) await fs.mkdir(path.join(project, '.git'), { recursive: true })
    await host.value('skill-settings/repos-install', { id: repository.id, cwd: projectA, root: 'project-dsh', items: [{ key: 'skills/pdf', overwrite: false }] })
    await repo.commit({ 'skills/pdf/SKILL.md': skillText('pdf', 'Read PDFs v2') })
    await host.value('skill-settings/repos-refresh', { id: repository.id })
    const installed = path.join(projectA, '.dsh', 'skills', 'pdf')
    const untracked = path.join(userDsh(), 'untracked')
    await put(path.join(untracked, 'SKILL.md'), skillText('untracked'))

    const forged = await host.value('skill-settings/repos-update', {
      id: repository.id,
      cwd: projectB,
      items: [
        { path: installed, force: true },
        { path: untracked, force: true },
        { path: '/etc', force: true },
        { path: 'relative/pdf', force: true },
      ],
    })
    assert.deepEqual(forged.updated, [])
    assert.deepEqual(forged.failed.map(entry => [entry.path, entry.error]), [
      [installed, 'forbidden'], [untracked, 'forbidden'], ['/etc', 'forbidden'], ['relative/pdf', 'forbidden'],
    ])
    assert.doesNotMatch(await fs.readFile(path.join(installed, 'SKILL.md'), 'utf8'), /v2/)

    const allowed = await host.value('skill-settings/repos-update', { id: repository.id, cwd: projectA, items: [{ path: installed, force: false }] })
    assert.deepEqual(allowed.updated, [{ name: 'pdf', path: installed }])
    assert.match(await fs.readFile(path.join(installed, 'SKILL.md'), 'utf8'), /v2/)
  })

  it('keeps the cache and records the error when a check fails, and downloads a missing cache again', async () => {
    const repo = await createGitRepo(sandbox.base, repoFiles())
    const host = createHost()
    const { repository } = await host.value('skill-settings/repos-add', { source: repo.url })
    await fs.rename(repo.bare, `${repo.bare}.moved`)
    const failure = await host.error('skill-settings/repos-refresh', { id: repository.id })
    assert.equal(failure.code, 'git-failed')
    const detail = await host.value('skill-settings/repos-get', { id: repository.id })
    assert.equal(detail.repository.lastError, failure.message)
    assert.equal(detail.repository.commit, repository.commit)
    assert.equal(detail.skills.length, 3)
    assert.equal((await host.value('skill-settings/repos-list', {})).repositories[0].lastError, failure.message)
    await fs.rename(`${repo.bare}.moved`, repo.bare)

    const recovered = await host.value('skill-settings/repos-refresh', { id: repository.id })
    assert.equal(recovered.repository.lastError, undefined)

    await fs.rm(cacheDir(repository.id), { recursive: true, force: true })
    const missing = await host.value('skill-settings/repos-get', { id: repository.id })
    assert.deepEqual(missing.skills, [])
    assert.equal(missing.repository.lastError, NOT_DOWNLOADED)
    const installMissing = await host.error('skill-settings/repos-install', { id: repository.id, root: 'user-dsh', items: [{ key: 'skills/pdf', overwrite: false }] })
    assert.equal(installMissing.code, 'not-found')
    const redownloaded = await host.value('skill-settings/repos-refresh', { id: repository.id })
    assert.equal(redownloaded.skills.length, 3)
    assert.equal(redownloaded.repository.lastError, undefined)
    await fs.access(path.join(cacheDir(repository.id), '.git'))
  })

  it('rescans a local folder only when checked', async () => {
    const folder = path.join(sandbox.base, 'local-skills')
    await put(path.join(folder, 'one', 'SKILL.md'), skillText('one', 'first'))
    const host = createHost()
    const { repository } = await host.value('skill-settings/repos-add', { source: folder })
    await host.value('skill-settings/repos-install', { id: repository.id, root: 'user-agents', items: [{ key: 'one', overwrite: false }] })
    await fs.writeFile(path.join(folder, 'one', 'SKILL.md'), skillText('one', 'first, revised'))
    await put(path.join(folder, 'two', 'SKILL.md'), skillText('two'))
    assert.equal((await host.value('skill-settings/repos-get', { id: repository.id })).skills.length, 1)
    const refreshed = await host.value('skill-settings/repos-refresh', { id: repository.id })
    assert.deepEqual(refreshed.skills.map(skill => skill.key), ['one', 'two'])
    assert.equal(skillByKey(refreshed, 'one').installs[0].updateAvailable, true)
    const updated = await host.value('skill-settings/repos-update', { id: repository.id, items: [{ path: path.join(userAgents(), 'one'), force: false }] })
    assert.equal(updated.updated.length, 1)
    assert.match(await fs.readFile(path.join(userAgents(), 'one', 'SKILL.md'), 'utf8'), /revised/)

    await fs.rm(folder, { recursive: true })
    const failure = await host.error('skill-settings/repos-refresh', { id: repository.id })
    assert.equal(failure.code, 'not-found')
    assert.equal((await host.value('skill-settings/repos-list', {})).repositories[0].lastError, failure.message)
  })
})

describe('skill-settings/repos-remove', { skip: gitSkip }, () => {
  it('forgets the install records and keeps the installed skills', async () => {
    const repo = await createGitRepo(sandbox.base, repoFiles())
    const host = createHost()
    const { repository } = await host.value('skill-settings/repos-add', { source: repo.url })
    await host.value('skill-settings/repos-install', { id: repository.id, root: 'user-dsh', items: [{ key: 'skills/pdf', overwrite: false }, { key: 'skills/docx', overwrite: false }] })
    assert.deepEqual(await host.value('skill-settings/repos-remove', { id: repository.id }), { removed: repository.id, forgotten: 2 })
    await assert.rejects(fs.access(cacheDir(repository.id)), { code: 'ENOENT' })
    await fs.access(path.join(userDsh(), 'pdf', 'SKILL.md'))
    assert.deepEqual(await originOf(host, 'pdf'), [null])
    assert.deepEqual(await readState(sandbox.dshHome), { version: 1, repositories: [], installs: [] })
    assert.equal((await host.error('skill-settings/repos-get', { id: repository.id })).code, 'not-found')
    assert.equal((await host.error('skill-settings/repos-remove', { id: repository.id })).code, 'not-found')
  })
})

describe('install records', { skip: gitSkip }, () => {
  it('are forgotten by skills-delete; a symlinked skill keeps its target', async () => {
    const repo = await createGitRepo(sandbox.base, repoFiles())
    const host = createHost()
    const { repository } = await host.value('skill-settings/repos-add', { source: repo.url })
    await host.value('skill-settings/repos-install', { id: repository.id, root: 'user-dsh', items: [{ key: 'skills/pdf', overwrite: false }] })
    const external = path.join(sandbox.base, 'external', 'docx')
    await copyDir(path.join(repo.work, 'skills', 'docx'), external)
    await fs.mkdir(userAgents(), { recursive: true })
    await fs.symlink(external, path.join(userAgents(), 'docx'))
    // The identical symlinked copy is adopted.
    assert.equal(skillByKey(await host.value('skill-settings/repos-get', { id: repository.id }), 'skills/docx').installs[0].tracked, true)
    assert.equal((await readState(sandbox.dshHome)).installs.length, 2)

    const pdfId = path.join(userDsh(), 'pdf', 'SKILL.md')
    const docxId = path.join(userAgents(), 'docx', 'SKILL.md')
    const missingId = path.join(userDsh(), 'missing', 'SKILL.md')
    const result = await host.value('skill-settings/delete', { ids: [pdfId, missingId, docxId] })
    assert.deepEqual(result.removed.map(entry => entry.name), ['pdf', 'docx'])
    assert.deepEqual(result.failed.map(entry => [entry.id, entry.name]), [[missingId, 'missing']])
    await assert.rejects(fs.lstat(path.join(userAgents(), 'docx')), { code: 'ENOENT' })
    await fs.access(path.join(external, 'SKILL.md'))
    assert.deepEqual((await readState(sandbox.dshHome)).installs, [])
  })

  it('drop records whose folder is gone', async () => {
    const repo = await createGitRepo(sandbox.base, repoFiles())
    const host = createHost()
    const { repository } = await host.value('skill-settings/repos-add', { source: repo.url })
    await host.value('skill-settings/repos-install', { id: repository.id, root: 'user-dsh', items: [{ key: 'skills/pdf', overwrite: false }] })
    await fs.rm(path.join(userDsh(), 'pdf'), { recursive: true })
    assert.equal((await host.value('skill-settings/list', {})).skills.length, 0)
    assert.deepEqual((await readState(sandbox.dshHome)).installs, [])
    assert.equal((await host.value('skill-settings/repos-list', {})).repositories[0].installedCount, 0)
  })
})

describe('state file', () => {
  it('moves an unusable state file aside, logs it, and starts empty', async () => {
    const dir = path.join(sandbox.dshHome, 'mcp-skills')
    const file = path.join(dir, 'state.json')
    await put(file, '{ not json')
    const host = createHost()
    assert.deepEqual(await host.value('skill-settings/repos-list', {}), { repositories: [] })
    const aside = (await fs.readdir(dir)).filter(name => name.startsWith('state.json.corrupt-'))
    assert.equal(aside.length, 1)
    assert.equal(await fs.readFile(path.join(dir, aside[0]), 'utf8'), '{ not json')
    assert.ok(host.warnings.some(message => message.includes('state.json') && message.includes('corrupt-')), host.warnings.join('\n'))
    await assert.rejects(fs.access(file), { code: 'ENOENT' })

    // Another version is never overwritten either.
    await put(file, JSON.stringify({ version: 2, repositories: [], installs: [] }))
    const folder = path.join(sandbox.base, 'local-skills')
    await put(path.join(folder, 'one', 'SKILL.md'), skillText('one'))
    await host.value('skill-settings/repos-add', { source: folder })
    assert.equal((await fs.readdir(dir)).filter(name => name.startsWith('state.json.corrupt-')).length, 2)
    const state = await readState(sandbox.dshHome)
    assert.equal(state.repositories.length, 1)
    if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600)

    // A corrupt file does not break the skill listing.
    await fs.writeFile(file, '[]')
    await put(path.join(sandbox.dshHome, 'skills', 'mine', 'SKILL.md'), skillText('mine'))
    assert.deepEqual((await host.value('skill-settings/list', {})).skills.map(item => [item.name, item.origin ?? null]), [['mine', null]])
  })

  it('drops malformed entries and records of unknown repositories', async () => {
    const folder = path.join(sandbox.base, 'local-skills')
    await put(path.join(folder, 'one', 'SKILL.md'), skillText('one'))
    const host = createHost()
    const { repository } = await host.value('skill-settings/repos-add', { source: folder })
    const file = path.join(sandbox.dshHome, 'mcp-skills', 'state.json')
    const state = JSON.parse(await fs.readFile(file, 'utf8'))
    state.repositories.push({ id: 'not-an-id' })
    state.installs.push({ path: '/x', repoId: 'bbbbbbbbbbbb', key: 'k', name: 'k', sourceHash: 'a'.repeat(64), installedHash: 'a'.repeat(64), installedAt: 1 })
    await fs.writeFile(file, JSON.stringify(state))
    assert.deepEqual((await host.value('skill-settings/repos-list', {})).repositories.map(entry => entry.id), [repository.id])
    assert.ok(host.warnings.some(message => message.includes('malformed')))
  })
})
