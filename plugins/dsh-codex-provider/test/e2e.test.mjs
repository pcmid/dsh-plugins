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
test('real Codex returns a whole tool batch; the next request contains DSH results', { timeout: 45000 }, async () => {
  const recorded = []
  const server = createServer(async (req, res) => {
    try {
      let data = Buffer.concat(await Array.fromAsync(req))
      if (req.headers['content-encoding'] === 'gzip') data = gunzipSync(data)
      if (req.headers['content-encoding'] === 'zstd') data = zstdDecompressSync(data)
      const body = JSON.parse(data)
      recorded.push({ headers: req.headers, body })
      const output = recorded.length === 1 ? ['a', 'b'].map(id => ({
        type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: wireName('read'),
        arguments: JSON.stringify({ path: `${id}.txt` }), status: 'completed',
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
    adapter = new CodexAdapter({ command: process.env.CODEX_BIN ?? 'codex', codexHome, timeoutMs: 15000 })
    const options = { provider: 'codex-provider', model: 'fixture-model',
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Read a.txt and b.txt' }] }],
    }
    const first = await Array.fromAsync(adapter.stream(options))
    assert.equal(first.at(-1).reason.kind, 'tool-calls')
    const calls = first.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').map(chunk => chunk.block)
    assert.deepEqual(calls.map(call => call.id), ['call_a', 'call_b'])
    assert.equal(recorded.length, 1, 'Codex must not continue the tool loop on its own')
    const second = await Array.fromAsync(adapter.stream({ ...options, messages: [
      ...options.messages, { role: 'assistant', content: calls },
      ...calls.map(call => ({ role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: `DSH result for ${call.id}` }] })),
    ] }))
    assert.equal(second.at(-1).reason.kind, 'stop')
    assert.equal(second.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'Both files read.')
    assert.equal(recorded.length, 2)
    const results = recorded[1].body.input.filter(item => item.type === 'function_call_output')
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
