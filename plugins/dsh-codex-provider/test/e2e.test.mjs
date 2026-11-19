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
const script = (id, input) => ({ type: 'custom_tool_call', id: `ctc_${id}`, call_id: `call_${id}`, name: 'exec', input, status: 'completed' })
const message = (id, text) => ({ type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] })

async function fixture(outputs, catalog) {
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
  if (catalog) await writeFile(join(codexHome, 'models.json'), JSON.stringify({ models: [{
    slug: 'gpt-6.2-sol', display_name: 'GPT Fixture', description: 'Loopback model fixture',
    default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low', description: 'Low' }],
    shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority: 1,
    additional_speed_tiers: ['fast', 'ultrafast'],
    service_tiers: [{ id: 'priority', name: 'Fast', description: 'Fast' }, { id: 'ultrafast', name: 'Ultrafast', description: 'Ultrafast' }],
    model_messages: { instructions_template: 'Fixture' },
    supports_reasoning_summaries: false, support_verbosity: false,
    truncation_policy: { mode: 'bytes', limit: 10000 }, supports_parallel_tool_calls: true,
    experimental_supported_tools: [], context_window: 128000, input_modalities: ['text'], ...catalog,
  }] }))
  await writeFile(join(codexHome, 'config.toml'), [
    ...(catalog ? [`model_catalog_json=\"${join(codexHome, 'models.json')}\"`] : []),
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

test('real Codex opts into live search for one temporary thread only and forwards cited URLs', { timeout: 60000 }, async () => {
  const url = 'https://iana.example/domains'
  const answer = message('msg_search', 'IANA reserved them.')
  answer.content[0].annotations = [{ type: 'url_citation', url, title: 'IANA', start_index: 0, end_index: 4 }]
  const action = { type: 'web_search_call', id: 'ws_search', status: 'completed', action: { type: 'search', query: 'test' } }
  const f = await fixture([[message('msg_1', 'Hi')], [action, answer], [message('msg_3', 'Back')]])
  const adapter = new CodexAdapter({ codexPath: process.env.CODEX_BIN ?? 'codex', codexHome: f.codexHome, timeoutMs: 20000 })
  const chat = { provider: 'codex-provider', model: 'fixture-model', sessionId: 'chat', messages: [user('private history')], tools }
  try {
    const first = await Array.fromAsync(adapter.stream(chat))
    assert.deepEqual(await adapter.search({ model: chat.model, query: 'test' }), {
      content: 'IANA reserved them.', sources: [{ url, title: 'IANA' }],
    })
    await Array.fromAsync(adapter.stream({ ...chat, messages: [...chat.messages, assistantOf(first, chat), user('next')] }))
    const [before, search, after] = f.recorded.map(r => r.body)
    assert.equal(before.prompt_cache_key, after.prompt_cache_key)
    assert.notEqual(search.prompt_cache_key, before.prompt_cache_key)
    assert.deepEqual(search.tools.map(t => t.type), ['web_search'])
    assert.equal(search.tools[0].external_web_access, true)
    assert.equal(before.tools.some(t => t.type === 'web_search'), false)
    assert.equal(after.tools.some(t => t.type === 'web_search'), false)
    assert.deepEqual(search.input.filter(i => i.role === 'user').map(inputText), ['test'])
  } finally { await adapter.dispose(); await f.close() }
})

test('real Codex sends the selected tier and capability downgrades to the loopback API', { timeout: 60000 }, async () => {
  const f = await fixture([[message('speed_1', 'Ultra')], [message('speed_2', 'Fast')], [message('speed_3', 'Standard')]], {})
  const adapter = new CodexAdapter({ codexPath: process.env.CODEX_BIN ?? 'codex', codexHome: f.codexHome, timeoutMs: 20000 })
  adapter.sessionSpeed = () => 'ultrafast'
  const options = { provider: 'codex-provider', model: 'gpt-6.2-sol', sessionId: 'speed', tools: [], messages: [user('Hello')] }
  try {
    const first = await Array.fromAsync(adapter.stream(options))
    assert.deepEqual(adapter.catalog[0].serviceTiers.map(tier => tier.id), ['priority', 'ultrafast'])
    adapter.catalog[0].serviceTiers = [{ id: 'priority' }]
    const second = await Array.fromAsync(adapter.stream({ ...options, messages: [...options.messages, assistantOf(first, options), user('Again')] }))
    adapter.catalog[0].serviceTiers = []
    await Array.fromAsync(adapter.stream({ ...options, messages: [...options.messages, assistantOf(first, options), user('Again'), assistantOf(second, options), user('Once more')] }))
    assert.deepEqual(f.recorded.map(r => r.body.service_tier ?? null), ['ultrafast', 'priority', null])
    assert.equal(new Set(f.recorded.map(r => r.body.prompt_cache_key)).size, 1)
  } finally { await adapter.dispose(); await f.close() }
})

// Different, valid 1 × 1 RGB PNGs. Codex decodes them before forwarding.
const pngs = {
  'user.png': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'tool.png': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC',
}
const pngUrl = name => `data:image/png;base64,${pngs[name]}`
const picture = name => ({ type: 'image', attachment: {
  attachmentId: name, name, mediaType: 'image/png', width: 1, height: 1, bytes: Buffer.from(pngs[name], 'base64').length,
} })
const toolOutput = (input, name) => input.find(item => item.type === name && item.call_id === 'call_image')?.output
const imageUrls = content => content.filter(part => part.type === 'input_image').map(part => part.image_url)
const imageArgs = { file_path: 'tool.png' }
const readImageTool = { name: 'read_image', description: 'Read an image file and return the image itself.',
  parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }
const imageReadText = `<path>/fixture/tool.png</path>
<type>image</type>
<content>
image/png image, 1x1 px, ${picture('tool.png').attachment.bytes} bytes
</content>`
const readImageCall = `await tools.read_image(${JSON.stringify(imageArgs)})`

const readArgs = { path: 'notes.txt' }
for (const [label, program] of [
  ['ordinary tool', undefined],
  ['code-mode read_image', String.raw`text(await tools.read(${JSON.stringify(readArgs)}));
const r = ${readImageCall}; const i = r.lastIndexOf('\ndata:image/');
if (i < 0) text(r); else { text(r.slice(0, i)); image(r.slice(i + 1)); }`],
  ['code-mode text()', `text(${readImageCall});`],
]) {
  const sequential = label === 'code-mode read_image'
  test(`real Codex sends and rebuilds user and tool images: ${label}`, { timeout: 60000 }, async () => {
    const f = await fixture([
      [program ? script('image', program) : call('image', readImageTool.name, imageArgs)],
      [message('msg_images', 'Images checked.')], [message('msg_rebuilt', 'Rebuilt.')],
    ], { input_modalities: ['text', 'image'], ...(program ? { tool_mode: 'code_mode_only' } : {}) })
    const attachments = {
      async readImageRequest(attachment) {
        const data = Buffer.from(pngs[attachment.name], 'base64')
        return { attachment, data, mediaType: 'image/png', width: 1, height: 1, bytes: data.length }
      },
    }
    const makeAdapter = () => new CodexAdapter({
      codexPath: process.env.CODEX_BIN ?? 'codex', codexHome: f.codexHome, timeoutMs: 20000,
    }, undefined, undefined, () => attachments)
    const adapter = makeAdapter()
    let restarted
    try {
      const options = { provider: 'codex-provider', model: 'gpt-6.2-sol', sessionId: 'images',
        tools: sequential ? [tools[0], readImageTool] : [readImageTool],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect this picture.' }, picture('user.png')] }] }
      assert.deepEqual((await adapter.resolveModel(options.provider, options.model)).inputModalities, ['text', 'image'])

      const history = [...options.messages]
      let step = await Array.fromAsync(adapter.stream(options))
      if (sequential) {
        assert.equal(step.at(-1).reason.kind, 'tool-calls')
        const calls = blocksOf(step).filter(block => block.type === 'tool-call')
        assert.deepEqual(calls.map(c => [c.name, JSON.parse(c.arguments)]), [['read', readArgs]])
        history.push(assistantOf(step, options), { role: 'tool', toolCallId: calls[0].id,
          content: [{ type: 'text', text: 'Notes checked.' }] })
        step = await Array.fromAsync(adapter.stream({ ...options, messages: history }))
        assert.equal(f.recorded.length, 1, 'The same Codex script waits for a second DSH tool')
      }
      assert.equal(step.at(-1).reason.kind, 'tool-calls')
      const calls = blocksOf(step).filter(block => block.type === 'tool-call')
      assert.deepEqual(calls.map(c => [c.name, JSON.parse(c.arguments)]), [[readImageTool.name, imageArgs]])

      const content = [{ type: 'text', text: imageReadText }, picture('tool.png')]
      if (!program) content.push({ type: 'text', text: 'after' })
      history.push(assistantOf(step, options), { role: 'tool', toolCallId: calls[0].id, content })
      const second = await Array.fromAsync(adapter.stream({ ...options, messages: history }))
      assert.equal(blocksOf(second).at(-1).text, 'Images checked.')
      assert.ok(!JSON.stringify(second.at(-1).replayState).includes(pngs['tool.png']), 'Replay metadata must not duplicate tool image bytes')

      const [initial, continued] = f.recorded.map(r => r.body)
      assert.deepEqual(imageUrls(initial.input.find(i => i.role === 'user').content), [pngUrl('user.png')])
      assert.equal(continued.prompt_cache_key, initial.prompt_cache_key)
      const output = toolOutput(continued.input, program ? 'custom_tool_call_output' : 'function_call_output')
      if (!program) {
        assert.deepEqual(output.map(part => part.image_url ?? part.text), [imageReadText, pngUrl('tool.png'), 'after'])
      } else if (sequential) {
        const execTool = initial.tools.find(tool => tool.name === 'exec')
        assert.match(execTool.description, /pass its last line \(the data:image\/ URL\) to image\(\) and the preceding description to text\(\)/)
        assert.deepEqual(imageUrls(output), [pngUrl('tool.png')])
        assert.ok(output.some(part => part.type === 'input_text' && part.text === 'Notes checked.'))
        assert.ok(output.some(part => part.type === 'input_text' && part.text === imageReadText))
      } else {
        assert.deepEqual(imageUrls(output), [])
        assert.ok(output.some(part => part.text?.includes(pngUrl('tool.png'))), 'Codex stringifies the image when the script calls text()')
      }

      restarted = makeAdapter()
      const rebuilt = await Array.fromAsync(restarted.stream({ ...options,
        messages: [...history, assistantOf(second, options), user('Look again.')] }))
      assert.equal(blocksOf(rebuilt).at(-1).text, 'Rebuilt.')
      const rebuiltRequest = f.recorded[2].body
      assert.notEqual(rebuiltRequest.prompt_cache_key, initial.prompt_cache_key)
      assert.deepEqual(imageUrls(rebuiltRequest.input.filter(item => item.role === 'user').flatMap(item => item.content)), [pngUrl('user.png')])
      const rebuiltOutput = rebuiltRequest.input.filter(item => Array.isArray(item.output)).flatMap(item => item.output)
      assert.deepEqual(imageUrls(rebuiltOutput), [pngUrl('tool.png')])
      assert.ok(rebuiltOutput.some(part => part.type === 'input_text' && part.text === imageReadText))
      if (sequential) {
        const rebuiltCalls = rebuiltRequest.input.filter(item => item.type === 'function_call')
        assert.deepEqual(rebuiltCalls.map(item => item.name), ['read', 'read_image'])
        assert.ok(rebuiltRequest.input.some(item => item.type === 'function_call_output'
          && item.call_id === rebuiltCalls[0].call_id && item.output === 'Notes checked.'))
        const rebuiltImage = rebuiltRequest.input.find(item => item.type === 'function_call_output'
          && item.call_id === rebuiltCalls[1].call_id)
        assert.deepEqual(imageUrls(rebuiltImage.output), [pngUrl('tool.png')])
      }
    } finally {
      await adapter.dispose()
      await restarted?.dispose()
      await f.close()
    }
  })
}
