import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, zstdDecompressSync } from 'node:zlib'
import { CodexAdapter } from '../index.js'
import { wireName } from '../protocol.js'

// Runs the installed Codex against a loopback Responses fixture. No account or paid API call.
for (const interceptNativeTools of [false, true]) {
test(`real Codex handles native exec, DSH tools and replay (intercept=${interceptNativeTools})`, { timeout: 45000 }, async () => {
  const recorded = []
  const server = createServer(async (req, res) => {
    try {
      let data = Buffer.concat(await Array.fromAsync(req))
      if (req.headers['content-encoding'] === 'gzip') data = gunzipSync(data)
      if (req.headers['content-encoding'] === 'zstd') data = zstdDecompressSync(data)
      const body = JSON.parse(data)
      recorded.push({ headers: req.headers, body })
      const output = recorded.length === 1 ? [{ type: 'custom_tool_call', id: 'ctc_native', call_id: 'native', name: 'exec',
        input: 'text(1 + 1)', status: 'completed' }] : recorded.length === 2 ? ['a', 'b'].map(id => ({
        type: id === 'a' ? 'function_call' : 'custom_tool_call', id: `${id === 'a' ? 'fc' : 'ctc'}_${id}`,
        call_id: `call_${id}`, name: wireName('read'), status: 'completed',
        [id === 'a' ? 'arguments' : 'input']: JSON.stringify({ path: `${id}.txt` }),
      })) : [{ type: 'message', id: 'msg_answer', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Both files read.', annotations: [], logprobs: [] }] }]
      const response = { id: `resp_${recorded.length}`, object: 'response', model: 'fixture-model',
        status: 'completed', output, usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14,
          input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } } }
      const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }]
      for (const [output_index, item] of output.entries()) {
        events.push({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress' } })
        if (item.type === 'message') events.push({ type: 'response.output_text.delta', output_index, item_id: item.id, content_index: 0, delta: item.content[0].text })
        events.push({ type: 'response.output_item.done', output_index, item })
      }
      events.push({ type: 'response.completed', response })
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    } catch (error) {
      res.writeHead(500)
      res.end(String(error))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const codexHome = await mkdtemp(join(tmpdir(), 'dsh-codex-e2e-'))
  let adapter
  try {
    await writeFile(join(codexHome, 'config.toml'), [
      'model_provider="fixture"', 'model="fixture-model"',
      '[model_providers.fixture]', 'name="Fixture"', 'wire_api="responses"',
      `base_url="http://127.0.0.1:${server.address().port}/v1"`, 'requires_openai_auth=false',
    ].join('\n'))
    adapter = new CodexAdapter({ command: process.env.CODEX_BIN ?? 'codex', codexHome, timeoutMs: 15000, interceptNativeTools })
    const options = { provider: 'codex-provider', model: 'fixture-model',
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Read a.txt and b.txt' }] }],
    }
    const first = await Array.fromAsync(adapter.stream(options))
    assert.equal(first.at(-1).reason.kind, 'tool-calls')
    const calls = first.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').map(chunk => chunk.block)
    assert.deepEqual(calls.map(call => call.id), ['call_a', 'call_b'])
    assert.deepEqual(calls.map(call => JSON.parse(call.arguments)), [{ path: 'a.txt' }, { path: 'b.txt' }])
    assert.equal(recorded.length, 2, 'Codex continues native tools, but leaves DSH tools unanswered')
    const nativeOutput = recorded[1].body.input.find(item => item.type === 'custom_tool_call_output' && item.call_id === 'native')
    if (interceptNativeTools) {
      assert.match(JSON.stringify(nativeOutput.output), /unsupported custom tool call: exec/)
      assert.ok(!recorded[0].body.tools.some(tool => tool.name === 'exec'))
    } else {
      assert.match(JSON.stringify(nativeOutput.output), /Script completed/)
      assert.ok(nativeOutput.output.some(item => item.text === '2'), 'The real Codex exec must run, not just be ignored')
      assert.ok(recorded[0].body.tools.some(tool => tool.name === 'exec'))
    }
    const second = await Array.fromAsync(adapter.stream({ ...options, messages: [
      ...options.messages, { role: 'assistant', content: calls,
        source: { kind: 'model', provider: options.provider, model: options.model, replayState: first.at(-1).replayState } },
      ...calls.map(call => ({ role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: `DSH result for ${call.id}` }] })),
    ] }))
    assert.equal(second.at(-1).reason.kind, 'stop')
    assert.equal(second.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'Both files read.')
    assert.equal(recorded.length, 3)
    assert.deepEqual(recorded[2].body.input.find(item => item.type === 'custom_tool_call_output' && item.call_id === 'native').output,
      nativeOutput.output, 'Native results survive the next DSH step')
    const replayed = recorded[2].body.input.filter(item => item.type === 'function_call')
    assert.deepEqual(replayed.map(item => [item.call_id, JSON.parse(item.arguments)]), [
      ['call_a', { path: 'a.txt' }], ['call_b', { path: 'b.txt' }],
    ])
    const results = recorded[2].body.input.filter(item => item.type === 'function_call_output')
    assert.equal(results.length, 2)
    assert.match(JSON.stringify(results), /DSH result for call_a/)
    assert.match(recorded[0].headers['user-agent'], /deepseek/i)
  } finally {
    await adapter?.dispose()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(codexHome, { recursive: true, force: true })
  }
})
}
