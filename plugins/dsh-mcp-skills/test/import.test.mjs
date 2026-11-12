// Unit tests of the repository import internals: source parsing and identity, license exclusions, and the
// content hash. Route-level repository behavior is in repos.test.mjs.

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { HASH_LIMITS, hashDirectory } from '../host/hash.js'
import { findCandidates, parseSource, parseSubpath } from '../host/importer.js'
import { parseState } from '../host/repo-state.js'
import { LICENSE_EXCLUSIONS, applyLicenseExclusions, describeSource, foldSameName } from '../host/repos.js'
import { createSandbox, put, skillText } from './support.mjs'

let sandbox
beforeEach(async () => { sandbox = await createSandbox() })
afterEach(async () => { await sandbox.restore() })

describe('parseSource', () => {
  it('parses GitHub links, shorthands, Git URLs, and local paths', () => {
    const github = { owner: 'anthropics', repo: 'skills' }
    assert.deepEqual(parseSource('https://github.com/anthropics/skills'),
      { kind: 'git', url: 'https://github.com/anthropics/skills.git', label: 'anthropics/skills', repoName: 'skills', github })
    assert.deepEqual(parseSource('github.com/anthropics/skills.git/tree/main/skills/pdf/'),
      { kind: 'git', url: 'https://github.com/anthropics/skills.git', label: 'anthropics/skills', repoName: 'skills', github, ref: 'main', subpath: ['skills', 'pdf'] })
    assert.deepEqual(parseSource(' anthropics/skills '),
      { kind: 'git', url: 'https://github.com/anthropics/skills.git', label: 'anthropics/skills', repoName: 'skills', github })
    assert.equal(parseSource('anthropics/skills.git').url, 'https://github.com/anthropics/skills.git')
    // `/tree/HEAD` names the default branch, which is what no ref means.
    assert.equal(parseSource('https://github.com/anthropics/skills/tree/HEAD/skills').ref, undefined)
    assert.deepEqual(parseSource('https://github.com/o/r?tab=readme'),
      { kind: 'git', url: 'https://github.com/o/r.git', label: 'o/r', repoName: 'r', github: { owner: 'o', repo: 'r' } })
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
    assert.throws(() => parseSource('relative/path/here'), { code: 'bad-request' })
    assert.throws(() => parseSource('https://example.com/repo'), { code: 'bad-request' })
    assert.throws(() => parseSource('   '), { code: 'bad-request' })
  })

  it('parses the subpath field', () => {
    assert.equal(parseSubpath(undefined), undefined)
    assert.equal(parseSubpath(''), undefined)
    assert.equal(parseSubpath('/'), undefined)
    assert.deepEqual(parseSubpath('/skills/.curated/'), ['skills', '.curated'])
    assert.throws(() => parseSubpath('skills/../x'), { code: 'bad-request' })
    assert.throws(() => parseSubpath(3), { code: 'bad-request' })
  })
})

describe('repository identity', () => {
  it('gives every spelling of one GitHub source the same id, and different sources different ids', () => {
    const id = (source, subpath) => describeSource(parseSource(source), parseSubpath(subpath)).id
    const base = id('anthropics/skills')
    assert.match(base, /^[0-9a-f]{12}$/)
    for (const spelling of ['github.com/anthropics/skills', 'https://github.com/anthropics/skills.git', 'https://github.com/Anthropics/Skills/', 'http://www.github.com/anthropics/skills', 'https://github.com/anthropics/skills/tree/HEAD']) {
      assert.equal(id(spelling), base, spelling)
    }
    const sub = id('anthropics/skills', 'skills')
    assert.notEqual(sub, base)
    // The subpath field wins over a folder in the link.
    assert.equal(id('https://github.com/anthropics/skills/tree/HEAD/other', 'skills'), sub)
    assert.equal(id('https://github.com/anthropics/skills/tree/HEAD/skills'), sub)
    assert.notEqual(id('https://github.com/anthropics/skills/tree/main/skills'), sub)
    assert.equal(id('file:///tmp/x/skills.git'), id('file:///tmp/x/skills.git/'))
  })

  it('derives labels, sources, and GitHub links', () => {
    assert.deepEqual(describeSource(parseSource('anthropics/skills'), ['skills']), {
      id: describeSource(parseSource('anthropics/skills'), ['skills']).id,
      kind: 'git',
      label: 'anthropics/skills',
      source: 'https://github.com/anthropics/skills/tree/HEAD/skills',
      url: 'https://github.com/anthropics/skills.git',
      webUrl: 'https://github.com/anthropics/skills/tree/HEAD/skills',
      subpath: 'skills',
    })
    const tree = describeSource(parseSource('https://github.com/o/r/tree/v1.2'))
    assert.equal(tree.webUrl, 'https://github.com/o/r/tree/v1.2')
    assert.equal(tree.ref, 'v1.2')
    const other = describeSource(parseSource('https://user:secret@gitlab.com/team/tools.git'))
    assert.equal(other.label, 'tools')
    assert.equal(other.source, 'https://user:***@gitlab.com/team/tools.git')
    assert.equal(other.webUrl, undefined)
    const local = describeSource({ kind: 'local', path: path.join(os.homedir(), 'skills') })
    assert.deepEqual([local.kind, local.label, local.source, local.path], ['local', '~/skills', '~/skills', path.join(os.homedir(), 'skills')])
  })

  it('lists one candidate per name, preferring valid, visible, shallow folders', () => {
    const c = (key, name, valid = true) => ({ key, name, valid })
    const folded = foldSameName([
      c('.openclaw/skills/ponytail', 'ponytail'),
      c('.openclaw/skills/ponytail-help', 'ponytail-help'),
      c('nested/deeper/ponytail-help', 'ponytail-help'),
      c('skills/ponytail', 'ponytail'),
      c('skills/broken', 'broken', false),
      c('.alt/broken', 'broken'),
      c('.curated/only-hidden', 'only-hidden'),
    ])
    assert.deepEqual(folded.map(x => [x.key, x.alsoAt ?? []]), [
      ['nested/deeper/ponytail-help', ['.openclaw/skills/ponytail-help']],
      ['skills/ponytail', ['.openclaw/skills/ponytail']],
      ['.alt/broken', ['skills/broken']],
      ['.curated/only-hidden', []],
    ])
  })

  it('drops the subfolder from labels stored before 0.2.0', () => {
    const repo = (id, label, subpath) => ({
      id, kind: 'git', label, source: 'https://github.com/anthropics/skills', url: 'https://github.com/anthropics/skills.git',
      addedAt: 1, ...(subpath === undefined ? {} : { subpath }),
    })
    const { state } = parseState(JSON.stringify({ version: 1, installs: [], repositories: [
      repo('aaaaaaaaaaaa', 'anthropics/skills/skills', 'skills'),
      repo('bbbbbbbbbbbb', 'openai/skills/skills/.curated', 'skills/.curated'),
      repo('cccccccccccc', 'skills', 'skills'),
      repo('dddddddddddd', 'anthropics/skills'),
    ] }))
    assert.deepEqual(state.repositories.map(entry => entry.label), ['anthropics/skills', 'openai/skills', 'skills', 'anthropics/skills'])
  })
})

describe('license exclusions', () => {
  it('marks restricted anthropics/skills folders as not installable', () => {
    assert.deepEqual([...LICENSE_EXCLUSIONS['anthropics/skills'].dirs], ['docx', 'pdf', 'pptx', 'xlsx'])
    const candidates = () => [
      { key: 'skills/pdf', valid: true, hash: 'a' },
      { key: 'skills/docx', valid: true, hash: 'b' },
      { key: 'skills/pdf-tools', valid: true, hash: 'c' },
      { key: 'skills/frontend-design', valid: true, hash: 'd' },
    ]
    const restricted = candidates()
    applyLicenseExclusions('anthropics/skills', restricted, 'skills')
    assert.deepEqual(restricted.map(candidate => [candidate.key, candidate.valid, candidate.error ?? null, candidate.hash ?? null]), [
      ['skills/pdf', false, 'Licensed for use within Anthropic products only; not installable', null],
      ['skills/docx', false, 'Licensed for use within Anthropic products only; not installable', null],
      ['skills/pdf-tools', true, null, 'c'],
      ['skills/frontend-design', true, null, 'd'],
    ])
    // A repository scanned at the restricted folder itself (`key: '.'`) is matched by the folder name.
    const root = [{ key: '.', valid: true, hash: 'e' }]
    applyLicenseExclusions('anthropics/skills', root, 'xlsx')
    assert.equal(root[0].valid, false)
    const other = candidates()
    applyLicenseExclusions('someone/skills', other, 'skills')
    applyLicenseExclusions(undefined, other, 'skills')
    assert.ok(other.every(candidate => candidate.valid))
  })
})

describe('findCandidates', () => {
  it('finds SKILL.md folders up to depth 5, skipping node_modules and nested skills', async () => {
    const root = path.join(sandbox.base, 'source')
    await put(path.join(root, 'README.md'), 'collection\n')
    await put(path.join(root, 'one', 'SKILL.md'), skillText('one', 'first skill'))
    await put(path.join(root, 'one', 'scripts', 'run.sh'), '#!/bin/sh\n')
    await fs.symlink('scripts/run.sh', path.join(root, 'one', 'run-link'))
    await put(path.join(root, 'one', '.git', 'HEAD'), 'ref\n')
    await put(path.join(root, 'group', 'two', 'SKILL.md'), skillText('two', 'second skill'))
    await put(path.join(root, 'group', 'two', 'nested', 'SKILL.md'), skillText('nested'))
    await put(path.join(root, 'deep', 'a', 'b', 'c', 'd', 'SKILL.md'), skillText('depth-five'))
    await put(path.join(root, 'deep', 'a', 'b', 'c', 'd', 'e', 'SKILL.md'), skillText('depth-six'))
    await put(path.join(root, 'node_modules', 'pkg', 'SKILL.md'), skillText('in-node-modules'))
    await put(path.join(root, 'bad', 'SKILL.md'), '---\nname: bad\n---\nno description\n')
    assert.deepEqual(await findCandidates(root, 'source'), [
      { key: 'bad', name: 'bad', description: '', valid: false, error: 'Frontmatter field "description" is missing or is not text', fileCount: 1 },
      { key: 'deep/a/b/c/d', name: 'depth-five', description: 'depth-five description', valid: true, fileCount: 2 },
      { key: 'group/two', name: 'two', description: 'second skill', valid: true, fileCount: 2 },
      { key: 'one', name: 'one', description: 'first skill', valid: true, fileCount: 3 },
    ])
  })
})

describe('hashDirectory', () => {
  it('depends on paths, contents, and link targets, but not on .git or timestamps', async () => {
    const a = path.join(sandbox.base, 'a')
    const b = path.join(sandbox.base, 'b')
    for (const dir of [a, b]) {
      await put(path.join(dir, 'SKILL.md'), skillText('same'))
      await put(path.join(dir, 'refs', 'one.md'), 'one\n')
      await fs.symlink('refs/one.md', path.join(dir, 'link'))
    }
    await put(path.join(b, '.git', 'HEAD'), 'ref\n')
    await fs.utimes(path.join(b, 'SKILL.md'), new Date(0), new Date(0))
    const first = await hashDirectory(a)
    assert.match(first.hash, /^[0-9a-f]{64}$/)
    assert.equal(first.files, 3)
    assert.equal(first.truncated, false)
    assert.equal((await hashDirectory(b)).hash, first.hash)

    await fs.writeFile(path.join(b, 'refs', 'one.md'), 'changed\n')
    assert.notEqual((await hashDirectory(b)).hash, first.hash)
    await fs.writeFile(path.join(b, 'refs', 'one.md'), 'one\n')
    await fs.rm(path.join(b, 'link'))
    await fs.symlink('SKILL.md', path.join(b, 'link'))
    assert.notEqual((await hashDirectory(b)).hash, first.hash)
    await fs.rm(path.join(b, 'link'))
    await fs.symlink('refs/one.md', path.join(b, 'link'))
    await fs.rename(path.join(b, 'refs', 'one.md'), path.join(b, 'refs', 'two.md'))
    assert.notEqual((await hashDirectory(b)).hash, first.hash)
    await assert.rejects(hashDirectory(path.join(sandbox.base, 'missing')))
  })

  it('stops at the file and depth bounds and marks the hash as truncated', async () => {
    const wide = path.join(sandbox.base, 'wide')
    for (let i = 0; i <= HASH_LIMITS.maxFiles; i++) await put(path.join(wide, `f${String(i).padStart(4, '0')}`), `${i}\n`)
    const result = await hashDirectory(wide)
    assert.equal(result.truncated, true)
    assert.equal(result.files, HASH_LIMITS.maxFiles)

    const deep = path.join(sandbox.base, 'deep')
    const segments = Array.from({ length: HASH_LIMITS.maxDepth }, (_, i) => `d${i}`)
    await put(path.join(deep, ...segments, 'too-deep.txt'), 'x\n')
    await put(path.join(deep, 'top.txt'), 'x\n')
    const bounded = await hashDirectory(deep)
    assert.equal(bounded.truncated, true)
    assert.equal(bounded.files, 1)
  })
})
