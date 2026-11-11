import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createDeveloperMessage } from '@deepseek-ai/dsh-llm'
import * as plugin from '../index.js'
import { CodexAdapter, Config, apply, name } from '../index.js'
import { wireName, projectRequest } from '../protocol.js'

const user = text => ({ role: 'user', content: [{ type: 'text', text }] })
const tools = [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]
const request = { provider: 'codex-provider', model: 'fixture', messages: [user('Read the file')], tools }
const event = (method, params = {}) => ({ method, params: { threadId: 'thread', turnId: 'turn', ...params } })
const completed = event('rawResponse/completed', { usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3, reasoningOutputTokens: 1 } })
const call = (id, tool = 'read') => event('rawResponseItem/completed', { item: {
  type: 'function_call', name: wireName(tool), call_id: id, arguments: '{"path":"notes.txt"}',
} })
const customCall = id => event('rawResponseItem/completed', { item: {
  type: 'custom_tool_call', name: wireName('read'), namespace: 'functions', call_id: id, input: '{"path":"notes.txt"}',
} })
const answer = [event('item/agentMessage/delta', { itemId: 'message', delta: 'Done.' }), completed,
  event('turn/completed', { turn: { id: 'turn', status: 'completed' } })]

function factory(scripts) {
  const clients = []
  return { clients, create(_command, _args, options) {
    const events = [...(scripts[clients.length] ?? [])]
    const client = {
      calls: [], writes: [], read: [], options, isClosed: false,
      async request(method, params) {
        this.calls.push({ method, params })
        if (method === 'config/read') return { config: { mcp_servers: { 'with.dot': {} }, plugins: { 'some@market': { enabled: true } } } }
        if (method === 'thread/start') return { thread: { id: 'thread' } }
        if (method === 'turn/start') return { turn: { id: 'turn' } }
        if (method === 'model/list') return { data: [{ model: 'fixture', displayName: 'Fixture', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Think more' }], defaultReasoningEffort: 'high' }], nextCursor: null }
        return {}
      },
      write(message) { this.writes.push(message) },
      async next() {
        options.signal?.throwIfAborted()
        assert.ok(events.length, 'Must finish at the response boundary, without waiting for tool results')
        const message = events.shift()
        this.read.push(message)
        return message
      },
      async close() { this.isClosed = true },
    }
    clients.push(client)
    return client
  } }
}

test('DSH owns two parallel tool calls and the next step replays actual DSH tool results', async () => {
  const f = factory([[
    event('item/tool/call', { tool: wireName('read') }), call('a'), customCall('b'), customCall('b'), completed,
  ], answer])
  const adapter = new CodexAdapter({}, f.create)
  const first = await Array.fromAsync(adapter.stream(request))
  assert.equal(first.at(-1).reason.kind, 'tool-calls')
  const toolBlocks = first.filter(c => c.type === 'block-end').map(c => c.block)
  assert.deepEqual(toolBlocks.map(b => [b.id, b.name]), [['a', 'read'], ['b', 'read']])
  assert.deepEqual(toolBlocks.map(b => b.arguments), ['{"path":"notes.txt"}', '{"path":"notes.txt"}'])
  assert.deepEqual(first.find(c => c.type === 'usage').usage, { inputTokens: 6, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 0, reasoningTokens: 1 })
  assert.ok(f.clients[0].isClosed)
  assert.ok(!existsSync(f.clients[0].options.cwd))
  assert.deepEqual(f.clients[0].writes, [{ method: 'initialized' }], 'No fabricated tool results sent to Codex')
  const system = { role: 'system', content: [{ type: 'text', text: 'Updated DSH system prompt' }] }
  const next = { ...request, tools: [], messages: [system, ...request.messages,
    { role: 'assistant', content: toolBlocks },
    { role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'file contents' }] },
    { role: 'tool', toolCallId: 'b', isError: true, content: [{ type: 'text', text: 'Permission denied by DSH' }] },
  ] }
  const second = await Array.fromAsync(adapter.stream(next))
  assert.equal(second.at(-1).reason.kind, 'stop')
  assert.equal(second.find(c => c.type === 'block-end').block.text, 'Done.')
  const started = f.clients[1].calls.find(c => c.method === 'thread/start').params
  assert.equal(started.baseInstructions, 'Updated DSH system prompt')
  assert.deepEqual(started.dynamicTools, [])
  assert.equal(started.config['mcp_servers."with.dot".enabled'], false)
  assert.equal(started.config['plugins."some@market".enabled'], false)
  assert.match(started.config['model_providers."openai".http_headers']['user-agent'], /deepseek/i)
  assert.equal(started.environments, undefined)
  const injected = f.clients[1].calls.find(c => c.method === 'thread/inject_items').params.items
  assert.equal(injected[1].name, wireName('read'))
  assert.equal(injected[2].type, 'function_call')
  assert.equal(injected[2].call_id, 'b')
  assert.equal(injected[2].arguments, '{"path":"notes.txt"}')
  assert.equal(injected.at(-2).output, 'file contents')
  assert.equal(injected.at(-1).output, 'Tool failed:\nPermission denied by DSH')
  assert.ok(f.clients.every(c => c.isClosed))
})

test('raw tool requests do not require Codex turn/completed and parallel batch is complete', async () => {
  const f = factory([[{ ...event('item/tool/call', { tool: wireName('read') }), id: 91 }, call('a'), call('b'), completed]])
  const chunks = await Array.fromAsync(new CodexAdapter({}, f.create).stream(request))
  assert.equal(chunks.filter(c => c.type === 'tool-call-delta').length, 2)
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
})

test('incompatible protocols and generation errors still fail explicitly', async () => {
  for (const script of [
    [event('turn/completed', { turn: { status: 'completed' } })],
    [event('turn/completed', { turn: { status: 'failed', error: { message: 'authentication required' } } })],
  ]) {
    const f = factory([script])
    await assert.rejects(Array.fromAsync(new CodexAdapter({}, f.create).stream(request)))
    assert.ok(f.clients[0].isClosed)
    assert.ok(!existsSync(f.clients[0].options.cwd))
  }
})

test('DSH custom calls reject invalid JSON inputs', async () => {
  for (const [overrides, error] of [
    [{ input: 'read notes.txt' }, SyntaxError],
    [{ input: { path: 'notes.txt' } }, /expected a JSON string/],
    [{ input: undefined }, /expected a JSON string/],
  ]) {
    const message = customCall('a')
    Object.assign(message.params.item, overrides)
    const f = factory([[message, completed]])
    await assert.rejects(Array.fromAsync(new CodexAdapter({}, f.create).stream(request)), error)
    assert.ok(f.clients[0].isClosed)
    assert.ok(!existsSync(f.clients[0].options.cwd))
  }
})

test('native tool results stay in Codex and usage includes every upstream response', async () => {
  for (const item of [
    { type: 'custom_tool_call', call_id: 'native', name: 'exec', input: 'text(1 + 1)' },
    { type: 'function_call', call_id: 'native', name: 'exec_command', arguments: '{}' },
    { ...customCall('native').params.item, namespace: 'foreign' },
  ]) {
    const f = factory([[
      event('rawResponseItem/completed', { item }), completed,
      event('rawResponseItem/completed', { item: { type: item.type + '_output', call_id: 'native', output: '2' } }),
      ...answer,
    ]])
    const chunks = await Array.fromAsync(new CodexAdapter({}, f.create).stream(request))
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.deepEqual(chunks.filter(c => c.type === 'block-end').map(c => c.block), [{ type: 'text', text: 'Done.' }])
    assert.deepEqual(chunks.filter(c => c.type === 'usage').map(c => c.usage), [
      { inputTokens: 12, outputTokens: 6, cacheReadTokens: 8, cacheWriteTokens: 0, reasoningTokens: 2 },
    ])
  }
})

test('mixed native and DSH batches wait for native completion before closing Codex', async () => {
  const f = factory([[
    event('rawResponseItem/completed', { item: { type: 'custom_tool_call', call_id: 'native', name: 'exec', input: 'text(2)' } }),
    call('dsh'), completed,
    event('rawResponseItem/completed', { item: { type: 'custom_tool_call_output', call_id: 'native', output: '2' } }),
  ]])
  const chunks = await Array.fromAsync(new CodexAdapter({}, f.create).stream(request))
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  assert.deepEqual(chunks.filter(c => c.type === 'tool-call-delta').map(c => c.name), ['read'])
  assert.equal(f.clients[0].read.at(-1).params.item.output, '2')
})

test('hosted native items wait for Codex completion without becoming DSH calls', async () => {
  for (const type of ['local_shell_call', 'tool_search_call', 'web_search_call', 'image_generation_call']) {
    const outputType = type === 'local_shell_call' ? 'function_call_output' : type === 'tool_search_call' ? 'tool_search_output' : undefined
    const f = factory([[
      event('rawResponseItem/completed', { item: { type, call_id: 'native', status: 'completed' } }),
      ...(outputType ? [event('rawResponseItem/completed', { item: { type: outputType, call_id: 'native', output: 'done' } })] : []),
      ...answer,
    ]])
    const chunks = await Array.fromAsync(new CodexAdapter({}, f.create).stream(request))
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.equal(chunks.filter(c => c.type === 'tool-call-delta').length, 0)
    assert.equal(f.clients[0].read.at(-1).method, 'turn/completed')
  }
})

test('native client interactions are declined to Codex without failing the user request', async () => {
  const f = factory([[
    { ...event('item/commandExecution/requestApproval'), id: 91 },
    { ...event('item/fileChange/requestApproval'), id: 92 },
    { ...event('item/permissions/requestApproval'), id: 93 },
    { ...event('item/tool/requestUserInput'), id: 94 },
    { ...event('unknown/nativeRequest'), id: 95 },
    ...answer,
  ]])
  const chunks = await Array.fromAsync(new CodexAdapter({}, f.create).stream(request))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.deepEqual(f.clients[0].writes.slice(1, 5), [
    { id: 91, result: { decision: 'decline' } }, { id: 92, result: { decision: 'decline' } },
    { id: 93, result: { permissions: {}, scope: 'turn' } }, { id: 94, result: { answers: {} } },
  ])
  assert.equal(f.clients[0].writes.at(-1).error.code, -32601)
})

test('DSH tools nested inside exec receive a direct-call instruction instead of deadlocking', async () => {
  const f = factory([[
    event('rawResponseItem/completed', { item: { type: 'custom_tool_call', call_id: 'native', name: 'exec', input: 'await tools.read({})' } }),
    completed,
    { ...event('item/tool/call', { tool: wireName('read'), callId: 'nested' }), id: 91 },
    event('rawResponseItem/completed', { item: { type: 'custom_tool_call_output', call_id: 'native', output: 'Call the tool directly.' } }),
    call('direct'), completed,
  ]])
  const chunks = await Array.fromAsync(new CodexAdapter({}, f.create).stream(request))
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  assert.deepEqual(chunks.filter(c => c.type === 'tool-call-delta').map(c => c.id), ['direct'])
  assert.equal(f.clients[0].writes.at(-1).result.success, false)
  assert.match(f.clients[0].writes.at(-1).result.contentItems[0].text, /directly/)
})

test('advanced options default to PATH and native execution; interception disables code mode', async () => {
  assert.deepEqual(Config({}).providers, {})
  assert.equal(Config({ providers: { 'codex-provider': {} } }).providers['codex-provider'].advanced.interceptNativeTools, false)
  assert.equal(new CodexAdapter({ command: '   ' }).config.command, 'codex')
  assert.equal(new CodexAdapter({ command: '/opt/codex cli' }).config.command, '/opt/codex cli')
  for (const interceptNativeTools of [false, true]) {
    const f = factory([answer])
    await Array.fromAsync(new CodexAdapter({ interceptNativeTools }, f.create).stream(request))
    const started = f.clients[0].calls.find(c => c.method === 'thread/start').params
    assert.equal(started.config['features.code_mode'], !interceptNativeTools)
    assert.deepEqual(started.environments, interceptNativeTools ? [] : undefined)
    assert.equal(started.config['features.shell_tool'], interceptNativeTools ? false : undefined)
  }
})

test('cancellation and early consumer return release the process and temporary directory', async () => {
  const f = factory([answer])
  const adapter = new CodexAdapter({}, f.create)
  const controller = new AbortController()
  const stream = adapter.stream({ ...request, signal: controller.signal })
  await stream.next()
  controller.abort()
  await stream.return()
  assert.ok(f.clients[0].isClosed)
  assert.ok(!existsSync(f.clients[0].options.cwd))
  await assert.rejects(Array.fromAsync(adapter.stream({ ...request, signal: controller.signal })), { name: 'AbortError' })
  assert.equal(f.clients.length, 1)
})

test('context replacement and concurrent sessions always create independent threads', async () => {
  const f = factory([answer, answer])
  const adapter = new CodexAdapter({}, f.create)
  await Promise.all([
    Array.fromAsync(adapter.stream({ ...request, sessionId: 'a' })),
    Array.fromAsync(adapter.stream({ ...request, sessionId: 'b', messages: [user('Compacted context')] })),
  ])
  assert.equal(new Set(f.clients.map(c => c.options.cwd)).size, 2)
  const histories = f.clients.map(c => c.calls.find(r => r.method === 'thread/inject_items').params.items[0].content[0].text)
  assert.deepEqual(new Set(histories), new Set(['Read the file', 'Compacted context']))
})

test('model listing and plugin registration expose the agreed name', async () => {
  const f = factory([[]])
  const adapter = new CodexAdapter({}, f.create)
  assert.equal((await adapter.listModels('codex-provider'))[0].id, 'fixture')
  assert.equal((await adapter.resolveModel('codex-provider', 'fixture')).reasoning.defaultEffort, 'high')
  assert.equal(f.clients.length, 1, 'Reuse catalog for metadata lookup')
  const fixed = new CodexAdapter({ models: ['custom-model'] }, () => { throw new Error('Must not spawn for a configured catalog') })
  assert.equal((await fixed.listModels('codex-provider'))[0].id, 'custom-model')
  assert.equal(fixed.providerInfo('codex-provider').name, 'Codex Provider')
  let routes, configuredAdapter
  const ctx = { llm: { registerAdapter(ids, adapter) { routes = ids; configuredAdapter = adapter; return () => {} }, registerConfigurableProviders() {} },
    inject() {}, effect: f => f(), on() {} }
  apply(ctx, {})
  assert.equal(routes, undefined, 'Installing the bundle must not activate Codex')
  apply(ctx, { command: '/legacy/codex', providers: { 'codex-provider': {} } })
  assert.equal(name, 'codex-provider')
  assert.deepEqual(routes, ['codex-provider'])
  assert.equal(configuredAdapter.config.command, 'codex', 'A blank advanced path uses PATH, even after an upgrade')
})

test('history retains roles and tool IDs; unsupported input fails explicitly', () => {
  const projected = projectRequest({ ...request, system: 'system', messages: [
    { role: 'developer', content: [{ type: 'text', text: 'Instructions' }] }, user('User text'),
    { role: 'assistant', content: [{ type: 'reasoning', text: 'not replayed as public text' }, { type: 'text', text: 'Answer' }] },
  ] })
  assert.deepEqual(projected.items.map(i => i.role), ['developer', 'user', 'assistant'])
  assert.deepEqual(projected.items[2].content, [{ type: 'output_text', text: 'Answer' }])
  assert.throws(() => projectRequest({ messages: [{ role: 'user', content: [{ type: 'image' }] }] }), /unsupported block/)
  assert.notEqual(wireName('a.b'), wireName('a_b'))
})

test('real DSH runtime loads/unloads the plugin and projects tool updates before dispatch', async () => {
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  const dormant = await ctx.plugin(plugin, {})
  assert.ok(!ctx.llm.listProviders().some(provider => provider.id === 'codex-provider'))
  assert.ok(ctx.llm.listConfigurableProviders().some(provider => provider.provider === 'codex-provider'))
  await dormant.dispose()
  const fork = await ctx.plugin(plugin, { providers: { 'codex-provider': {} }, models: ['fixture'] })
  assert.ok(ctx.llm.listProviders().some(provider => provider.id === 'codex-provider'))
  assert.equal((await ctx.llm.listModels('codex-provider'))[0].id, 'fixture')
  await fork.dispose()
  assert.ok(!ctx.llm.listProviders().some(provider => provider.id === 'codex-provider'))
  const f = factory([[], [call('a'), completed]])
  const unregister = ctx.llm.registerAdapter(['codex-provider'], new CodexAdapter({}, f.create))
  const update = createDeveloperMessage({ source: { kind: 'test' }, content: [{ type: 'tool-addition', toolName: 'read' }] })
  const chunks = await Array.fromAsync(ctx.llm.stream({ ...request,
    messages: [...request.messages, update], tools: [{ ...tools[0], deferLoading: true }],
    toolHistory: { tools: [], updates: [{ messageId: update.id, additions: tools }] },
  }))
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  const started = f.clients[1].calls.find(c => c.method === 'thread/start').params
  const projected = started.dynamicTools
  assert.equal(projected.length, 1)
  assert.equal(projected[0].deferLoading, undefined)
  assert.equal(f.clients[1].calls.find(c => c.method === 'turn/start').params.effort, 'high')
  unregister()
  await runtime.dispose()
})

test('completed messages without deltas are preserved and streamed messages are not duplicated', async () => {
  for (const prefix of [[], [event('item/agentMessage/delta', { itemId: 'message', delta: 'Hello' })]]) {
    const f = factory([[...prefix, event('item/completed', { item: { id: 'message', type: 'agentMessage', text: 'Hello' } }), completed]])
    const chunks = await Array.fromAsync(new CodexAdapter({}, f.create).stream(request))
    assert.deepEqual(chunks.filter(c => c.type === 'block-end').map(c => c.block.text), ['Hello'])
    assert.equal(chunks.at(-1).reason.kind, 'stop')
  }
})

test('imported history notifications cannot become a new model reply', async () => {
  const f = factory([[
    event('rawResponseItem/completed', { turnId: '', item: { type: 'function_call_output', call_id: 'old', output: 'old result' } }),
    ...answer,
  ]])
  const chunks = await Array.fromAsync(new CodexAdapter({}, f.create).stream(request))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})
