import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { parseSource } from '../host/importer.js'
import { createHost, createSandbox, put, skillText } from './support.mjs'

let sandbox
beforeEach(async () => { sandbox = await createSandbox() })
afterEach(async () => { await sandbox.restore() })

let gitAvailable = true
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' })
} catch {
  // Git-backed tests are skipped below.
  gitAvailable = false
}

/** A folder of skills: two at different depths, nested and excluded folders, and one invalid skill. */
async function seedSource(root) {
  await put(path.join(root, 'README.md'), 'collection\n')
  await put(path.join(root, 'one', 'SKILL.md'), skillText('one', 'first skill'))
  await put(path.join(root, 'one', 'scripts', 'run.sh'), '#!/bin/sh\n')
  await fs.symlink('scripts/run.sh', path.join(root, 'one', 'run-link'))
  await put(path.join(root, 'group', 'two', 'SKILL.md'), skillText('two', 'second skill'))
  await put(path.join(root, 'group', 'two', 'nested', 'SKILL.md'), skillText('nested'))
  await put(path.join(root, 'deep', 'a', 'b', 'c', 'd', 'SKILL.md'), skillText('depth-five'))
  await put(path.join(root, 'deep', 'a', 'b', 'c', 'd', 'e', 'SKILL.md'), skillText('depth-six'))
  await put(path.join(root, 'node_modules', 'pkg', 'SKILL.md'), skillText('in-node-modules'))
  await put(path.join(root, 'bad', 'SKILL.md'), '---\nname: bad\n---\nno description\n')
}

async function tempClones() {
  return (await fs.readdir(sandbox.tmp)).filter(name => name.startsWith('dsh-mcp-skills-'))
}

describe('skills-scan', () => {
  it('finds SKILL.md folders in a local folder', async () => {
    const source = path.join(sandbox.base, 'source')
    await seedSource(source)
    await put(path.join(source, 'one', '.git', 'HEAD'), 'ref\n')
    const value = await createHost().value('skills-scan', { source })
    assert.equal(value.label, source)
    assert.equal(typeof value.scanId, 'string')
    assert.deepEqual(value.candidates, [
      { key: 'bad', name: 'bad', description: '', valid: false, error: 'Frontmatter field "description" is missing or is not text', fileCount: 1 },
      { key: 'deep/a/b/c/d', name: 'depth-five', description: 'depth-five description', valid: true, fileCount: 2 },
      { key: 'group/two', name: 'two', description: 'second skill', valid: true, fileCount: 2 },
      { key: 'one', name: 'one', description: 'first skill', valid: true, fileCount: 3 },
    ])
    assert.deepEqual(await tempClones(), [])
  })

  it('treats a folder with SKILL.md at its top as one candidate', async () => {
    const source = path.join(sandbox.base, 'single')
    await put(path.join(source, 'SKILL.md'), skillText('single'))
    await put(path.join(source, 'sub', 'SKILL.md'), skillText('sub'))
    const value = await createHost().value('skills-scan', { source })
    assert.deepEqual(value.candidates.map(candidate => [candidate.key, candidate.name]), [['.', 'single']])
  })

  it('rejects missing folders and unsupported sources', async () => {
    const host = createHost()
    assert.equal((await host.error('skills-scan', { source: path.join(sandbox.base, 'missing') })).code, 'not-found')
    assert.equal((await host.error('skills-scan', { source: 'relative/path/here' })).code, 'bad-request')
    assert.equal((await host.error('skills-scan', { source: 'https://example.com/repo' })).code, 'bad-request')
    assert.equal((await host.error('skills-scan', { source: '' })).code, 'bad-request')
    assert.equal((await host.error('skills-scan', {})).code, 'bad-request')
  })
})

describe('parseSource', () => {
  it('parses GitHub links, shorthands, Git URLs, and local paths', () => {
    assert.deepEqual(parseSource('https://github.com/anthropics/skills'),
      { kind: 'git', url: 'https://github.com/anthropics/skills.git', label: 'anthropics/skills', repoName: 'skills' })
    assert.deepEqual(parseSource('github.com/anthropics/skills.git/tree/main/skills/pdf/'),
      { kind: 'git', url: 'https://github.com/anthropics/skills.git', label: 'anthropics/skills', repoName: 'skills', ref: 'main', subpath: ['skills', 'pdf'] })
    assert.deepEqual(parseSource(' anthropics/skills '),
      { kind: 'git', url: 'https://github.com/anthropics/skills.git', label: 'anthropics/skills', repoName: 'skills' })
    assert.equal(parseSource('anthropics/skills.git').url, 'https://github.com/anthropics/skills.git')
    assert.deepEqual(parseSource('https://github.com/o/r?tab=readme'),
      { kind: 'git', url: 'https://github.com/o/r.git', label: 'o/r', repoName: 'r' })
    assert.deepEqual(parseSource('git@gitlab.com:team/tools.git'),
      { kind: 'git', url: 'git@gitlab.com:team/tools.git', label: 'gitlab.com:team/tools', repoName: 'tools' })
    assert.deepEqual(parseSource('https://gitlab.com/team/tools.git'),
      { kind: 'git', url: 'https://gitlab.com/team/tools.git', label: 'gitlab.com/team/tools', repoName: 'tools' })
    assert.deepEqual(parseSource('~/Downloads/my-skill'),
      { kind: 'local', path: path.join(os.homedir(), 'Downloads', 'my-skill'), label: '~/Downloads/my-skill' })
    assert.throws(() => parseSource('https://github.com/o/r/tree/main/../secret'), { code: 'bad-request' })
    assert.throws(() => parseSource('https://github.com/o/r/tree/-x'), { code: 'bad-request' })
    assert.throws(() => parseSource('~other/x'), { code: 'bad-request' })
    assert.throws(() => parseSource('ext::sh -c touch% /tmp/pwned'), { code: 'bad-request' })
  })
})

describe('skills-install', () => {
  it('installs selected skills, skipping or overwriting existing ones', async () => {
    const source = path.join(sandbox.base, 'source')
    await seedSource(source)
    await put(path.join(source, 'one', '.git', 'HEAD'), 'ref\n')
    const userDsh = path.join(sandbox.dshHome, 'skills')
    await put(path.join(userDsh, 'one', 'SKILL.md'), skillText('one', 'old version'))
    await put(path.join(userDsh, 'one', 'old.txt'), 'old\n')
    const host = createHost()

    const first = await host.value('skills-scan', { source })
    const result = await host.value('skills-install', {
      scanId: first.scanId,
      root: 'user-dsh',
      items: [{ key: 'one', overwrite: false }, { key: 'group/two', overwrite: false }, { key: 'bad', overwrite: false }, { key: 'nope', overwrite: true }],
    })
    assert.deepEqual(result, {
      installed: ['two'],
      skipped: ['one'],
      failed: [
        { name: 'bad', error: 'Frontmatter field "description" is missing or is not text' },
        { name: 'nope', error: 'No skill "nope" in this scan' },
      ],
    })
    assert.equal(await fs.readFile(path.join(userDsh, 'two', 'SKILL.md'), 'utf8'), skillText('two', 'second skill'))
    assert.match(await fs.readFile(path.join(userDsh, 'one', 'SKILL.md'), 'utf8'), /old version/)
    // The scan is consumed by the install.
    assert.equal((await host.error('skills-install', { scanId: first.scanId, root: 'user-dsh', items: [{ key: 'one', overwrite: true }] })).code, 'not-found')

    const second = await host.value('skills-scan', { source })
    const overwrite = await host.value('skills-install', { scanId: second.scanId, root: 'user-dsh', items: [{ key: 'one', overwrite: true }] })
    assert.deepEqual(overwrite, { installed: ['one'], skipped: [], failed: [] })
    assert.deepEqual((await fs.readdir(path.join(userDsh, 'one'))).sort(), ['SKILL.md', 'run-link', 'scripts'])
    assert.equal(await fs.readlink(path.join(userDsh, 'one', 'run-link')), 'scripts/run.sh')
    assert.deepEqual((await fs.readdir(userDsh)).filter(name => name.startsWith('.')), [])

    const listed = await host.value('skills-list', {})
    assert.deepEqual(listed.skills.map(item => [item.name, item.description]), [['one', 'first skill'], ['two', 'second skill']])
  })

  it('validates the request', async () => {
    const source = path.join(sandbox.base, 'source')
    await seedSource(source)
    const host = createHost()
    const scan = await host.value('skills-scan', { source })
    assert.equal((await host.error('skills-install', { scanId: scan.scanId, root: 'user-dsh', items: [] })).code, 'bad-request')
    assert.equal((await host.error('skills-install', { scanId: scan.scanId, root: 'user-dsh', items: [{ key: 'one' }] })).code, 'bad-request')
    assert.equal((await host.error('skills-install', { scanId: scan.scanId, root: 'project-dsh', items: [{ key: 'one', overwrite: false }] })).code, 'bad-request')
    assert.equal((await host.error('skills-install', { scanId: 'unknown', root: 'user-dsh', items: [{ key: 'one', overwrite: false }] })).code, 'not-found')
  })
})

describe('git sources', { skip: gitAvailable ? false : 'git is not installed' }, () => {
  async function createRepository() {
    const work = path.join(sandbox.base, 'work')
    await put(path.join(work, 'skills', 'pdf', 'SKILL.md'), skillText('pdf', 'Read PDFs'))
    await put(path.join(work, 'skills', 'pdf', 'reference.md'), 'ref\n')
    await put(path.join(work, 'skills', 'docx', 'SKILL.md'), skillText('docx', 'Edit documents'))
    const git = (...args) => execFileSync('git', args, {
      cwd: work,
      stdio: 'ignore',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    })
    git('init', '-q', '-b', 'main')
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'skills')
    const bare = path.join(sandbox.base, 'skills.git')
    execFileSync('git', ['clone', '-q', '--bare', work, bare], { stdio: 'ignore' })
    return pathToFileURL(bare).href
  }

  it('clones into a temporary folder, scans it, and removes the clone after install', async () => {
    const url = await createRepository()
    const host = createHost()
    const scan = await host.value('skills-scan', { source: url })
    assert.equal(scan.label, path.join(sandbox.base, 'skills.git'))
    assert.deepEqual(scan.candidates, [
      { key: 'skills/docx', name: 'docx', description: 'Edit documents', valid: true, fileCount: 1 },
      { key: 'skills/pdf', name: 'pdf', description: 'Read PDFs', valid: true, fileCount: 2 },
    ])
    assert.equal((await tempClones()).length, 1)

    const result = await host.value('skills-install', { scanId: scan.scanId, root: 'user-agents', items: [{ key: 'skills/pdf', overwrite: false }] })
    assert.deepEqual(result, { installed: ['pdf'], skipped: [], failed: [] })
    const installed = path.join(sandbox.agentsHome, 'skills', 'pdf')
    assert.deepEqual((await fs.readdir(installed)).sort(), ['SKILL.md', 'reference.md'])
    assert.deepEqual(await tempClones(), [])
  })

  it('removes clones when the plugin is disposed and reports clone failures', async () => {
    const url = await createRepository()
    const host = createHost()
    await host.value('skills-scan', { source: url })
    await host.value('skills-scan', { source: url })
    assert.equal((await tempClones()).length, 2)
    await host.dispose()
    assert.deepEqual(await tempClones(), [])
    assert.equal((await host.error('skills-scan', { source: url })).code, 'unavailable')

    const missing = pathToFileURL(path.join(sandbox.base, 'missing.git')).href
    const failure = await createHost().error('skills-scan', { source: missing })
    assert.equal(failure.code, 'git-failed')
    assert.match(failure.message, /missing/)
    assert.deepEqual(await tempClones(), [])
  })
})
