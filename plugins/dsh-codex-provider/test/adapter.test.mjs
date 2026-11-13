import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmError } from '@deepseek-ai/dsh-llm'
import * as plugin from '../index.js'
import { CodexAdapter, Config, apply, name } from '../index.js'
import { planContinuation } from '../conversation.js'
import { MessageKeys, projectHistory, toolNames } from '../history.js'
import { call, exec, fakes, message, reasoning } from './fake-codex.mjs'

const provider = 'codex-provider'
const user = text => ({ role: 'user', content: [{ type: 'text', text }] })
const system = text => ({ role: 'system', content: [{ type: 'text', text }] })
const tools = [
  { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
]
const base = { provider, model: 'gpt-test', sessionId: 'session-1', tools, messages: [system('DSH prompt'), user('Read a and b')] }
const blocksOf = chunks => chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
const assistantOf = chunks => ({ role: 'assistant', content: blocksOf(chunks),
  source: { kind: 'model', provider, model: 'gpt-test', replayState: chunks.at(-1).replayState } })
const resultsOf = (chunks, prefix = 'result') => blocksOf(chunks).filter(block => block.type === 'tool-call')
  .map(block => ({ role: 'tool', toolCallId: block.id, content: [{ type: 'text', text: `${prefix} ${block.id}` }] }))
const run = (adapter, options) => Array.fromAsync(adapter.stream(options))
const texts = sample => sample.input.map(item => item.content?.[0]?.text ?? item.output ?? item.arguments ?? item.input ?? item.encrypted_content)

function setup(script, config = {}) {
  const f = fakes(script)
  const adapter = new CodexAdapter(config, f.connect)
  return { f, adapter, codex: () => f.instances[0] }
}

test('a tool round trip stays in one turn: DSH results answer the waiting calls', async () => {
  const { adapter, codex } = setup([
    [reasoning('rs1', 'Plan'), call('a', 'read', { path: 'a' }), call('b', 'read', { path: 'b' })],
    [message('m1', 'Done.')],
  ])
  try {
    const first = await run(adapter, base)
    assert.equal(first.at(-1).reason.kind, 'tool-calls')
    assert.deepEqual(blocksOf(first).map(b => [b.type, b.id ?? b.text]), [['reasoning', 'Plan'], ['tool-call', 'a'], ['tool-call', 'b']])
    assert.deepEqual(first.find(c => c.type === 'usage').usage, { inputTokens: 40, outputTokens: 10, cacheReadTokens: 60, cacheWriteTokens: 0, reasoningTokens: 4 })
    assert.equal(codex().answers.length, 0, 'No tool result is invented')
    const history = [...base.messages, assistantOf(first), ...resultsOf(first)]
    const second = await run(adapter, { ...base, messages: history })
    assert.equal(second.at(-1).reason.kind, 'stop')
    assert.equal(blocksOf(second)[0].text, 'Done.')
    assert.deepEqual(codex().answers.map(a => a.result), [
      { success: true, contentItems: [{ type: 'inputText', text: 'result a' }] },
      { success: true, contentItems: [{ type: 'inputText', text: 'result b' }] },
    ])
    assert.equal(codex().threads.size, 1)
    assert.equal(codex().calls.filter(c => c.method === 'turn/start').length, 1)
    assert.deepEqual(codex().samples.map(s => s.threadId), ['thread-1', 'thread-1'])
    const start = codex().calls.find(c => c.method === 'thread/start').params
    assert.equal(start.baseInstructions, 'DSH prompt')
    assert.deepEqual(start.dynamicTools.map(t => t.name), ['read', 'bash'])
    assert.deepEqual(start.environments, [])
    assert.equal(start.config, undefined, 'No DSH effort leaves the Codex default')
    const overrides = codex().args.filter((_, i) => codex().args[i - 1] === '-c')
    for (const setting of ['include_environment_context=false', 'skills.include_instructions=false', 'features.shell_tool=false', 'features.code_mode=false', 'agents.enabled=false']) {
      assert.ok(overrides.includes(setting), setting)
    }
  } finally { await adapter.dispose() }
})

test('MCP servers from the user Codex config are disabled for the whole process', async () => {
  const f = fakes([], [[message('m1', 'Hi')]])
  f.config = { mcp_servers: { node_repl: { command: 'node_repl' }, off: { enabled: false }, 'odd.name': {} } }
  const adapter = new CodexAdapter({ codexHome: '/tmp/codex-home' }, f.connect)
  try {
    await run(adapter, base)
    assert.equal(f.instances.length, 2)
    assert.deepEqual([f.instances[1].executable, f.instances[1].args.slice(0, 2)], ['codex', ['app-server', '--stdio']])
    assert.ok(f.instances[0].isClosed, 'The probe process is replaced')
    const overrides = args => args.filter((_, i) => args[i - 1] === '-c')
    assert.ok(!overrides(f.instances[0].args).some(arg => arg.startsWith('mcp_servers.')))
    assert.deepEqual(overrides(f.instances[1].args).filter(arg => arg.startsWith('mcp_servers.')), ['mcp_servers.node_repl.enabled=false'])
    assert.equal(f.instances[1].options.env.CODEX_HOME, '/tmp/codex-home')
    assert.equal(f.instances[1].clientInfo.name, 'deepseek-harness')
    assert.equal(f.instances[1].threads.size, 1)
  } finally { await adapter.dispose() }
})

test('DSH tools called from a code-mode script become one DSH step and answer the script', async () => {
  const { adapter, codex } = setup([
    [exec('cell', [{ id: 'exec-1', name: 'read', args: { path: 'a' } }, { id: 'exec-2', name: 'bash', args: { command: 'ls' } }])],
    [message('m1', 'Script done.')],
  ])
  try {
    const first = await run(adapter, base)
    assert.equal(first.at(-1).reason.kind, 'tool-calls')
    assert.deepEqual(blocksOf(first).map(b => [b.id, b.name, JSON.parse(b.arguments)]), [
      ['exec-1', 'read', { path: 'a' }], ['exec-2', 'bash', { command: 'ls' }],
    ])
    assert.deepEqual(first.at(-1).replayState.response.codex.nested, ['exec-1', 'exec-2'])
    const history = [...base.messages, assistantOf(first), ...resultsOf(first)]
    const second = await run(adapter, { ...base, messages: history })
    assert.equal(blocksOf(second)[0].text, 'Script done.')
    assert.deepEqual(texts(codex().samples[1]).slice(-2), ['await tools.run()', 'result exec-1\nresult exec-2'])
    assert.equal(codex().threads.size, 1)

    // Rebuilt history replays the script and its output; nested results are not sent twice.
    const replayed = projectHistory([...history.slice(1), assistantOf(second)], provider, new Map([['read', 'read'], ['bash', 'bash']]))
    assert.deepEqual(replayed.map(item => item.type), ['message', 'custom_tool_call', 'custom_tool_call_output', 'message'])
    // Without the script output (the thread was lost mid-script), the DSH calls and results are sent instead.
    const partial = projectHistory(history.slice(1), provider, new Map([['read', 'read'], ['bash', 'bash']]))
    assert.deepEqual(partial.map(item => [item.type, item.call_id]), [
      ['message', undefined], ['function_call', 'exec-1'], ['function_call', 'exec-2'],
      ['function_call_output', 'exec-1'], ['function_call_output', 'exec-2'],
    ])
  } finally { await adapter.dispose() }
})

test('a new user turn after a completed turn appends to the same thread', async () => {
  const { adapter, codex } = setup([[message('m1', 'Hi.')], [message('m2', 'Again.')]])
  try {
    const first = await run(adapter, base)
    const second = await run(adapter, { ...base, reasoningEffort: 'low', messages: [...base.messages, assistantOf(first), user('More')] })
    assert.equal(blocksOf(second)[0].text, 'Again.')
    assert.equal(codex().threads.size, 1)
    assert.deepEqual(texts(codex().samples[1]), ['Read a and b', 'Hi.', 'More'])
    assert.equal(codex().calls.filter(c => c.method === 'turn/start').at(-1).params.effort, 'low')
  } finally { await adapter.dispose() }
})

test('input that arrives with tool results is queued after the results', async () => {
  const { adapter, codex } = setup([[call('a', 'read')], [message('m1', 'Ok.')]])
  try {
    const first = await run(adapter, base)
    await run(adapter, { ...base, messages: [...base.messages, assistantOf(first), ...resultsOf(first), user('Also this')] })
    assert.deepEqual(texts(codex().samples[1]).slice(-3), ['{}', 'result a', 'Also this'])
    assert.equal(codex().threads.size, 1)
  } finally { await adapter.dispose() }
})

test('a request that does not continue the thread rebuilds it from DSH history, replaying recorded items', async () => {
  for (const change of [
    options => ({ ...options, messages: [system('Changed prompt'), ...options.messages.slice(1)] }),
    options => ({ ...options, tools: tools.slice(0, 1) }),
    options => ({ ...options, model: 'gpt-other' }),
    options => ({ ...options, reasoningEffort: 'high' }),
    options => ({ ...options, messages: [options.messages[0], user('Compacted summary'), ...options.messages.slice(2)] }),
    options => ({ ...options, messages: options.messages.slice(0, -1) }),
  ]) {
    const { adapter, codex } = setup([[reasoning('rs1', 'Plan', 'SECRET'), call('a', 'read', { path: 'a' })], [message('m1', 'Done.')]])
    try {
      const first = await run(adapter, base)
      const next = change({ ...base, messages: [...base.messages, assistantOf(first), ...resultsOf(first)] })
      const second = await run(adapter, next)
      assert.equal(second.at(-1).reason.kind, 'stop')
      assert.equal(codex().threads.size, 2)
      assert.equal(codex().threads.get('thread-1').interrupted, 1, 'The abandoned turn is interrupted')
      assert.ok(codex().threads.get('thread-1').unsubscribed)
      const replayed = codex().samples[1].input
      if (next.messages.length > 3) {
        assert.ok(replayed.some(item => item.type === 'reasoning' && item.encrypted_content === 'SECRET'), 'Encrypted reasoning survives a rebuild')
      }
      assert.equal(codex().calls.filter(c => c.method === 'turn/start').length, 2)
      const starts = codex().calls.filter(c => c.method === 'thread/start').map(c => c.params.config?.model_reasoning_effort)
      assert.deepEqual(starts, [undefined, next.reasoningEffort], 'The rebuilt thread starts at the requested effort')
    } finally { await adapter.dispose() }
  }
})

test('sessions, auxiliary calls and concurrent requests use separate threads', async () => {
  const { adapter, codex } = setup([[message('m1', 'A')], [message('m2', 'B')], [message('m3', 'Title')]])
  try {
    await Promise.all([run(adapter, base), run(adapter, { ...base, sessionId: 'session-2' })])
    await run(adapter, { ...base, purpose: 'title', tools: [], messages: [user('Name it')] })
    assert.equal(codex().threads.size, 3)
    assert.equal(adapter.conversations.size, 2)
    assert.ok(codex().threads.get('thread-3').unsubscribed, 'Auxiliary threads are released at once')
  } finally { await adapter.dispose() }
})

test('cancellation, timeout and early return interrupt the turn and drop the thread', async () => {
  for (const mode of ['abort', 'timeout', 'return']) {
    const { adapter, codex } = setup([Object.assign([], { hang: true }), [message('m1', 'Fresh')]], { timeoutMs: mode === 'timeout' ? 50 : 60000 })
    try {
      const controller = new AbortController()
      const stream = adapter.stream({ ...base, signal: controller.signal })
      const pending = stream.next()
      await new Promise(resolve => setTimeout(resolve, 10))
      if (mode === 'abort') controller.abort()
      if (mode === 'return') {
        void stream.return()
        controller.abort()
      }
      const outcome = await pending.then(() => undefined, error => error)
      if (mode === 'abort') assert.equal(outcome.name, 'AbortError')
      if (mode === 'timeout') assert.equal(outcome.code, 'TIMEOUT')
      assert.equal(codex().threads.get('thread-1').interrupted, 1)
      assert.equal(adapter.conversations.size, 0)
      const again = await run(adapter, base)
      assert.equal(blocksOf(again)[0].text, 'Fresh')
      assert.equal(codex().threads.size, 2)
    } finally { await adapter.dispose() }
  }
})

test('Codex failures become classified LlmErrors and the next request rebuilds', async () => {
  for (const [info, code] of [
    ['contextWindowExceeded', 'CONTEXT_WINDOW_EXCEEDED'], ['usageLimitExceeded', 'QUOTA'], ['unauthorized', 'AUTH'],
    [{ responseStreamDisconnected: { httpStatusCode: 502 } }, 'TRANSPORT'], ['other', 'PROVIDER'],
  ]) {
    const { adapter, codex } = setup([Object.assign([], { error: { message: 'boom', codexErrorInfo: info } }), [message('m1', 'Ok')]])
    try {
      await assert.rejects(run(adapter, base), error => error instanceof LlmError && error.code === code)
      assert.equal(adapter.conversations.size, 0)
      await run(adapter, base)
      assert.equal(codex().threads.size, 2)
    } finally { await adapter.dispose() }
  }
  const { adapter } = setup([[message('m1', '')].map(item => ({ ...item, content: [{ type: 'output_text', text: '' }] }))])
  try {
    await assert.rejects(run(adapter, base), { code: 'EMPTY_RESPONSE' })
  } finally { await adapter.dispose() }
})

test('a crashed app-server fails the step, then a new process serves the session', async () => {
  const f = fakes([Object.assign([], { hang: true })], [[message('m1', 'Back')]])
  const adapter = new CodexAdapter({}, f.connect)
  try {
    const pending = run(adapter, base)
    await new Promise(resolve => setTimeout(resolve, 10))
    f.instances[0].crash()
    await assert.rejects(pending, { code: 'TRANSPORT' })
    const again = await run(adapter, base)
    assert.equal(blocksOf(again)[0].text, 'Back')
    assert.equal(f.instances.length, 2)
  } finally { await adapter.dispose() }
})

test('idle threads are released and the process stops when nothing uses it', async () => {
  const { adapter, codex } = setup([[call('a', 'read')]], { idleTimeoutMs: 20 })
  try {
    await run(adapter, base)
    assert.equal(adapter.conversations.size, 1)
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(adapter.conversations.size, 0)
    assert.equal(codex().threads.get('thread-1').interrupted, 1, 'A turn waiting on tools is interrupted')
    assert.ok(codex().isClosed)
  } finally { await adapter.dispose() }
})

test('calls Codex handles itself never reach DSH; Codex continues the response', async () => {
  const { adapter, codex } = setup([[call('bad', 'read', '{not json'), call('native', 'exec_command', { cmd: 'ls' })], [message('m1', 'Recovered')]])
  try {
    const chunks = await run(adapter, base)
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.deepEqual(blocksOf(chunks), [{ type: 'text', text: 'Recovered' }])
    const items = chunks.at(-1).replayState.response.codex.items
    assert.deepEqual(items.map(item => item.type), ['function_call', 'function_call', 'function_call_output', 'function_call_output', 'message'])
    assert.equal(codex().samples.length, 2)
  } finally { await adapter.dispose() }
})

test('messages completed without deltas are emitted once', async () => {
  const { adapter } = setup([[{ ...message('m1', 'Whole'), silent: true }]])
  try {
    assert.deepEqual(blocksOf(await run(adapter, base)), [{ type: 'text', text: 'Whole' }])
  } finally { await adapter.dispose() }
})

test('tool names stay readable; only names Codex refuses are rewritten', () => {
  const names = toolNames([
    { name: 'read', parameters: {} }, { name: 'web.fetch', parameters: {} }, { name: 'web_fetch', parameters: {} },
    { name: 'mcp__github__issue', parameters: {} }, { name: 'exec_command', parameters: {} }, { name: 'x'.repeat(80), parameters: {} },
    { name: 'exec', parameters: {} },
  ])
  const wire = [...names.toWire.values()]
  assert.equal(names.toWire.get('read'), 'read')
  assert.equal(names.toWire.get('web_fetch'), 'web_fetch')
  assert.match(names.toWire.get('web.fetch'), /^web_fetch_[0-9a-f]{8}$/)
  assert.equal(names.toWire.get('mcp__github__issue'), 'mcp_github__issue')
  assert.match(names.toWire.get('exec_command'), /^exec_command_[0-9a-f]{8}$/)
  assert.match(names.toWire.get('exec'), /^exec_[0-9a-f]{8}$/)
  assert.ok(wire.every(name => /^[a-zA-Z0-9_-]{1,64}$/.test(name)))
  assert.equal(new Set(wire).size, wire.length)
  const forward = toolNames([{ name: 'web.fetch' }, { name: 'web_fetch' }]).toWire
  const backward = toolNames([{ name: 'web_fetch' }, { name: 'web.fetch' }]).toWire
  assert.deepEqual([...forward].sort(), [...backward].sort(), 'Names do not depend on tool order')
  assert.throws(() => toolNames([{ name: 'read' }, { name: 'read' }]), /Duplicate/)
})

test('history projection keeps roles, pairs every call with an output, and rejects unsupported content', () => {
  const toWire = new Map([['read', 'read']])
  const items = projectHistory([
    user('Hi'), system('Later instruction'),
    { role: 'assistant', content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'Calling' }, { type: 'tool-call', id: 'a', name: 'read', arguments: '{}' }, { type: 'tool-call', id: 'b', name: 'read', arguments: '{}' }],
      source: { provider: 'other' } },
    { role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'A' }] },
  ], provider, toWire)
  assert.deepEqual(items.map(item => [item.type, item.role ?? item.call_id]), [
    ['message', 'user'], ['message', 'developer'], ['message', 'assistant'], ['function_call', 'a'], ['function_call_output', 'a'],
  ])
  assert.throws(() => projectHistory([{ role: 'user', content: [{ type: 'image' }] }], provider, toWire), { code: 'UNSUPPORTED_CONTENT' })
})

test('continuation requires the exact committed prefix and the waiting calls', () => {
  const keys = new MessageKeys()
  const assistant = { role: 'assistant', content: [{ type: 'tool-call', id: 'a' }], source: { provider, replayState: { response: { codex: { thread: 't', step: 1 } } } } }
  const result = { role: 'tool', toolCallId: 'a', content: [] }
  const messages = [user('Hi'), assistant, result]
  const state = { spec: 's', threadId: 't', step: 1, committed: [keys.of(messages[0])], awaiting: new Map([['a', 7]]), effort: undefined }
  const request = list => ({ spec: 's', provider, effort: undefined, messages: list, keys: list.map(m => keys.of(m)) })
  assert.equal(planContinuation(state, request(messages)).kind, 'tools')
  assert.equal(planContinuation(state, request([...messages, user('More')])).extra.length, 1)
  assert.equal(planContinuation(state, request(messages.slice(0, 2))), undefined, 'Missing results')
  assert.equal(planContinuation({ ...state, step: 2 }, request(messages)), undefined, 'Another step')
  assert.equal(planContinuation({ ...state, spec: 'x' }, request(messages)), undefined, 'Another thread spec')
  assert.equal(planContinuation(state, request([user('Edited'), assistant, result])), undefined, 'Edited history')
  assert.equal(planContinuation({ ...state, awaiting: undefined }, request([user('Hi'), assistant, user('Next')])).kind, 'turn')
  assert.equal(planContinuation({ ...state, awaiting: undefined }, request([user('Hi'), assistant])), undefined, 'Nothing new')
})

test('model catalog, reasoning efforts and the reported context window', async () => {
  const { adapter, f } = setup([[message('m1', 'Hi')]])
  try {
    const [model] = await adapter.listModels(provider)
    assert.deepEqual([model.id, model.name, model.context.contextWindow], ['gpt-test', 'GPT Test', 128000])
    assert.deepEqual(model.reasoning.efforts.map(e => e.id), ['low', 'high'])
    assert.equal((await adapter.resolveModel(provider, 'gpt-test')).reasoning.defaultEffort, 'high')
    assert.equal(f.instances.length, 1, 'The catalog is loaded once')
    await run(adapter, base)
    assert.equal(f.instances.length, 1)
    f.instances[0].listeners.get('thread-1')({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'x', tokenUsage: { modelContextWindow: 258400 } } })
    assert.equal((await adapter.resolveModel(provider, 'gpt-test')).context.contextWindow, 258400)
    const fixed = new CodexAdapter({ models: ['custom'], contextWindow: 64000 }, () => { throw new Error('Must not start Codex') })
    assert.deepEqual((await fixed.listModels(provider)).map(m => [m.id, m.context.contextWindow]), [['custom', 64000]])
    assert.equal((await fixed.resolveModel(provider, 'custom')).id, 'custom')
  } finally { await adapter.dispose() }
})

test('models.dev supplies the window until Codex reports one; the config overrides both', async () => {
  const f = fakes([[message('m1', 'Hi')]])
  let loads = 0
  const modelsDev = { load: async () => { loads++ }, window: model => ({ 'gpt-test': 400000 })[model] }
  const adapter = new CodexAdapter({}, f.connect, modelsDev)
  try {
    assert.equal((await adapter.listModels(provider))[0].context.contextWindow, 400000)
    await run(adapter, base)
    f.instances[0].listeners.get('thread-1')({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'x', tokenUsage: { modelContextWindow: 258400 } } })
    assert.equal((await adapter.resolveModel(provider, 'gpt-test')).context.contextWindow, 258400)
    assert.equal(loads, 2, 'Listing and resolving both check the cache')
    const fixed = new CodexAdapter({ models: ['gpt-test', 'unlisted'], contextWindow: 64000 }, undefined, modelsDev)
    assert.deepEqual((await fixed.listModels(provider)).map(m => m.context.contextWindow), [64000, 64000])
    const listed = new CodexAdapter({ models: ['gpt-test', 'unlisted'] }, undefined, modelsDev)
    assert.deepEqual((await listed.listModels(provider)).map(m => m.context.contextWindow), [400000, 128000])
  } finally { await adapter.dispose() }
})

test('the provider registers only while enabled and follows live settings changes', async () => {
  assert.deepEqual(Config({}).providers.get(), {})
  assert.equal(new CodexAdapter({ codexPath: '   ' }).config.codexPath, 'codex')
  assert.equal(new CodexAdapter({ codexPath: '/opt/codex cli' }).config.codexPath, '/opt/codex cli')
  assert.equal(new CodexAdapter({ codexPath: '~/.local/share/mise/shims/codex' }).config.codexPath, join(homedir(), '.local/share/mise/shims/codex'))
  const registrations = []
  const listeners = {}
  const ctx = {
    llm: { registerAdapter(ids, adapter) {
      const entry = { ids, adapter, active: true }
      registrations.push(entry)
      return () => { entry.active = false }
    }, registerConfigurableProviders() {} },
    inject() {}, effect: f => f(), on(event, listener) { listeners[event] = listener }, get() {},
  }
  let value = {}
  apply(ctx, { ...Config({}), providers: { get: () => value } })
  assert.equal(registrations.length, 0, 'Installing the bundle must not start Codex')
  value = { [name]: {} }
  listeners['loader/volatile-update']()
  assert.deepEqual([registrations.length, registrations[0].ids, registrations[0].adapter.config.codexPath], [1, [name], 'codex'])
  listeners['loader/volatile-update']()
  assert.equal(registrations.length, 1, 'An unrelated update keeps the adapter')
  value = { [name]: { codexPath: '/usr/local/bin/codex' } }
  listeners['loader/volatile-update']()
  assert.deepEqual(registrations.map(r => [r.active, r.adapter.config.codexPath]), [[false, 'codex'], [true, '/usr/local/bin/codex']])
  assert.ok(registrations[0].adapter.disposed)
  value = {}
  listeners['loader/volatile-update']()
  assert.ok(!registrations[1].active && registrations[1].adapter.disposed)
})

test('the real DSH runtime registers, streams through and unloads the plugin', async () => {
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  const dormant = await ctx.plugin(plugin, {})
  assert.ok(!ctx.llm.listProviders().some(p => p.id === provider))
  assert.ok(ctx.llm.listConfigurableProviders().some(p => p.provider === provider))
  await dormant.dispose()
  const home = mkdtempSync(join(tmpdir(), 'dsh-codex-home-'))
  const saved = { home: process.env.DSH_HOME, fetch: globalThis.fetch }
  process.env.DSH_HOME = home
  globalThis.fetch = async () => Response.json({ openai: { models: { 'gpt-test': { limit: { context: 400000 } } } } })
  try {
    const fork = await ctx.plugin(plugin, { providers: { [provider]: {} }, models: ['gpt-test'] })
    assert.equal((await ctx.llm.listModels(provider))[0].id, 'gpt-test')
    assert.equal((await ctx.llm.resolveModelInfo(provider, 'gpt-test')).context.contextWindow, 400000)
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'codex-provider', 'models-dev.json'), 'utf8')).windows, { 'gpt-test': 400000 })
    await fork.dispose()
  } finally {
    if (saved.home === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved.home
    globalThis.fetch = saved.fetch
    rmSync(home, { recursive: true, force: true })
  }
  assert.ok(!ctx.llm.listProviders().some(p => p.id === provider))
  const { adapter } = setup([[call('a', 'read')]])
  const unregister = ctx.llm.registerAdapter([provider], adapter)
  const chunks = await Array.fromAsync(ctx.llm.stream({ ...base, tools: [{ ...tools[0], deferLoading: true }] }))
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  unregister()
  await adapter.dispose()
  await runtime.dispose()
})
