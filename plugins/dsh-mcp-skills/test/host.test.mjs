import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { assertDirectChild, skillRoots } from '../host/paths.js'
import { createHost, createSandbox, fakePresets, fakeSkills, put, skillText } from './support.mjs'

let sandbox
beforeEach(async () => { sandbox = await createSandbox() })
afterEach(async () => { await sandbox.restore() })

/** Project with `.git`, a workspace below it, and skills in project and user roots. */
async function seedWorkspace() {
  const project = path.join(sandbox.base, 'project')
  const cwd = path.join(project, 'packages', 'app')
  await fs.mkdir(path.join(project, '.git'), { recursive: true })
  await fs.mkdir(cwd, { recursive: true })
  const userDsh = path.join(sandbox.dshHome, 'skills')
  const userAgents = path.join(sandbox.agentsHome, 'skills')
  const external = path.join(sandbox.base, 'external', 'gamma')
  await put(path.join(project, '.agents', 'skills', 'alpha', 'SKILL.md'), skillText('alpha', 'project alpha'))
  await put(path.join(userDsh, 'alpha', 'SKILL.md'), skillText('alpha', 'user alpha'))
  await put(path.join(userDsh, 'beta.md'), skillText('beta', 'flat beta', 'disable-model-invocation: true\n'))
  await put(path.join(userDsh, '.system', 'sys', 'SKILL.md'), skillText('sys'))
  await put(path.join(userDsh, 'broken', 'SKILL.md'), skillText('Bad_Name'))
  await put(path.join(userDsh, 'notes', 'README.md'), 'not a skill\n')
  await put(path.join(userDsh, 'readme.txt'), 'ignored\n')
  await put(path.join(userAgents, 'beta', 'SKILL.md'), skillText('beta', 'agents beta', 'user-invocable: false\n'))
  await put(path.join(external, 'SKILL.md'), skillText('gamma', 'linked gamma'))
  await fs.symlink(external, path.join(userAgents, 'gamma'))
  return { project, cwd, userDsh, userAgents, external }
}

function summary(item) {
  return [item.scope, item.root, item.name, item.layout, item.active, item.shadowedBy?.root ?? null]
}

describe('skills-list', () => {
  it('lists project and user roots with rank-based shadowing when the registry is absent', async () => {
    const { project, cwd, userDsh, userAgents } = await seedWorkspace()
    const host = createHost()
    const value = await host.value('skills-list', { cwd })
    assert.equal(value.projectRoot, project)
    assert.equal(value.complete, false)
    assert.deepEqual(value.roots.map(root => [root.id, root.rank, root.exists]), [
      ['project-dsh', 100, false], ['project-agents', 200, true], ['user-dsh', 400, true], ['user-agents', 500, true],
    ])
    assert.equal(value.roots[2].path, userDsh)
    assert.deepEqual(value.skills.map(summary), [
      ['project', 'project-agents', 'alpha', 'bundle', true, null],
      ['user', 'user-dsh', 'alpha', 'bundle', false, 'project-agents'],
      ['user', 'user-dsh', 'beta', 'flat', true, null],
      ['user', 'user-agents', 'beta', 'bundle', false, 'user-dsh'],
      ['user', 'user-dsh', 'broken', 'bundle', false, null],
      ['user', 'user-agents', 'gamma', 'bundle', true, null],
    ])
    const [projectAlpha, userAlpha, flatBeta, agentsBeta, broken, gamma] = value.skills
    assert.equal(projectAlpha.id, path.join(project, '.agents', 'skills', 'alpha', 'SKILL.md'))
    assert.deepEqual(userAlpha.shadowedBy, { id: projectAlpha.id, displayPath: projectAlpha.displayPath, root: 'project-agents' })
    assert.equal(flatBeta.dir, path.join(userDsh, 'beta.md'))
    assert.equal(flatBeta.modelInvocable, false)
    assert.equal(agentsBeta.userInvocable, false)
    assert.match(broken.invalid, /Invalid skill name "Bad_Name"/)
    assert.equal(gamma.dir, path.join(userAgents, 'gamma'))
    assert.ok(value.skills.every(item => item.editable === true && item.source === item.root))
  })

  it('omits project roots without a workspace and rejects a relative or missing workspace', async () => {
    await seedWorkspace()
    const host = createHost()
    const value = await host.value('skills-list', {})
    assert.equal(value.projectRoot, undefined)
    assert.deepEqual(value.roots.map(root => root.id), ['user-dsh', 'user-agents'])
    assert.equal((await host.error('skills-list', { cwd: 'relative/path' })).code, 'bad-request')
    assert.equal((await host.error('skills-list', { cwd: path.join(sandbox.base, 'missing') })).code, 'bad-request')
  })

  it('follows the registry winners and adds skills from other sources as read-only built-ins', async () => {
    const { project, cwd, external } = await seedWorkspace()
    const bundled = path.join(sandbox.base, 'bundled', 'helper', 'SKILL.md')
    await put(bundled, skillText('helper'))
    const skills = fakeSkills([
      { name: 'alpha', description: 'project alpha', path: path.join(project, '.agents', 'skills', 'alpha', 'SKILL.md'), invocation: { modelInvocable: true, userInvocable: true }, source: 'project-agents', provider: 'filesystem' },
      // The registry decides the winner even against rank order.
      { name: 'beta', description: 'agents beta', path: path.join(sandbox.agentsHome, 'skills', 'beta', 'SKILL.md'), invocation: { modelInvocable: true, userInvocable: false }, source: 'user-agents', provider: 'filesystem' },
      { name: 'gamma', description: 'linked gamma', path: path.join(external, 'SKILL.md'), invocation: { modelInvocable: true, userInvocable: true }, source: 'user-agents', provider: 'filesystem' },
      { name: 'helper', description: 'bundled helper', path: bundled, resourceBase: { kind: 'directory', path: path.dirname(bundled) }, invocation: { modelInvocable: false, userInvocable: true }, source: 'bundled', provider: 'filesystem' },
      { name: 'virtual', description: 'runtime skill', invocation: { modelInvocable: true, userInvocable: true }, source: 'runtime', provider: 'runtime' },
    ])
    const presets = fakePresets()
    const host = createHost({ skills, agentPresets: presets })
    const value = await host.value('skills-list', { cwd })
    assert.equal(value.complete, true)
    assert.deepEqual(skills.calls.map(call => [call.method, call.options.cwd, call.options.scope]), [['snapshot', cwd, presets.keys[0]]])
    assert.equal(presets.released, 1)
    assert.deepEqual(value.skills.map(summary), [
      ['project', 'project-agents', 'alpha', 'bundle', true, null],
      ['user', 'user-dsh', 'alpha', 'bundle', false, 'project-agents'],
      ['user', 'user-dsh', 'beta', 'flat', false, 'user-agents'],
      ['user', 'user-agents', 'beta', 'bundle', true, null],
      ['user', 'user-dsh', 'broken', 'bundle', false, null],
      ['user', 'user-agents', 'gamma', 'bundle', true, null],
      ['builtin', null, 'helper', 'builtin', true, null],
      ['builtin', null, 'virtual', 'builtin', true, null],
    ])
    const helper = value.skills[6]
    assert.equal(helper.id, bundled)
    assert.equal(helper.dir, path.dirname(bundled))
    assert.equal(helper.editable, false)
    assert.equal(helper.modelInvocable, false)
    assert.equal(helper.source, 'bundled')
    assert.equal(value.skills[7].id, 'builtin:virtual')
    assert.equal(value.skills[7].path, undefined)
  })

  it('treats an incomplete registry snapshot or a failing preset as a partial listing', async () => {
    const { cwd } = await seedWorkspace()
    const skills = fakeSkills([], { complete: false })
    const presets = { async acquireScope() { throw new Error('no default preset') } }
    const host = createHost({ skills, agentPresets: presets })
    const value = await host.value('skills-list', { cwd })
    assert.equal(value.complete, false)
    assert.equal(skills.calls[0].options.scope, undefined)
  })
})

describe('skills-read', () => {
  it('returns the body and the bundle files', async () => {
    const { userDsh } = await seedWorkspace()
    const dir = path.join(userDsh, 'alpha')
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: alpha\ndescription: user alpha\n---\n\n\nBody text\n')
    await put(path.join(dir, 'scripts', 'run.sh'), '#!/bin/sh\n')
    await put(path.join(dir, 'a', 'b', 'c', 'deep.txt'), 'depth 4\n')
    await put(path.join(dir, 'a', 'b', 'c', 'd', 'too-deep.txt'), 'depth 5\n')
    await put(path.join(dir, '.git', 'HEAD'), 'ref\n')
    await put(path.join(dir, 'node_modules', 'x', 'index.js'), '\n')
    await fs.symlink('/nonexistent', path.join(dir, 'link'))
    const host = createHost()
    const id = path.join(dir, 'SKILL.md')
    const value = await host.value('skills-read', { id })
    assert.equal(value.item.id, id)
    assert.equal(value.body, '\nBody text\n')
    assert.deepEqual(value.files, ['a/b/c/deep.txt', 'link', 'scripts/run.sh'])
    assert.equal(value.filesTotal, 3)

    const flat = await host.value('skills-read', { id: path.join(userDsh, 'beta.md') })
    assert.equal(flat.body, '# beta\n')
    assert.deepEqual(flat.files, [])
  })

  it('caps the file list at 50 entries', async () => {
    const { userDsh } = await seedWorkspace()
    for (let i = 0; i < 60; i++) await put(path.join(userDsh, 'alpha', 'refs', `f${String(i).padStart(2, '0')}.md`), 'x\n')
    const value = await createHost().value('skills-read', { id: path.join(userDsh, 'alpha', 'SKILL.md') })
    assert.equal(value.files.length, 50)
    assert.equal(value.filesTotal, 60)
  })

  it('reads built-in skills through the registry and accepts only listed ids', async () => {
    const bundled = path.join(sandbox.base, 'bundled', 'helper', 'SKILL.md')
    await put(bundled, skillText('helper'))
    await put(path.join(path.dirname(bundled), 'reference.md'), 'ref\n')
    const skills = fakeSkills(
      [{ name: 'helper', description: 'bundled helper', path: bundled, invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 'filesystem' }],
      { contents: { helper: { name: 'helper', content: 'Helper body' } } },
    )
    const host = createHost({ skills })
    const value = await host.value('skills-read', { id: bundled })
    assert.equal(value.body, 'Helper body')
    assert.deepEqual(value.files, ['reference.md'])
    assert.equal(skills.calls.at(-1).method, 'get')

    const outside = path.join(sandbox.base, 'elsewhere', 'SKILL.md')
    await put(outside, skillText('elsewhere'))
    assert.equal((await host.error('skills-read', { id: outside })).code, 'not-found')
    assert.equal((await host.error('skills-read', {})).code, 'bad-request')
  })
})

describe('skills-save', () => {
  const fields = { description: 'Does things', whenToUse: '', modelInvocable: true, userInvocable: true, body: '# Title\n\nSteps.\n' }

  it('creates a bundle skill, creating the root, and refuses an existing name', async () => {
    const host = createHost()
    const value = await host.value('skills-save', { target: { create: true, root: 'user-agents' }, name: 'new-skill', ...fields })
    const file = path.join(sandbox.agentsHome, 'skills', 'new-skill', 'SKILL.md')
    assert.equal(value.item.id, file)
    assert.equal(value.item.active, true)
    assert.equal(value.item.editable, true)
    assert.equal(await fs.readFile(file, 'utf8'), '---\nname: new-skill\ndescription: "Does things"\n---\n\n# Title\n\nSteps.\n')
    const again = await host.error('skills-save', { target: { create: true, root: 'user-agents' }, name: 'new-skill', ...fields })
    assert.equal(again.code, 'exists')
    assert.match(again.message, /new-skill/)
  })

  it('validates the payload', async () => {
    const host = createHost()
    const create = { target: { create: true, root: 'user-dsh' } }
    assert.equal((await host.error('skills-save', { ...create, name: 'Bad Name', ...fields })).code, 'bad-request')
    assert.equal((await host.error('skills-save', { ...create, name: 'a'.repeat(65), ...fields })).code, 'bad-request')
    assert.equal((await host.error('skills-save', { ...create, name: 'ok', ...fields, description: '   ' })).code, 'bad-request')
    assert.equal((await host.error('skills-save', { ...create, name: 'ok', ...fields, modelInvocable: 'yes' })).code, 'bad-request')
    assert.equal((await host.error('skills-save', { target: { create: true, root: 'project-dsh' }, name: 'ok', ...fields })).code, 'bad-request')
    assert.equal((await host.error('skills-save', { target: { create: true, root: 'elsewhere' }, name: 'ok', ...fields })).code, 'bad-request')
    assert.equal((await host.error('skills-save', { name: 'ok', ...fields })).code, 'bad-request')
  })

  it('creates project skills in the project root above the workspace', async () => {
    const { project, cwd } = await seedWorkspace()
    const value = await createHost().value('skills-save', { cwd, target: { create: true, root: 'project-dsh' }, name: 'proj-skill', ...fields })
    assert.equal(value.item.id, path.join(project, '.dsh', 'skills', 'proj-skill', 'SKILL.md'))
    assert.equal(value.item.root, 'project-dsh')
  })

  it('edits a skill, preserving other keys, and adds or removes the invocation keys', async () => {
    const file = path.join(sandbox.dshHome, 'skills', 'editor', 'SKILL.md')
    const original = [
      '---',
      '# keep this comment',
      'name: editor',
      'description: |',
      '  Old description',
      'metadata:',
      '  version: "1.0"',
      '  owners:',
      '    - me',
      'allowed-tools: [Read, Write]',
      '---',
      '',
      'Old body',
      '',
    ].join('\n')
    await put(file, original)
    const host = createHost()
    const edited = await host.value('skills-save', {
      target: { create: false, id: file }, name: 'editor', description: 'New description', whenToUse: 'When editing',
      modelInvocable: false, userInvocable: false, body: 'New body\n',
    })
    assert.equal(edited.item.modelInvocable, false)
    assert.equal(edited.item.userInvocable, false)
    assert.equal(edited.item.whenToUse, 'When editing')
    const afterEdit = await fs.readFile(file, 'utf8')
    assert.equal(afterEdit, [
      '---',
      '# keep this comment',
      'name: editor',
      'description: "New description"',
      'whenToUse: "When editing"',
      'disable-model-invocation: true',
      'user-invocable: false',
      'metadata:',
      '  version: "1.0"',
      '  owners:',
      '    - me',
      'allowed-tools: [Read, Write]',
      '---',
      '',
      'New body',
      '',
    ].join('\n'))

    const restored = await host.value('skills-save', {
      target: { create: false, id: file }, name: 'editor', description: 'New description', whenToUse: '',
      modelInvocable: true, userInvocable: true, body: 'New body\n',
    })
    assert.equal(restored.item.modelInvocable, true)
    assert.equal(restored.item.userInvocable, true)
    assert.equal(restored.item.whenToUse, undefined)
    const afterRestore = await fs.readFile(file, 'utf8')
    assert.ok(!/whenToUse|disable-model-invocation|user-invocable/.test(afterRestore))
    assert.match(afterRestore, /^metadata:\n {2}version: "1.0"$/m)
    const leftovers = (await fs.readdir(path.dirname(file))).filter(name => name !== 'SKILL.md')
    assert.deepEqual(leftovers, [])
  })

  it('repairs an invalid skill whose problem is in a managed key, and refuses other invalid content', async () => {
    const file = path.join(sandbox.dshHome, 'skills', 'fixme', 'SKILL.md')
    await put(file, '---\nname: Fix_Me\ndescription: Use when: broken\ndisable-model-invocation: maybe\n---\nBody\n')
    const host = createHost()
    const listed = (await host.value('skills-list', {})).skills.find(item => item.id === file)
    assert.equal(listed.name, 'fixme')
    assert.ok(listed.invalid)
    const fixed = await host.value('skills-save', { target: { create: false, id: file }, name: 'fixme', ...fields })
    assert.equal(fixed.item.invalid, undefined)
    assert.equal(fixed.item.name, 'fixme')

    const other = path.join(sandbox.dshHome, 'skills', 'other', 'SKILL.md')
    const broken = '---\nname: other\ndescription: ok\nlicense: see: file\n---\nBody\n'
    await put(other, broken)
    const error = await host.error('skills-save', { target: { create: false, id: other }, name: 'other', ...fields })
    assert.equal(error.code, 'invalid')
    assert.match(error.message, /line 4/)
    assert.equal(await fs.readFile(other, 'utf8'), broken)
  })

  it('refuses renames, unlisted ids, and built-in skills', async () => {
    const { userDsh } = await seedWorkspace()
    const bundled = path.join(sandbox.base, 'bundled', 'helper', 'SKILL.md')
    await put(bundled, skillText('helper'))
    const host = createHost({ skills: fakeSkills([{ name: 'helper', description: 'h', path: bundled, invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 'filesystem' }]) })
    const id = path.join(userDsh, 'alpha', 'SKILL.md')
    assert.equal((await host.error('skills-save', { target: { create: false, id }, name: 'renamed', ...fields })).code, 'bad-request')
    assert.equal((await host.error('skills-save', { target: { create: false, id: path.join(userDsh, 'alpha', 'README.md') }, name: 'alpha', ...fields })).code, 'not-found')
    const builtin = await host.error('skills-save', { target: { create: false, id: bundled }, name: 'helper', ...fields })
    assert.equal(builtin.code, 'forbidden')
    assert.match(builtin.message, /read-only/)
  })

  it('writes through a symlinked SKILL.md without replacing the link', async () => {
    const target = path.join(sandbox.base, 'shared', 'linked.md')
    await put(target, skillText('linked'))
    const dir = path.join(sandbox.dshHome, 'skills', 'linked')
    await fs.mkdir(dir, { recursive: true })
    await fs.symlink(target, path.join(dir, 'SKILL.md'))
    await createHost().value('skills-save', { target: { create: false, id: path.join(dir, 'SKILL.md') }, name: 'linked', ...fields })
    assert.ok((await fs.lstat(path.join(dir, 'SKILL.md'))).isSymbolicLink())
    assert.match(await fs.readFile(target, 'utf8'), /Does things/)
  })
})

describe('skills-delete', () => {
  it('removes bundles, flat files, and only the link of a symlinked skill', async () => {
    const { userDsh, userAgents, external } = await seedWorkspace()
    const host = createHost()
    const bundle = await host.value('skills-delete', { id: path.join(userDsh, 'alpha', 'SKILL.md') })
    assert.equal(bundle.removed, path.join(userDsh, 'alpha'))
    await assert.rejects(fs.lstat(path.join(userDsh, 'alpha')), { code: 'ENOENT' })

    const flat = await host.value('skills-delete', { id: path.join(userDsh, 'beta.md') })
    assert.equal(flat.removed, path.join(userDsh, 'beta.md'))
    await assert.rejects(fs.lstat(path.join(userDsh, 'beta.md')), { code: 'ENOENT' })

    const linked = await host.value('skills-delete', { id: path.join(userAgents, 'gamma', 'SKILL.md') })
    assert.equal(linked.removed, path.join(userAgents, 'gamma'))
    await assert.rejects(fs.lstat(path.join(userAgents, 'gamma')), { code: 'ENOENT' })
    assert.equal(await fs.readFile(path.join(external, 'SKILL.md'), 'utf8'), skillText('gamma', 'linked gamma'))
  })

  it('refuses unlisted ids, built-ins, and read-only roots', async (t) => {
    const { userDsh } = await seedWorkspace()
    const bundled = path.join(sandbox.base, 'bundled', 'helper', 'SKILL.md')
    await put(bundled, skillText('helper'))
    const host = createHost({ skills: fakeSkills([{ name: 'helper', description: 'h', path: bundled, invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 'filesystem' }]) })
    assert.equal((await host.error('skills-delete', { id: path.join(sandbox.base, 'external', 'gamma', 'SKILL.md') })).code, 'not-found')
    assert.equal((await host.error('skills-delete', { id: bundled })).code, 'forbidden')
    await fs.access(bundled)

    if (process.getuid?.() === 0) {
      t.diagnostic('running as root: permission checks do not apply')
      return
    }
    await fs.chmod(userDsh, 0o555)
    try {
      const listed = (await host.value('skills-list', {})).skills.find(item => item.id === path.join(userDsh, 'alpha', 'SKILL.md'))
      assert.equal(listed.editable, false)
      const error = await host.error('skills-delete', { id: listed.id })
      assert.equal(error.code, 'forbidden')
      assert.match(error.message, /read-only/)
      await fs.access(listed.path)
    } finally {
      await fs.chmod(userDsh, 0o755)
    }
  })
})

describe('direct-child write rule', () => {
  it('accepts only direct children of a root, comparing real paths', async () => {
    const realRoot = path.join(sandbox.base, 'real-skills')
    await fs.mkdir(realRoot, { recursive: true })
    await fs.mkdir(sandbox.dshHome, { recursive: true })
    await fs.symlink(realRoot, path.join(sandbox.dshHome, 'skills'))
    const { roots } = await skillRoots(undefined)
    assert.equal((await assertDirectChild(path.join(sandbox.dshHome, 'skills', 'a'), roots)).id, 'user-dsh')
    assert.equal((await assertDirectChild(path.join(realRoot, 'a'), roots)).id, 'user-dsh')
    await fs.mkdir(path.join(realRoot, 'a'))
    await assert.rejects(assertDirectChild(path.join(realRoot, 'a', 'b'), roots), { code: 'forbidden' })
    await assert.rejects(assertDirectChild(path.join(sandbox.base, 'outside'), roots), { code: 'forbidden' })
    await assert.rejects(assertDirectChild(path.join(realRoot, '..'), roots), { code: 'forbidden' })
  })
})

describe('mcp-tools', () => {
  it('lists the tools of one server without the prefix', async () => {
    const tools = {
      schemas: () => [
        { name: 'mcp__srv__search', description: 'Search things.\nMore detail.', parameters: {} },
        { name: 'mcp__srv2__other', description: 'other server', parameters: {} },
        { name: 'mcp__srv__', description: 'empty tool name', parameters: {} },
        { name: 'read', description: 'built-in', parameters: {} },
        { name: 'mcp__srv__fetch', description: 'Fetch.', parameters: {} },
      ],
    }
    const host = createHost({ tools })
    assert.deepEqual(await host.value('mcp-tools', { server: 'srv' }), {
      tools: [{ name: 'search', description: 'Search things.\nMore detail.' }, { name: 'fetch', description: 'Fetch.' }],
    })
    assert.deepEqual(await host.value('mcp-tools', { server: 'none' }), { tools: [] })
    assert.equal((await host.error('mcp-tools', { server: 'bad name' })).code, 'bad-request')
    assert.equal((await createHost().error('mcp-tools', { server: 'srv' })).code, 'unavailable')
  })
})

describe('routes', () => {
  it('registers every operation as an exact buffered POST route', () => {
    const host = createHost()
    assert.deepEqual([...host.routes.keys()].sort(), [
      'mcp-tools', 'skills-delete', 'skills-install', 'skills-list', 'skills-read', 'skills-save', 'skills-scan',
    ].map(operation => `/api/mcp-skills/${operation}`))
    for (const route of host.routes.values()) {
      assert.deepEqual(route.methods, ['POST'])
      assert.equal(route.requestBody, 'buffered')
    }
  })

  it('answers malformed envelopes and payloads', async () => {
    const host = createHost()
    const notJson = await host.post('skills-list', 'not json')
    assert.equal(notJson.status, 400)
    const wrongType = await (await host.post('skills-list', JSON.stringify({ type: 'other', rpcId: 'x', payload: {} }))).json()
    assert.deepEqual(wrongType, { type: 'server-response', rpcId: 'x', result: { ok: false, error: { code: 'bad-request', message: 'Expected a client-request envelope', details: {} } } })
    assert.equal((await host.error('skills-list', [])).code, 'bad-request')
    assert.equal((await host.error('skills-list', 'text')).code, 'bad-request')
  })
})
