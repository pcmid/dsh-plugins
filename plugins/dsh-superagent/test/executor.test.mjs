import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutor } from '../host/executor.js'

const caseId = '09271bf3-2c71-437c-bd1f-f5ce631b399f'
const id = 'superagent-' + caseId
const input = { caseId, sourceKind: 'local', presetId: 'engineer', text: 'local task', requestId: 'instruction-1' }
const pinned = { provider: 'local-mock', model: 'alpha', effort: 'low' }

async function fixture(t) {
  const tmp = await realpath(tmpdir())
  const prefix = join(tmp, 'superagent-executor-')
  const root = await mkdtemp(prefix)
  t.after(async () => {
    assert.equal(await realpath(root), root)
    assert.ok(root.startsWith(prefix))
    await rm(root, { recursive: true })
  })
  const path = join(root, 'work'), live = new Map(), records = new Map()
  const f = { path, root, live, records, created: [], prompts: [], defaultReads: 0, resumes: 0, workspaceCreates: 0 }
  const ws = { id: 'work1', path, sessionIds: [], async attachSession(id) { this.sessionIds.push(id) } }
  f.ws = ws
  function machine(record) {
    const agent = { id: record.header.id, ctx: { preset: record.header.agentPreset }, session: record, model: {
      current: () => record.selection,
      select: selection => { record.selection = { ...selection } },
    } }
    return agent
  }
  f.globalPreset = 'profile-default'
  f.defaults = { provider: 'local-mock', model: 'beta', reasoningEffort: 'low' }
  const services = {
    agents: {
      get: key => live.get(key),
      async create(options) {
        assert.deepEqual(Object.keys(options).sort(), ['agentOptions','meta','sessionId','setup'])
        assert.ok(!records.has(options.sessionId))
        f.created.push(options)
        const record = { header: { id: options.sessionId, ...options.meta }, inbox: new Set() }
        const agent = machine(record)
        agent.ctx = {}
        records.set(agent.id, record)
        await options.setup(agent.ctx, agent)
        live.set(agent.id, agent)
        return { agent }
      },
    },
    agentPresets: {
      resolve: async (key = f.globalPreset) => {
        if (!['engineer','profile-default','workspace-default'].includes(key)) throw Object.assign(Error('private'), { code:'agent-preset/not-found' })
        return { id: key, broken: f.broken }
      },
      mount: async (ctx, key) => { ctx.preset = key; return { id: key } },
      presetForSession: session => session.header.agentPreset,
      composedPreset: ctx => ctx.preset,
    },
    llm: {
      async listModels(provider) { return provider === 'local-mock' ? [{ id: 'alpha' }, { id: 'beta' }] : [] },
      async resolveCallConfig(config) {
        if (config.reasoningEffort && !['low','high'].includes(config.reasoningEffort)) throw Error('rejected')
        return { reasoningEffort: 'high', ...config }
      },
    },
    agentDefaultModel: { currentSelection() { ++f.defaultReads; return f.defaults } },
    workingDirectory: { get: record => record.cwd ?? record.header.cwd },
    workspaceRegistry: {
      archivedSessionIds: [],
      async create(p, title) {
        assert.equal(p, path); assert.equal(title, 'SuperAgent')
        ++f.workspaceCreates
        return ws
      },
      resolveByPath: async p => p === path ? ws : undefined,
    },
    sessionPersistence: { stat: async key => records.has(key) ? { header: records.get(key).header } : undefined },
    sessionController: {
      async create(request) {
        assert.deepEqual(request, {sessionId:id,workspaceId:ws.id})
        const preset = await services.agentPresets.resolve(f.workspacePreset)
        if (preset.broken !== undefined) throw Object.assign(Error('private'), { code:'agent-preset/invalid' })
        await services.agents.create({sessionId:id, meta:{cwd:path,agentPreset:preset.id}, agentOptions:f.defaults,
          setup:async (ctx,agent)=>{await services.agentPresets.mount(ctx,preset.id);agent.model.select(f.defaults)} })
        await ws.attachSession(id)
        return {sessionId:id,agentPreset:preset.id}
      },
      async resolveAgent(key) {
        assert.ok(records.has(key), 'only resolve the existing case session')
        if (!live.has(key)) { ++f.resumes; live.set(key, machine(records.get(key))) }
        return { agent: live.get(key) }
      },
      async prompt(request, signal) {
        assert.ok(signal instanceof AbortSignal)
        const record = records.get(request.sessionId)
        record.inbox.add(request.requestId) // DSH acknowledges the first durable insertion, even after resume.
        f.prompts.push(request)
        if (f.loseAck) throw Error('private vendor diagnostics')
        return { accepted: true }
      },
    },
  }
  f.services = services
  f.executor = () => createExecutor({ get: key => services[key] }, { workspacePath: path })
  return f
}

test('creates an ordinary case session in its own registered workspace with the actual mounted preset', async t => {
  const f = await fixture(t)
  const result = await f.executor().submit({ ...input, model: pinned })
  assert.deepEqual(result, { sessionId: id, workspaceId: 'work1', accepted: true, resolvedPresetId: 'engineer', resolvedModel: pinned })
  assert.deepEqual(f.created[0].meta, { cwd: f.path, agentPreset: 'engineer' })
  assert.equal(f.live.get(id).ctx.preset, 'engineer')
  assert.deepEqual(f.records.get(id).selection, { provider: 'local-mock', model: 'alpha', reasoningEffort: 'low' })
  assert.equal(f.defaultReads, 0)
  assert.deepEqual(f.ws.sessionIds, [id])
  assert.deepEqual(f.prompts, [{ sessionId: id, requestId: 'instruction-1', mode: 'queue', content: [{ type: 'text', text: 'local task' }] }])
})

test('a role without a preset creates with the native profile or workspace default, then resumes without reselecting it', async t => {
  for (const workspacePreset of [undefined,'workspace-default']) {
    const f = await fixture(t)
    f.workspacePreset = workspacePreset
    const first = await f.executor().submit({...input,presetId:'',model:pinned})
    const effective = workspacePreset || f.globalPreset
    assert.equal(first.resolvedPresetId,effective)
    assert.equal(f.created[0].meta.agentPreset,effective)
    assert.equal(f.live.get(id).ctx.preset,effective)
    f.live.clear()
    f.workspacePreset = f.globalPreset = 'removed'
    const next = await f.executor().submit({...input,presetId:undefined,sessionId:id,requestId:'next',model:pinned})
    assert.deepEqual(next,first)
    assert.equal(f.created.length,1)
    assert.equal(f.resumes,1)
    assert.deepEqual([...f.records.get(id).inbox],['instruction-1','next'])
  }
})

test('an unavailable native default or a different returned session/preset never gets a prompt', async t => {
  const f = await fixture(t)
  const run = () => f.executor().submit({...input,presetId:undefined})
  f.globalPreset = 'removed'
  await assert.rejects(run(), { code:'PRESET_UNAVAILABLE', message:'PRESET_UNAVAILABLE' })
  f.globalPreset = 'profile-default'
  f.broken = 'private'
  await assert.rejects(run(), { code:'PRESET_UNAVAILABLE', message:'PRESET_UNAVAILABLE' })
  assert.equal(f.created.length,0)
  f.broken = undefined
  const create = f.services.sessionController.create
  f.services.sessionController.create = async () => ({sessionId:'replacement',agentPreset:'profile-default'})
  await assert.rejects(run(), { code:'SESSION_MISMATCH' })
  f.services.sessionController.create = async request => ({...await create(request),agentPreset:'engineer'})
  await assert.rejects(run(), { code:'SESSION_MISMATCH' })
  assert.equal(f.prompts.length,0)
})

test('snapshots the inherited route with optional effort and resumes it without consulting a new default', async t => {
  const f = await fixture(t), model = { inherit: true, effort: 'high' }
  const first = await f.executor().submit({ ...input, model })
  assert.deepEqual(first.resolvedModel, { provider: 'local-mock', model: 'beta', effort: 'high' })
  f.live.clear()
  f.defaults = undefined
  const second = await f.executor().submit({ ...input, sessionId: first.sessionId, model, text: 'follow-up', requestId: 'instruction-2' })
  assert.deepEqual(first, second)
  assert.equal(f.created.length, 1)
  assert.equal(f.resumes, 1)
  assert.equal(f.defaultReads, 1)
  assert.equal(f.workspaceCreates, 1)
  assert.deepEqual([...f.records.get(id).inbox], ['instruction-1','instruction-2'])
})

test('unconfigured role uses the configured default, but a pinned model with no effort leaves it to the adapter', async t => {
  const f = await fixture(t)
  assert.equal((await f.executor().submit(input)).resolvedModel.effort, 'low')
  const other = 'b572f898-e91c-4553-8185-84a1d5966277'
  const result = await f.executor().submit({ ...input, caseId: other, model: { ...pinned, effort: '' } })
  assert.deepEqual(f.records.get(result.sessionId).selection, { provider: pinned.provider, model: pinned.model })
  assert.equal(result.resolvedModel.effort, '')
})

test('refuses a source, forged addresses, broken presets and unavailable routes before submitting', async t => {
  const f = await fixture(t), submit = overrides => f.executor().submit({ ...input, ...overrides })
  for (const [arg, code] of [
    [{ sourceKind: 'feishu' }, 'SOURCE_NOT_ALLOWED'], [{ sourceKind: undefined }, 'SOURCE_NOT_ALLOWED'],
    [{ caseId: 'outside' }, 'INVALID_REQUEST'], [{ text: '  ' }, 'INVALID_REQUEST'],
    [{ sessionId: 'other' }, 'SESSION_MISMATCH'], [{ sessionId: id }, 'WORKSPACE_UNAVAILABLE'],
    [{ presetId: ' ' }, 'PRESET_UNAVAILABLE'], [{ presetId: 'removed' }, 'PRESET_UNAVAILABLE'], [{ model: { ...pinned, model: 'removed' } }, 'MODEL_UNAVAILABLE'],
    [{ model: { ...pinned, provider: 'another' } }, 'MODEL_UNAVAILABLE'],
    [{ model: { ...pinned, effort: 'unsupported' } }, 'MODEL_UNAVAILABLE'],
    [{ model: { inherit: true, ...pinned } }, 'MODEL_UNAVAILABLE'],
  ]) await assert.rejects(submit(arg), { code })
  f.broken = 'private preset diagnostics'
  await assert.rejects(submit({}), { code: 'PRESET_UNAVAILABLE', message: 'PRESET_UNAVAILABLE' })
  f.broken = undefined
  f.defaults = undefined
  await assert.rejects(submit({}), { code: 'MODEL_UNAVAILABLE' })
  delete f.services.sessionPersistence
  await assert.rejects(submit({}), { code: 'EXECUTOR_UNAVAILABLE' })
  assert.equal(f.created.length, 0)
  assert.equal(f.prompts.length, 0)
})

test('will not cross archive, workspace, effective cwd, mounted preset or native selection boundaries', async t => {
  const f = await fixture(t)
  const run = () => f.executor().submit({ ...input, sessionId: id, model: pinned, requestId: 'instruction-2' })
  await f.executor().submit({ ...input, model: pinned })
  f.services.workspaceRegistry.archivedSessionIds = [id]
  await assert.rejects(run(), { code: 'SESSION_UNAVAILABLE' })
  f.services.workspaceRegistry.archivedSessionIds = []
  f.ws.sessionIds = []
  await assert.rejects(run(), { code: 'SESSION_MISMATCH' })
  assert.deepEqual(f.ws.sessionIds, [])
  f.ws.sessionIds = [id]
  const record = f.records.get(id)
  record.cwd = join(f.path, 'elsewhere')
  await assert.rejects(run(), { code: 'SESSION_MISMATCH' })
  delete record.cwd
  f.live.get(id).ctx.preset = 'different'
  await assert.rejects(run(), { code: 'SESSION_MISMATCH' })
  f.live.get(id).ctx.preset = 'engineer'
  record.selection.reasoningEffort = 'high'
  await assert.rejects(run(), { code: 'MODEL_UNAVAILABLE' })
  assert.equal(record.selection.reasoningEffort, 'high')
  f.live.clear()
  record.header.origin = 'subagent'
  await assert.rejects(run(), { code: 'SESSION_MISMATCH' })
  assert.equal(f.resumes, 0)
  f.records.clear()
  await assert.rejects(run(), { code: 'SESSION_UNAVAILABLE' })
  assert.equal(f.created.length, 1)
  assert.equal(f.prompts.length, 1)
})

test('distinguishes a lost admission acknowledgement and reuses the same native request and session', async t => {
  const f = await fixture(t)
  f.loseAck = true
  await assert.rejects(f.executor().submit(input), {
    status: 'unknown', code: 'PROMPT_UNCERTAIN', message: 'PROMPT_UNCERTAIN', sessionId: id, workspaceId: 'work1',
  })
  f.loseAck = false
  f.live.clear()
  // No case receipt survived. Its Host-minted case and request IDs did.
  assert.equal((await f.executor().submit(input)).sessionId, id)
  assert.equal(f.created.length, 1)
  assert.equal(f.records.get(id).inbox.size, 1)
})

test('does not register or prompt in a symlinked dedicated directory', async t => {
  const f = await fixture(t)
  await symlink(f.root, f.path, 'dir')
  await assert.rejects(f.executor().submit(input), { code: 'WORKSPACE_UNAVAILABLE' })
  assert.equal(f.workspaceCreates, 0)
  assert.equal(f.prompts.length, 0)
})
