import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, zstdDecompressSync } from 'node:zlib'
import { CodexAdapter } from '../index.js'

// Runs the installed Codex against a loopback Responses fixture. No account or paid API call.
const reasoning = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Need both files.' }], encrypted_content: 'ENCRYPTED-1' }
const call = (id, name, args) => ({ type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name, arguments: JSON.stringify(args), status: 'completed' })
const message = (id, text) => ({ type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] })

async function fixture(outputs) {
  const recorded = []
  const server = createServer(async (req, res) => {
    let data = Buffer.concat(await Array.fromAsync(req))
    if (req.headers['content-encoding'] === 'gzip') data = gunzipSync(data)
    if (req.headers['content-encoding'] === 'zstd') data = zstdDecompressSync(data)
    const body = JSON.parse(data)
    recorded.push({ headers: req.headers, body })
    const output = outputs.shift() ?? [message('msg_fallback', 'fallback')]
    const response = { id: `resp_${recorded.length}`, object: 'response', model: body.model, status: 'completed', output,
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 4 } } }
    const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }]
    for (const [output_index, item] of output.entries()) {
      events.push({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress' } })
      if (item.type === 'message') events.push({ type: 'response.output_text.delta', output_index, item_id: item.id, content_index: 0, delta: item.content[0].text })
      events.push({ type: 'response.output_item.done', output_index, item })
    }
    events.push({ type: 'response.completed', response })
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
    res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const codexHome = await mkdtemp(join(tmpdir(), 'dsh-codex-e2e-'))
  await writeFile(join(codexHome, 'config.toml'), [
    'model_provider="fixture"', 'model="fixture-model"',
    '[model_providers.fixture]', 'name="Fixture"', 'wire_api="responses"',
    `base_url="http://127.0.0.1:${server.address().port}/v1"`, 'requires_openai_auth=false',
  ].join('\n'))
  return { recorded, codexHome, async close() {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(codexHome, { recursive: true, force: true })
  } }
}

const user = text => ({ role: 'user', content: [{ type: 'text', text }] })
const tools = [
  { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'mcp__fs__stat', description: 'Stat a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
]
const blocksOf = chunks => chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
const assistantOf = (chunks, options) => ({ role: 'assistant', content: blocksOf(chunks),
  source: { kind: 'model', provider: options.provider, model: options.model, replayState: chunks.at(-1).replayState } })
const inputText = item => item.content?.map(part => part.text).join('') ?? item.output ?? item.arguments ?? item.encrypted_content

test('real Codex keeps one thread per session, pauses on DSH tools and rebuilds losslessly', { timeout: 60000 }, async () => {
  const f = await fixture([
    [reasoning, call('a', 'read', { path: 'a.txt' }), call('b', 'mcp_fs__stat', { path: 'b.txt' })],
    [message('msg_1', 'Both files checked.')],
    [message('msg_2', 'You are welcome.')],
    [message('msg_3', 'Rebuilt.')],
    [message('msg_4', 'A title')],
  ])
  const adapter = new CodexAdapter({ codexPath: process.env.CODEX_BIN ?? 'codex', codexHome: f.codexHome, timeoutMs: 20000 })
  let restarted
  try {
    const options = { provider: 'codex-provider', model: 'fixture-model', sessionId: 'session-1', tools,
      messages: [{ role: 'system', content: [{ type: 'text', text: 'DSH system prompt' }] }, user('Check a.txt and b.txt')] }
    const first = await Array.fromAsync(adapter.stream(options))
    assert.equal(first.at(-1).reason.kind, 'tool-calls')
    const calls = blocksOf(first).filter(block => block.type === 'tool-call')
    assert.deepEqual(calls.map(c => [c.id, c.name, JSON.parse(c.arguments)]), [
      ['call_a', 'read', { path: 'a.txt' }], ['call_b', 'mcp__fs__stat', { path: 'b.txt' }],
    ])
    assert.deepEqual(blocksOf(first)[0], { type: 'reasoning', text: 'Need both files.' })
    assert.deepEqual(first.find(c => c.type === 'usage').usage, { inputTokens: 40, outputTokens: 10, cacheReadTokens: 60, cacheWriteTokens: 0, reasoningTokens: 4 })
    assert.equal(f.recorded.length, 1, 'Codex waits for DSH tool results')

    const history = [...options.messages, assistantOf(first, options),
      ...calls.map(c => ({ role: 'tool', toolCallId: c.id, content: [{ type: 'text', text: `DSH result for ${c.id}` }] })),
      user('Also mention c.txt')]
    const second = await Array.fromAsync(adapter.stream({ ...options, messages: history }))
    assert.equal(second.at(-1).reason.kind, 'stop')
    assert.equal(second.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'Both files checked.')

    const third = await Array.fromAsync(adapter.stream({ ...options, messages: [...history, assistantOf(second, options), user('Thanks')] }))
    assert.equal(blocksOf(third).at(-1).text, 'You are welcome.')

    const [r1, r2, r3] = f.recorded.map(r => r.body)
    assert.deepEqual(r1.tools.map(t => t.name), ['read', 'mcp_fs__stat'], 'Only DSH tools, with readable names')
    assert.equal(new Set([r1, r2, r3].map(b => b.prompt_cache_key)).size, 1, 'One thread keeps one prompt cache key')
    assert.deepEqual(r1.input.map(i => [i.type, i.role, inputText(i)]), [
      ['message', 'developer', 'DSH system prompt'], ['message', 'user', 'Check a.txt and b.txt'],
    ], 'No Codex instructions, skills or environment context')
    assert.deepEqual(r2.input.slice(0, r1.input.length), r1.input, 'History grows by appending')
    assert.deepEqual(r2.input.slice(r1.input.length).map(i => [i.type, inputText(i)]), [
      ['reasoning', 'ENCRYPTED-1'], ['function_call', '{"path":"a.txt"}'], ['function_call', '{"path":"b.txt"}'],
      ['function_call_output', 'DSH result for call_a'], ['function_call_output', 'DSH result for call_b'],
      ['message', 'Also mention c.txt'],
    ])
    assert.deepEqual(r3.input.slice(0, r2.input.length), r2.input)
    assert.equal(r3.input.at(-1).content[0].text, 'Thanks')

    // A new process has no thread: the history, including encrypted reasoning, is rebuilt from DSH.
    restarted = new CodexAdapter({ codexPath: process.env.CODEX_BIN ?? 'codex', codexHome: f.codexHome, timeoutMs: 20000 })
    const rebuilt = await Array.fromAsync(restarted.stream({ ...options,
      messages: [...history, assistantOf(second, options), user('Thanks'), assistantOf(third, options), user('Again')] }))
    assert.equal(blocksOf(rebuilt).at(-1).text, 'Rebuilt.')
    const r4 = f.recorded[3].body
    assert.notEqual(r4.prompt_cache_key, r1.prompt_cache_key)
    assert.deepEqual(r4.input.slice(0, r3.input.length).map(i => [i.type, inputText(i)]), r3.input.map(i => [i.type, inputText(i)]))

    // Auxiliary calls use a temporary thread and leave the session thread alone.
    const title = await Array.fromAsync(adapter.stream({ ...options, purpose: 'title', tools: [], messages: [user('Name this chat')] }))
    assert.equal(blocksOf(title).at(-1).text, 'A title')
    assert.notEqual(f.recorded[4].body.prompt_cache_key, r1.prompt_cache_key)
    assert.equal(adapter.conversations.size, 1)
  } finally {
    await adapter.dispose()
    await restarted?.dispose()
    await f.close()
  }
})
