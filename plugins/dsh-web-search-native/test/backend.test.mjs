/**
 * The native search provider's transport and parsing, and its per-provider
 * search model, without mounting Cordis or reaching the network.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  Config,
  NativeSearchProvider,
  alphaBody,
  alphaEndpoint,
  buildPrompt,
  collectAlpha,
  cleanCitations,
  collectResponses,
  collectResult,
  messagesEndpoint,
  responsesBody,
  responsesEndpoint,
} from '../index.js'

const ROUTES = {
  pool: {
    api: 'openai-responses',
    baseURL: 'https://pw.example/v1',
    apiKeyEnv: 'POOL_KEY',
    models: [
      { id: 'gpt-6-luna', name: 'Luna', reasoningEfforts: { low: 'low', off: 'none' } },
      { id: 'gpt-6-astra', name: 'Astra' },
    ],
  },
  ccmax: {
    api: 'anthropic-messages',
    baseURL: 'https://api.example',
    apiKeyEnv: 'CC_KEY',
    models: [{ id: 'claude-haiku-5-5', name: 'Haiku', compat: { forceAdaptiveThinking: true }, reasoningEfforts: { low: 'low' } }],
  },
  images: { api: 'openai-images', baseURL: 'https://img.example', apiKeyEnv: 'IMG_KEY' },
}

/** A detached provider over fixed routes, with a fetch stub and the requests it received. */
/** Distinguishes "no selection given" from "no conversation initiated the search". */
const NONE = Symbol('none')

function harness({ selection = { provider: 'pool', model: 'gpt-6-astra' }, routes = ROUTES, keys = {}, config = {}, respond } = {}) {
  const calls = []
  const ctx = {
    credentials: { resolve: async ref => ({ value: keys[ref] ?? 'secret' }) },
    agents: { currentInitiator: () => (selection === NONE ? undefined : { model: { current: () => selection } }) },
    llm: { listConfigurableProviders: () => Object.keys(routes).map(provider => ({ provider, settingsNs: 'llm' })) },
    loader: { entries: () => [{ options: { id: 'llm', name: '@deepseek-ai/dsh-llm-pi-ai' }, fiber: { effectiveConfig: { providers: { get: () => routes } } } }] },
    logger: { info: () => {} },
    web: { registerSearchProvider: () => {} },
  }
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, body, headers: init.headers })
    const answer = respond?.(url, body, calls.length) ?? { status: 200, data: {} }
    return new Response(JSON.stringify(answer.data), { status: answer.status, headers: { 'content-type': 'application/json' } })
  }
  const provider = new NativeSearchProvider(ctx, Config(config))
  return { provider, calls }
}

const alphaOk = { status: 200, data: { encrypted_output: 'opaque', output: 'Answer \ue200cite\ue202turn0search0\ue201', results: [{ type: 'text_result', url: 'https://a.example/x', title: 'A', snippet: 'sa' }] } }
const responsesOk = { status: 200, data: { output: [
  { type: 'web_search_call', action: { type: 'search', sources: [{ type: 'url', url: 'https://b.example/y' }] } },
  { type: 'message', content: [{ type: 'output_text', text: 'Done', annotations: [{ type: 'url_citation', url: 'https://c.example/z', title: 'C' }] }] },
] } }

test('endpoints accept roots with and without a version segment', () => {
  assert.equal(alphaEndpoint('https://pw.example/v1'), 'https://pw.example/v1/alpha/search')
  assert.equal(alphaEndpoint('https://pw.example/'), 'https://pw.example/v1/alpha/search')
  assert.equal(responsesEndpoint('https://pw.example/v1'), 'https://pw.example/v1/responses')
  assert.equal(messagesEndpoint('https://api.example'), 'https://api.example/v1/messages')
  assert.equal(messagesEndpoint('https://api.example/v1/'), 'https://api.example/v1/messages')
})

test('the prompt asks for an answer only when answers are on', () => {
  const now = new Date('2026-11-10T00:00:00Z')
  assert.match(buildPrompt('q', true, now), /^Today is 2026-11-10\./)
  assert.match(buildPrompt('q', true, now), /factual answer/)
  assert.doesNotMatch(buildPrompt('q', false, now), /factual answer/)
  assert.match(buildPrompt('q', false, now), /single word: done/)
})

test('alpha bodies carry the search command, and domains only when set', () => {
  const plain = alphaBody({ model: 'm', query: 'q', reasoning: { effort: 'low' }, domains: [] })
  assert.match(plain.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.deepEqual(plain.commands, { search_query: [{ q: 'q' }], response_length: 'short' })
  assert.deepEqual(plain.settings, { external_web_access: true, search_context_size: 'low' })
  assert.equal(plain.max_output_tokens, 1024)
  assert.deepEqual(plain.reasoning, { effort: 'low' })
  const scoped = alphaBody({ model: 'm', query: 'q', reasoning: undefined, domains: ['a.example'] })
  assert.deepEqual(scoped.commands.search_query, [{ q: 'q', domains: ['a.example'] }])
  assert.equal(scoped.reasoning, undefined)
})

test('Responses bodies ask the server tool for source URLs', () => {
  const body = responsesBody({ model: 'm', input: 'go', reasoning: { effort: 'low' }, maxTokens: 4096 })
  assert.deepEqual(body.tools, [{ type: 'web_search' }])
  assert.equal(body.tool_choice, 'required')
  assert.deepEqual(body.include, ['web_search_call.action.sources'])
  assert.equal(body.store, false)
  assert.equal(body.max_output_tokens, 4096)
  assert.deepEqual(body.reasoning, { effort: 'low' })
  assert.equal(responsesBody({ model: 'm', input: 'go', reasoning: undefined, maxTokens: 1 }).reasoning, undefined)
})

test('alpha replies become sources plus text with cite markers resolved', () => {
  const result = collectAlpha({
    encrypted_output: 'opaque',
    output: 'Hello \ue200cite\ue202turn0search0\ue201 world',
    results: [
      { type: 'text_result', url: 'https://a.example/x', title: 'A', snippet: 'sa', ref_id: 'turn0search0' },
      { type: 'text_result', url: 'https://a.example/x', title: 'duplicate' },
      { type: 'other_result', url: 'https://ignored.example' },
    ],
  })
  assert.equal(result.content, 'Hello [turn0search0](https://a.example/x) world')
  assert.deepEqual(result.sources, [{ url: 'https://a.example/x', title: 'A', snippet: 'sa' }])
  assert.deepEqual(collectAlpha({ results: [] }), { content: undefined, sources: [], errors: [] })
})

test('a cite marker the response cannot resolve is dropped, not left as stray text', () => {
  const unknown = collectAlpha({ output: 'Answer \ue200cite\ue202turn9search9\ue201.', results: [] })
  assert.equal(unknown.content, 'Answer.')
  const both = collectAlpha({
    output: 'One \ue200cite\ue202turn0search0\ue202turn0search1\ue201 two',
    results: [
      { type: 'text_result', url: 'https://a.example', ref_id: 'turn0search0' },
      { type: 'text_result', url: 'https://b.example', ref_id: 'turn0search1' },
    ],
  })
  assert.equal(both.content, 'One [turn0search0](https://a.example) [turn0search1](https://b.example) two')
  assert.equal(cleanCitations('nothing here', new Map()), 'nothing here')
})

test('Responses replies yield sources from search calls and citations', () => {
  const result = collectResponses(responsesOk.data)
  assert.equal(result.content, 'Done')
  assert.deepEqual(result.sources, [{ url: 'https://b.example/y' }, { url: 'https://c.example/z', title: 'C' }])
  const opened = collectResponses({ output: [{ type: 'web_search_call', action: { type: 'open_page', url: 'https://d.example' } }] })
  assert.deepEqual(opened.sources, [{ url: 'https://d.example' }])
  assert.deepEqual(collectResponses({}), { content: undefined, sources: [], errors: [] })
})

test('Messages replies prefer cited sources and take only text after the search', () => {
  const result = collectResult([
    { type: 'text', text: 'Let me look that up. ' },
    { type: 'web_search_tool_result', content: [
      { type: 'web_search_result', url: 'https://a.example', title: 'A', page_age: '2026-11-01' },
      { type: 'web_search_result', url: 'https://b.example', title: 'B' },
    ] },
    { type: 'text', text: 'The answer.', citations: [{ type: 'web_search_result_location', url: 'https://b.example', title: 'B', cited_text: 'quoted' }] },
  ])
  assert.equal(result.content, 'The answer.')
  assert.deepEqual(result.sources.map(source => source.url), ['https://b.example', 'https://a.example'])
  assert.equal(result.sources[0].snippet, 'quoted')
  assert.equal(result.sources[1].publishedAt, '2026-11-01')
  const failed = collectResult([{ type: 'web_search_tool_result', content: { error_code: 'max_uses_exceeded' } }])
  assert.deepEqual(failed.errors, ['max_uses_exceeded'])
})

const PINNED = { followSession: false, searchProvider: 'pool', searchModel: 'gpt-6-luna' }

test('following the session searches on its own provider and model', async () => {
  const followed = harness()
  const target = await followed.provider.target()
  assert.equal(target.provider, 'pool')
  assert.equal(target.model, 'gpt-6-astra')
  assert.equal(target.effort, undefined, 'the conversation effort is not carried over')
  assert.equal(target.transport, 'auto')
})

test('a pinned channel searches on its model and effort for every conversation', async () => {
  // The conversation runs on ccmax; the search still goes to pool.
  const { provider, calls } = harness({
    selection: { provider: 'ccmax', model: 'claude-opus-5-5', reasoningEffort: 'xhigh' },
    config: { ...PINNED, searchReasoningEffort: 'off', searchTransport: 'alpha-search' },
    respond: () => ({ status: 200, data: { output: 'text', results: [{ type: 'text_result', url: 'https://a.example' }] } }),
  })
  const target = await provider.target()
  assert.equal(target.provider, 'pool')
  assert.equal(target.model, 'gpt-6-luna')
  assert.equal(target.effort, 'off')
  assert.equal(target.transport, 'alpha-search')
  await provider.search({ query: 'q' })
  assert.match(calls[0].url, /pw\.example\/v1\/alpha\/search$/, 'the pinned route, not the conversation route')
  assert.equal(calls[0].body.model, 'gpt-6-luna')
  assert.equal(calls[0].body.reasoning, undefined, 'off maps to no reasoning field')
})

test('a pinned channel searches without a conversation and offers the tool everywhere', async () => {
  const { provider } = harness({ selection: NONE, config: PINNED })
  assert.equal((await provider.target()).provider, 'pool')
  assert.equal(await provider.ready('ccmax'), true, 'a pinned channel is independent of the step route')
  assert.equal(await provider.ready(undefined), true)
})

test('a pinned channel with no usable model or key is reported', async () => {
  await assert.rejects(harness({ config: { ...PINNED, searchModel: '' } }).provider.target(), /has no search model/)
  await assert.rejects(harness({ config: { ...PINNED, searchModel: 'gpt-5-retired' } }).provider.target(), /no longer lists model "gpt-5-retired"/)
  await assert.rejects(harness({ config: { ...PINNED, searchProvider: 'images' } }).provider.target(), /pinned provider "images" cannot run/)
  const unkeyed = harness({ config: PINNED, keys: { POOL_KEY: '' } })
  await assert.rejects(unkeyed.provider.target(), /credential POOL_KEY of pinned provider "pool" is not set/)
  assert.equal(await unkeyed.provider.ready('pool'), false, 'a pinned channel without a key offers no tool')
})

test('a conversation without a usable provider or key is reported, not silently searched', async () => {
  await assert.rejects(harness({ selection: NONE }).provider.target(), /none did/)
  await assert.rejects(harness({ selection: { provider: 'images', model: 'x' } }).provider.target(), /cannot run native web search/)
  await assert.rejects(harness({ keys: { POOL_KEY: '  ' } }).provider.target(), /not set/)
  assert.equal(await harness({ selection: { provider: 'images', model: 'x' } }).provider.ready('images'), false)
  assert.equal(await harness().provider.ready('pool'), true)
  assert.equal(await harness().provider.ready('ccmax'), true)
})

test('an OpenAI provider searches with alpha and reports its structured sources', async () => {
  const { provider, calls } = harness({ respond: () => alphaOk })
  const result = await provider.search({ query: 'news', maxResults: 10 })
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/v1\/alpha\/search$/)
  assert.equal(calls[0].headers.authorization, 'Bearer secret')
  assert.equal(calls[0].body.model, 'gpt-6-astra')
  assert.deepEqual(result.sources, [{ url: 'https://a.example/x', title: 'A', snippet: 'sa' }])
  assert.equal(result.truncated, false)
})

test('automatic transport falls back to Responses and remembers the failure', async () => {
  const { provider, calls } = harness({
    respond: (url) => url.endsWith('/alpha/search') ? { status: 404, data: { error: { message: 'no route' } } } : responsesOk,
  })
  const first = await provider.search({ query: 'news' })
  assert.equal(calls.length, 2)
  assert.match(calls[1].url, /\/v1\/responses$/)
  assert.deepEqual(first.sources.map(source => source.url), ['https://b.example/y', 'https://c.example/z'])
  // The remembered failure skips alpha for the next query.
  await provider.search({ query: 'again' })
  assert.equal(calls.length, 3)
  assert.match(calls[2].url, /\/v1\/responses$/)
})

test('cancellation never falls back, and a pinned transport never probes', async () => {
  const controller = new AbortController()
  const aborted = harness({
    respond: () => {
      controller.abort()
      return { status: 500, data: { error: { message: 'boom' } } }
    },
  })
  await assert.rejects(aborted.provider.search({ query: 'q' }, controller.signal))
  assert.equal(aborted.calls.length, 1)

  const pinned = harness({
    config: { ...PINNED, searchTransport: 'responses' },
    respond: (url) => url.endsWith('/responses') ? responsesOk : alphaOk,
  })
  await pinned.provider.search({ query: 'q' })
  assert.equal(pinned.calls.length, 1)
  assert.match(pinned.calls[0].url, /\/responses$/)
})

test('an Anthropic route sends the server tool, its version header, and the search model', async () => {
  const { provider, calls } = harness({
    selection: { provider: 'ccmax', model: 'claude-opus-5-5' },
    config: { followSession: false, searchProvider: 'ccmax', searchModel: 'claude-haiku-5-5' },
    respond: () => ({ status: 200, data: { stop_reason: 'end_turn', content: [
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.example', title: 'A' }] },
      { type: 'text', text: 'The answer.' },
    ] } }),
  })
  const result = await provider.search({ query: 'q' })
  assert.match(calls[0].url, /\/v1\/messages$/)
  assert.equal(calls[0].body.model, 'claude-haiku-5-5')
  assert.equal(calls[0].headers['anthropic-version'], '2023-06-01')
  assert.deepEqual(calls[0].body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }])
  assert.deepEqual(calls[0].body.thinking, { type: 'adaptive' })
  assert.deepEqual(calls[0].body.output_config, { effort: 'low' })
  assert.equal(result.content, 'The answer.')
})

test('answers can be switched off, and maxResults truncates the sources', async () => {
  const { provider } = harness({
    config: { answer: false },
    respond: () => ({ status: 200, data: { output: 'text', results: [
      { type: 'text_result', url: 'https://a.example' },
      { type: 'text_result', url: 'https://b.example' },
    ] } }),
  })
  const result = await provider.search({ query: 'q', maxResults: 1 })
  assert.equal(result.content, undefined)
  assert.equal(result.sources.length, 1)
  assert.equal(result.truncated, true)
})

test('HTTP failures name the model and the host', async () => {
  const { provider } = harness({
    config: { ...PINNED, searchTransport: 'responses' },
    respond: () => ({ status: 400, data: { error: { message: 'model not found' } } }),
  })
  await assert.rejects(provider.search({ query: 'q' }), /HTTP 400 from pw\.example for model gpt-6-luna: model not found/)
})

test('an answer with no results behind it is not a search', async () => {
  // An empty alpha reply falls back like any other failure; the pinned form reports it directly.
  const empty = harness({ config: { ...PINNED, searchTransport: 'alpha-search' }, respond: () => ({ status: 200, data: { results: [], output: '   ' } }) })
  await assert.rejects(empty.provider.search({ query: 'q' }), /alpha\/search returned no results/)
  // The endpoint wrote an answer without searching; both forms report it and the automatic one falls back.
  const invented = harness({
    respond: (url) => url.endsWith('/alpha/search')
      ? { status: 200, data: { output: 'DeepSeek makes a harness, probably.', results: [] } }
      : { status: 200, data: { output: [{ type: 'web_search_call', action: { type: 'search', sources: [{ type: 'url', url: 'https://a.example' }] } }] } },
  })
  const result = await invented.provider.search({ query: 'q' })
  assert.equal(invented.calls.length, 2, 'it fell back rather than answering from nothing')
  assert.deepEqual(result.sources.map(source => source.url), ['https://a.example'])
  const pinnedResponses = harness({
    config: { ...PINNED, searchTransport: 'responses' },
    respond: () => ({ status: 200, data: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'no sources' }] }] } }),
  })
  await assert.rejects(pinnedResponses.provider.search({ query: 'q' }), /Responses returned no results/)
})

test('a Messages route that accepts the tool but never searches is an error', async () => {
  const ignored = harness({
    selection: { provider: 'ccmax', model: 'claude-opus-5-5' },
    respond: () => ({ status: 200, data: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'I have no web search tool.' }] } }),
  })
  await assert.rejects(ignored.provider.search({ query: 'q' }), /returned no search results/)
  // One request only: the unversioned tool name is a client tool on such a route.
  assert.equal(ignored.calls.length, 1)
})
