import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createExecutor } from '../../host/executor.js'

const load = createRequire(process.env.SMOKE_INSTALL)
const installed = pkg => import(pathToFileURL(load.resolve('@deepseek-ai/dsh-' + pkg)))
const { HostConnectionService } = await installed('client-connection')
const { LlmAdapter } = await installed('llm')
const { routeRequest, overrideCreate } = await import(pathToFileURL(process.env.SMOKE_WORKSPACE_ROUTE))
const version = JSON.parse(readFileSync(process.env.SMOKE_INSTALL)).version
assert.equal(version, '0.2.2-rc.3')
const caseId = 'e379b502-4160-437c-a8af-49e855d0e5e8'
const id = 'superagent-' + caseId
const prompts = ['Fixture local request', 'Fixture follow-up in the same case']
const replies = ['Fixture first response', 'Fixture follow-up response']
const model = { provider: 'offline', model: 'case', effort: 'high' }
const globalModel = { provider: 'offline', model: 'global', reasoningEffort: 'low' }
const users = messages => messages.filter(m => m.role === 'user').flatMap(m => m.content.map(b => b.text))

class Offline extends LlmAdapter {
  async listModels(provider) { return ['global','case'].map(id => ({ provider, id, name: id })) }
  async resolveModel(provider, id) {
    return { provider, id, name: id, reasoning: { efforts: ['low','high'].map(id => ({ id, name: id })) } }
  }
  async *stream(request) {
    const n = process.env.SMOKE_STEP === 'create' ? 0 : 1
    assert.equal(request.sessionId, id)
    assert.equal(request.model, model.model)
    assert.equal(request.reasoningEffort, model.effort)
    assert.deepEqual(users(request.messages).filter(t => prompts.includes(t)), prompts.slice(0, n + 1))
    if (n) assert.ok(request.messages.some(m => m.role === 'assistant' && m.content.some(b => b.text === replies[0])))
    const text = replies[n]
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function run(ctx, executor, path) {
  const step = process.env.SMOKE_STEP, n = step === 'create' ? 0 : 1
  assert.equal(ctx.get('webServer'), undefined)
  assert.equal(ctx.get('credentials'), undefined)
  assert.ok(ctx.get('configEditor'), 'real settings writer required to detect global writes')
  const s = ctx.sessionController, p = ctx.sessionPersistence
  const registry = ctx.workspaceRegistry
  // Only the first Host has the workspace override; resuming must not consult it or the global default.
  if (!n) ctx.effect(() => overrideCreate(s, request => routeRequest(request, {
    workspaces: () => ({[path]:'worker'}), workspacePath: key => registry.get(key)?.path,
    problem: async preset => (await ctx.agentPresets.resolve(preset)).broken, warn: assert.fail,
  }), assert.fail))
  const globalUnchanged = () => {
    assert.deepEqual(ctx.agentDefaultModel.currentSelection(), globalModel)
    assert.equal(ctx.agentPresets.defaultId, 'other')
  }
  globalUnchanged()
  const catalog = await ctx.get('llm').listModels('offline')
  assert.ok(catalog.some(m => m.id === model.model), JSON.stringify(catalog))
  await ctx.get('llm').resolveCallConfig({ provider: model.provider, model: model.model, reasoningEffort: model.effort })
  assert.equal(ctx.agents.get(id), undefined)
  const listIds = async () => (await s.list({}, new AbortController().signal)).items.map(r => r.sessionId)
  assert.deepEqual(await listIds(), n ? [id] : [])
  const prior = n ? (await registry.resolveByPath(path)).id : undefined
  const ended = Promise.withResolvers()
  ctx.on('session/event', (session, event) => {
    if (session.id === id && event.type === 'turn/end') ended.resolve(event.data.reason)
  })
  const receipt = await executor.submit({
    caseId, ...(n && { sessionId: id }), requestId: 'smoke-' + n, text: prompts[n], model, sourceKind: 'local',
  })
  assert.equal(receipt.accepted, true)
  assert.equal(receipt.sessionId, id)
  assert.equal(receipt.resolvedPresetId, 'worker')
  assert.deepEqual(receipt.resolvedModel, model)
  if (n) assert.equal(receipt.workspaceId, prior)
  assert.deepEqual(await ended.promise, { kind: 'completed' })
  await p.flush()
  assert.deepEqual(await listIds(), [id])
  const workspace = registry.get(receipt.workspaceId)
  assert.equal(workspace.path, path)
  assert.deepEqual(workspace.sessionIds, [id])
  const log = await p.open(id, 'read')
  try {
    assert.equal(log.header.agentPreset, 'worker')
    assert.equal(log.header.cwd, path)
    const { events } = await log.read()
    const inputs = events.filter(e => e.type === 'user/message' && e.data.source.kind === 'user').map(e => e.data)
    assert.deepEqual(users(inputs), prompts.slice(0, n + 1))
    assert.deepEqual(inputs.map(m => [m.source.kind, m.source.rpcId]), prompts.slice(0, n + 1).map((_, i) => ['user','smoke-' + i]))
    assert.deepEqual(events.filter(e => e.type === 'assistant/message').flatMap(e => e.data.message.content.map(b => b.text)), replies.slice(0, n + 1))
    assert.equal(events.filter(e => e.type === 'tool/call').length, 0)
  } finally { await log.close() }
  globalUnchanged()
  console.log(`PASS ${step}: DSH ${version}, native ${id}, ${n + 1} persisted user/assistant pair(s), worker / offline:case:high, global other / offline:global:low unchanged`)
}

export const inject = ['appReady','appExit','llm']
export function apply(ctx) {
  // The actual local route registry, without HTTP or browser authentication.
  new HostConnectionService(ctx, [], new Proxy({}, { get() { throw Error('No browser access in smoke') } }))
  ctx.llm.registerAdapter(['offline'], new Offline())
  const path = join(process.cwd(), 'Superagent')
  // Match the plugin's optional ctx.get() service lookups, not a pre-injected executor.
  const executor = createExecutor(ctx, { workspacePath: path })
  ctx.inject(['appReady','appExit','sessionController','sessionPersistence','workspaceRegistry','agentDefaultModel','agentPresets','agents'], ctx => ctx.effect(() => ctx.appReady.onReady(() => {
    const guard = setTimeout(() => { console.error('Timeout waiting for the smoke turn'); ctx.appExit(1) }, 12_000)
    run(ctx, executor, path).then(() => ctx.appExit(0), err => { console.error(err); ctx.appExit(1) }).finally(() => clearTimeout(guard))
  })))
}
