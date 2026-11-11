/**
 * Native web search provider for the DeepSeek Harness `ctx.web` seam.
 *
 * Every `ctx.web.search()` call becomes one model request that carries the
 * API's own search capability, on the provider the initiating Agent's
 * conversation is using. Each provider can name the model its searches run on,
 * or follow the conversation's model; the chosen route's protocol picks the
 * request form: `anthropic-messages` sends the server-side `web_search` tool,
 * `openai-responses` searches through the OpenAI search endpoints. The route
 * also supplies the endpoint, credential, and headers, so no model or endpoint
 * is configured here. A provider whose route runs neither protocol answers not
 * ready, which withdraws the built-in `web_search` tool for its model steps.
 *
 * @module @pcmid/dsh-web-search-native
 */

import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-native'

/**
 * The web seam this provider registers into, plus the services that answer
 * which model is current, which route owns it, and what that route's key is.
 */
export const inject = ['web', 'credentials', 'agents', 'llm', 'loader']

/** Default Anthropic Messages API version header. */
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01'

/** Package whose Loader row holds the route profiles this provider reads. */
const ROUTE_OWNER_PACKAGE = '@deepseek-ai/dsh-llm-pi-ai'

/** Route protocol that accepts the server-side `web_search` tool. */
const MESSAGES_API = 'anthropic-messages'

/** Route protocol that searches through the OpenAI search endpoints. */
const RESPONSES_API = 'openai-responses'

/** Continuations allowed when the API pauses a long server-tool turn (`stop_reason: pause_turn`). */
const MAX_PAUSE_CONTINUATIONS = 3

/** Character cap for one source snippet assembled from cited passages. */
const SNIPPET_MAX_CHARS = 600

/** Output cap of one `alpha/search` request; it returns search results, not an essay. */
const ALPHA_MAX_OUTPUT_TOKENS = 1024

/** How long a provider that failed `alpha/search` goes straight to Responses. */
const ALPHA_RETRY_MS = 10 * 60 * 1000

/** Private-use characters the OpenAI search endpoints wrap citation markers in. */
const CITATION_MARKERS = /[\uE000-\uF8FF]/gu

/** One complete cite marker, which wraps the reference ids it keeps separate. */
const CITE_MARKER = /\uE200cite((?:\uE202[^\uE200\uE201]*)+)\uE201/gu

/** One reference id inside a cite marker, as `turn0search0` in `\ue202turn0search0`. */
const CITE_REF = /[\uE202]/u

export const Config = z.object({
  providerId: z.string().default('native-search')
    .description('Search provider id. Pin it as web.searchProvider when several search providers are registered.'),
  toolType: z.string().default('web_search_20250305')
    .description('Server tool type sent to Anthropic Messages routes.'),
  maxUses: z.natural().min(1).default(3)
    .description('Maximum native searches the model may run for one query.'),
  maxTokens: z.natural().min(256).default(4096)
    .description('max_tokens of each request; thinking output counts toward it.'),
  thinkingEffort: z.string().default('low')
    .description('Effort used when a search model names none. Anthropic routes send output_config.effort for models the route marks compat.forceAdaptiveThinking; OpenAI routes send it as reasoning.effort.'),
  answer: z.boolean().default(true)
    .description('Ask the model for a short cited answer in addition to the sources.'),
  allowedDomains: z.array(z.string()).default([])
    .description('Only search these domains. Sent to Anthropic Messages routes and to alpha/search; the Responses endpoint has no equivalent.'),
  blockedDomains: z.array(z.string()).default([])
    .description('Never search these domains (blocked_domains). Anthropic Messages routes only.'),
  anthropicVersion: z.string().default(DEFAULT_ANTHROPIC_VERSION)
    .description('anthropic-version request header.'),
  followSession: z.boolean().default(true)
    .description('On: every search uses the model the initiating conversation runs, on its own provider. Off: every search uses searchProvider, searchModel, and searchReasoningEffort.')
    .volatile(),
  searchProvider: z.string().default('')
    .description('Provider every search runs on while followSession is off.')
    .volatile(),
  searchModel: z.string().default('')
    .description('Model every search runs on while followSession is off.')
    .volatile(),
  searchReasoningEffort: z.string().default('')
    .description('Reasoning effort of that model; empty uses the route default, or the search provider\'s light default.')
    .volatile(),
  searchTransport: z.union(['auto', 'alpha-search', 'responses']).default('auto')
    .description('OpenAI request form: auto tries alpha/search first and falls back to Responses; either name pins that endpoint.')
    .volatile(),
})

/** Messages endpoint for an API root, accepting roots with or without a trailing `/v1`. */
export function messagesEndpoint(baseURL) {
  return `${apiRoot(baseURL)}/messages`
}

/** Versioned root of an OpenAI-style API, accepting roots with or without a trailing `/v1`. */
export function apiRoot(baseURL) {
  const root = baseURL.replace(/\/+$/, '')
  return /\/v1$/.test(root) ? root : `${root}/v1`
}

/** Search endpoint of an OpenAI-compatible root. */
export function alphaEndpoint(baseURL) {
  return `${apiRoot(baseURL)}/alpha/search`
}

/** Responses endpoint of an OpenAI-compatible root. */
export function responsesEndpoint(baseURL) {
  return `${apiRoot(baseURL)}/responses`
}

/** Prompt that makes the model search for one query and answer from the results only. */
export function buildPrompt(query, answer, now = new Date()) {
  const today = now.toISOString().slice(0, 10)
  if (!answer) {
    return `Today is ${today}. Use the web_search tool to search the web for the query below. `
      + 'After searching, reply with the single word: done.\n\n'
      + `Query: ${query}`
  }
  return `Today is ${today}. Use the web_search tool to research the query below, then write a concise, `
    + 'factual answer of at most about 200 words, grounded only in the search results and written in the '
    + 'language of the query. Mention dates when recency matters, and say so when the results do not answer '
    + 'the query.\n\n'
    + `Query: ${query}`
}

/** Request body of one `alpha/search` call. */
export function alphaBody({ model, query, reasoning, domains }) {
  return {
    id: randomUUID(),
    model,
    ...reasoning === undefined ? {} : { reasoning },
    input: query,
    commands: {
      search_query: [{ q: query, ...domains.length > 0 ? { domains } : {} }],
      response_length: 'short',
    },
    settings: { external_web_access: true, search_context_size: 'low' },
    max_output_tokens: ALPHA_MAX_OUTPUT_TOKENS,
  }
}

/** Request body of one Responses call that searches with the server-side tool. */
export function responsesBody({ model, input, reasoning, maxTokens }) {
  return {
    model,
    input,
    max_output_tokens: maxTokens,
    tools: [{ type: 'web_search' }],
    tool_choice: 'required',
    include: ['web_search_call.action.sources'],
    store: false,
    ...reasoning === undefined ? {} : { reasoning },
  }
}

/** Single-line, length-capped text. */
function clip(text, max) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Non-empty trimmed string, or undefined. */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Add one source once, keeping the first fields seen for its URL. */
function addSource(sources, seen, url, title, snippet) {
  if (seen.has(url)) return
  seen.add(url)
  sources.push({
    url,
    ...title === undefined ? {} : { title },
    ...snippet === undefined ? {} : { snippet },
  })
}

/**
 * Convert Messages response content blocks into a `WebSearchResult` body.
 * Cited sources come first, in citation order; uncited results follow in
 * search order. Only text written after the last search result counts as
 * the answer, so any preamble before the search is dropped.
 */
export function collectResult(blocks) {
  const results = new Map()
  const errors = []
  const citations = new Map()
  let lastResultIndex = -1

  blocks.forEach((block, index) => {
    if (block?.type !== 'web_search_tool_result') return
    lastResultIndex = index
    const content = block.content
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item?.type !== 'web_search_result' || typeof item.url !== 'string' || results.has(item.url)) continue
        results.set(item.url, {
          url: item.url,
          title: text(item.title),
          publishedAt: text(item.page_age),
        })
      }
    } else if (content && typeof content === 'object' && typeof content.error_code === 'string') {
      errors.push(content.error_code)
    }
  })

  const answerParts = []
  blocks.forEach((block, index) => {
    if (block?.type !== 'text' || typeof block.text !== 'string') return
    if (index > lastResultIndex) answerParts.push(block.text)
    for (const citation of block.citations ?? []) {
      if (citation?.type !== 'web_search_result_location' || typeof citation.url !== 'string') continue
      const entry = citations.get(citation.url) ?? { title: text(citation.title), passages: [] }
      if (typeof citation.cited_text === 'string') {
        const passage = citation.cited_text.trim()
        if (passage !== '' && !entry.passages.includes(passage)) entry.passages.push(passage)
      }
      citations.set(citation.url, entry)
    }
  })

  const sources = []
  for (const [url, cited] of citations) {
    const result = results.get(url)
    sources.push({
      url,
      title: result?.title ?? cited.title,
      snippet: cited.passages.length > 0 ? clip(cited.passages.join(' … '), SNIPPET_MAX_CHARS) : undefined,
      publishedAt: result?.publishedAt,
    })
  }
  for (const [url, result] of results) {
    if (!citations.has(url)) sources.push({ ...result })
  }

  const content = answerParts.join('').trim()
  return {
    content: content === '' ? undefined : content,
    sources: sources.map(source => Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined))),
    errors,
  }
}

/**
 * Rewrite the private cite markers of search text: a reference its own result
 * list defines becomes a markdown link, and a marker this text cannot resolve
 * is dropped rather than left as stray characters.
 * @param value - search text as the endpoint returned it.
 * @param refs - URL of each `ref_id` the same response listed.
 * @returns the text with every marker resolved or removed.
 */
export function cleanCitations(value, refs) {
  return value
    .replace(CITE_MARKER, (marker, body) => {
      const links = body.split(CITE_REF)
        .filter(id => id !== '')
        .flatMap(id => refs.has(id) ? [`[${id}](${refs.get(id)})`] : [])
      return links.length === 0 ? '' : ` ${links.join(' ')} `
    })
    .replace(CITATION_MARKERS, '')
    // A removed marker leaves the space it sat in; punctuation closes back up.
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/[ \t]+([.,;:!?)\]])/gu, '$1')
    .trim()
}

/**
 * Convert an `alpha/search` response into a `WebSearchResult` body: its
 * `results` carry structured sources, and `output` is the searched text with
 * its cite markers resolved into links. `encrypted_output` is opaque and
 * ignored.
 */
export function collectAlpha(data) {
  const sources = []
  const seen = new Set()
  const refs = new Map()
  for (const item of Array.isArray(data?.results) ? data.results : []) {
    if (item?.type !== 'text_result' || typeof item.url !== 'string') continue
    if (typeof item.ref_id === 'string') refs.set(item.ref_id, item.url)
    addSource(sources, seen, item.url, text(item.title), text(item.snippet))
  }
  const output = typeof data?.output === 'string' ? cleanCitations(data.output, refs) : ''
  return { content: output === '' ? undefined : output, sources, errors: [] }
}

/**
 * Convert a Responses result into a `WebSearchResult` body. Sources come from
 * each search call's reported URLs and from the citations of the answer text;
 * the answer text becomes the content. Servers that return neither still
 * produce a valid empty result.
 */
export function collectResponses(data) {
  const sources = []
  const seen = new Set()
  const answerParts = []
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    if (item?.type === 'web_search_call') {
      const action = item.action
      for (const url of Array.isArray(action?.sources) ? action.sources : []) {
        if (url?.type === 'url' && typeof url.url === 'string') addSource(sources, seen, url.url)
      }
      if (action?.type === 'open_page' && typeof action.url === 'string') addSource(sources, seen, action.url)
      continue
    }
    if (item?.type !== 'message') continue
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (part?.type !== 'output_text' || typeof part.text !== 'string') continue
      answerParts.push(part.text)
      for (const annotation of part.annotations ?? []) {
        if (annotation?.type !== 'url_citation' || typeof annotation.url !== 'string') continue
        addSource(sources, seen, annotation.url, text(annotation.title))
      }
    }
  }
  // Citations arrive as annotations here, so a marker only needs removing.
  const content = cleanCitations(answerParts.join('\n\n'), new Map())
  return { content: content === '' ? undefined : content, sources, errors: [] }
}

/** Search provider that runs native web search on the initiating Agent's route. */
export class NativeSearchProvider {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.id = config.providerId
    this.title = '接口原生搜索'
    this.description = {
      en: 'Runs the model API\'s built-in web search, either on the conversation\'s own provider and model or on '
        + 'one pinned provider and model for every search. Each query is one model request billed at that model\'s '
        + 'rate, including search fees and result tokens. Supports Anthropic Messages and OpenAI Responses routes.',
      zh: '调用接口自带的网页搜索：按会话所用的供应商和模型执行，或固定一个供应商和模型供所有搜索使用。'
        + '每个查询是一次按该模型计费的请求，含搜索费用和结果 token。支持 Anthropic Messages 和 OpenAI Responses 路由。',
    }
    /** Provider keys whose `alpha/search` failed recently, so auto transport skips straight to Responses. */
    this.alphaFailures = new Map()
  }

  /** Whether a search can run is decided by `ready()`, so the provider is always selectable. */
  available() {
    return true
  }

  /**
   * The provider searches run on while the deployment pins one, or the empty
   * string while they follow the conversation.
   * @returns the configured provider id.
   */
  get pinnedProvider() {
    return this.config.followSession.get() === false ? this.config.searchProvider.get() : ''
  }

  /**
   * Offer web_search while a search could run. A pinned provider is
   * independent of the step's route, so every conversation offers the tool;
   * otherwise the step's own route decides. Never touches the network.
   */
  async ready(llmProvider) {
    const pinned = this.pinnedProvider
    if (pinned !== '') {
      const route = this.routeOf(pinned)
      return route !== undefined && (await this.apiKey(route)) !== undefined
    }
    const provider = llmProvider ?? this.currentSelection()?.provider
    if (provider === undefined) return false
    const route = this.routeOf(provider)
    if (route === undefined) return false
    return (await this.apiKey(route)) !== undefined
  }

  /** Model selection of the Agent whose tool call is running, when one is. */
  currentSelection() {
    return this.ctx.agents.currentInitiator()?.model.current()
  }

  /**
   * The search target for the conversation's provider.
   * @returns the provider, the model its searches run on, that model's effort,
   * the OpenAI request form, and the route and key that reach it.
   * @throws when no conversation initiated this search, or when its provider
   * cannot run native search.
   */
  async target() {
    const pinned = this.pinnedProvider
    if (pinned !== '') return this.pinnedTarget(pinned)
    const selection = this.currentSelection()
    if (selection === undefined) {
      throw new Error(`${this.id}: web search follows the conversation that initiated it, and none did; pin a provider to search without one`)
    }
    const route = this.routeOf(selection.provider)
    if (route === undefined) {
      throw new Error(`${this.id}: provider "${selection.provider}" cannot run native web search; it needs api: ${MESSAGES_API} or ${RESPONSES_API}, a baseURL, and an apiKeyEnv`)
    }
    const apiKey = await this.apiKey(route)
    if (apiKey === undefined) {
      throw new Error(`${this.id}: credential ${route.apiKeyRef} of provider "${selection.provider}" is not set`)
    }
    return {
      provider: selection.provider,
      model: selection.model,
      effort: undefined,
      transport: 'auto',
      route,
      apiKey,
    }
  }

  /**
   * The search target of the pinned provider, which does not depend on the
   * conversation that started the search.
   * @param provider - the configured provider id.
   * @returns its model, effort, request form, route, and key.
   * @throws when the provider cannot search, has no model chosen, names a
   * model it no longer lists, or has no key.
   */
  async pinnedTarget(provider) {
    const route = this.routeOf(provider)
    if (route === undefined) {
      throw new Error(`${this.id}: pinned provider "${provider}" cannot run native web search; it needs api: ${MESSAGES_API} or ${RESPONSES_API}, a baseURL, and an apiKeyEnv`)
    }
    const apiKey = await this.apiKey(route)
    if (apiKey === undefined) {
      throw new Error(`${this.id}: credential ${route.apiKeyRef} of pinned provider "${provider}" is not set`)
    }
    const model = this.config.searchModel.get()
    if (model === '') {
      throw new Error(`${this.id}: pinned provider "${provider}" has no search model; choose one, or follow the conversation`)
    }
    const listed = route.profile.models ?? []
    if (listed.length > 0 && !listed.some(entry => entry.id === model)) {
      throw new Error(`${this.id}: pinned provider "${provider}" no longer lists model "${model}"; choose another, or follow the conversation`)
    }
    return {
      provider,
      model,
      effort: this.config.searchReasoningEffort.get() || undefined,
      transport: this.config.searchTransport.get(),
      route,
      apiKey,
    }
  }

  /**
   * Connection facts of one route, read from its `llm-pi-ai` profile on every
   * call so a route edit applies to the next search.
   * @returns the endpoint, key reference, headers, and profile, or undefined
   * when the route runs neither supported protocol or names no `baseURL` or
   * `apiKeyEnv`. Catalog routes and other adapters' routes declare neither.
   */
  routeOf(provider) {
    const row = this.ctx.llm.listConfigurableProviders().find(entry => entry.provider === provider)
    if (row === undefined) return undefined
    const owner = [...this.ctx.loader.entries()]
      .find(entry => entry.options.id === row.settingsNs && entry.options.name === ROUTE_OWNER_PACKAGE)
    const profile = owner?.fiber?.effectiveConfig?.providers?.get()?.[provider]
    if (profile?.api !== MESSAGES_API && profile?.api !== RESPONSES_API) return undefined
    if (!profile.baseURL || !profile.apiKeyEnv) return undefined
    return { baseURL: profile.baseURL, apiKeyRef: profile.apiKeyEnv, headers: profile.headers ?? {}, profile }
  }

  /**
   * Thinking fields of one Anthropic Messages search turn, keeping it as light
   * as the model allows. Models the route marks `compat.forceAdaptiveThinking`
   * reject `thinking: { type: disabled }`, so they get adaptive thinking at the
   * requested effort, translated through the route's effort table, or else at
   * the configured effort.
   */
  thinkingFields(route, model, effort) {
    const declared = route.profile.models?.find(entry => entry.id === model) ?? route.profile.modelOverrides?.[model]
    if (declared?.compat?.forceAdaptiveThinking !== true) return { thinking: { type: 'disabled' } }
    const requested = effort === undefined ? undefined : declared.reasoningEfforts?.[effort] ?? effort
    return { thinking: { type: 'adaptive' }, output_config: { effort: requested ?? this.config.thinkingEffort } }
  }

  /**
   * OpenAI `reasoning` object of one search turn.
   * @returns `{ effort }` in the route's wire vocabulary, or undefined when the
   * model takes no reasoning field at all.
   */
  reasoningOf(route, model, effort) {
    const declared = route.profile.models?.find(entry => entry.id === model) ?? route.profile.modelOverrides?.[model]
    const table = declared?.reasoningEfforts
    const requested = effort ?? this.config.thinkingEffort
    const wire = table === undefined ? (requested === 'off' ? 'none' : requested) : table[requested]
    return wire === undefined || wire === 'none' ? undefined : { effort: wire }
  }

  /** Key of one provider's alpha/search health, scoped to the route and model it was tried on. */
  alphaKey(target) {
    return [target.provider, target.route.baseURL, target.model, target.effort ?? ''].join('\u0000')
  }

  /** Whether this provider recently failed alpha/search, so auto transport should skip it. */
  alphaBlocked(target) {
    return (this.alphaFailures.get(this.alphaKey(target)) ?? 0) > Date.now()
  }

  /** Remember one alpha/search failure for {@link ALPHA_RETRY_MS}. */
  blockAlpha(target) {
    this.alphaFailures.set(this.alphaKey(target), Date.now() + ALPHA_RETRY_MS)
  }

  async apiKey(route) {
    try {
      const hit = await this.ctx.credentials.resolve(route.apiKeyRef)
      const value = typeof hit?.value === 'string' ? hit.value.trim() : ''
      return value === '' ? undefined : value
    } catch {
      return undefined
    }
  }

  /** The server search tool of one Messages request. */
  tool() {
    const tool = { type: this.config.toolType, name: 'web_search', max_uses: this.config.maxUses }
    if (this.config.allowedDomains.length > 0) tool.allowed_domains = this.config.allowedDomains
    else if (this.config.blockedDomains.length > 0) tool.blocked_domains = this.config.blockedDomains
    return tool
  }

  async post(endpoint, headers, body, signal) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    const raw = await response.text()
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      data = undefined
    }
    if (!response.ok) {
      const detail = typeof data?.error?.message === 'string' ? data.error.message : clip(raw, 300)
      throw new Error(`${this.id}: HTTP ${response.status} from ${new URL(endpoint).host} for model ${body.model}: ${detail}`)
    }
    if (data === undefined) {
      throw new Error(`${this.id}: unexpected response from ${new URL(endpoint).host}`)
    }
    return data
  }

  /** Cap the seam result the way the request asked, and drop the answer when it is switched off. */
  finalize(request, collected) {
    const limit = request.maxResults
    const truncated = limit !== undefined && collected.sources.length > limit
    return {
      ...(this.config.answer && collected.content !== undefined ? { content: collected.content } : {}),
      sources: truncated ? collected.sources.slice(0, limit) : collected.sources,
      truncated,
    }
  }

  async search(request, signal) {
    const target = await this.target()
    this.ctx.logger.info(`native web search on ${target.provider}/${target.model} via ${target.route.profile.api}${this.pinnedProvider === '' ? ' (following the conversation)' : ' (pinned)'}`)

    const collected = target.route.profile.api === MESSAGES_API
      ? await this.searchMessages(target, request, signal)
      : await this.searchOpenAI(target, request, signal)
    return this.finalize(request, collected)
  }

  /**
   * One search over an Anthropic Messages route, carrying the server-side
   * `web_search` tool. A route that answers without searching is reported
   * rather than retried: the unversioned tool name is a client tool there,
   * which this provider cannot execute.
   */
  async searchMessages(target, request, signal) {
    const endpoint = messagesEndpoint(target.route.baseURL)
    const headers = {
      ...target.route.headers,
      'anthropic-version': this.config.anthropicVersion,
      'x-api-key': target.apiKey,
    }
    const prompt = buildPrompt(request.query, this.config.answer)
    const base = {
      model: target.model,
      max_tokens: this.config.maxTokens,
      tools: [this.tool()],
      ...this.thinkingFields(target.route, target.model, target.effort),
    }
    const blocks = []
    for (let round = 0; round <= MAX_PAUSE_CONTINUATIONS; round++) {
      const messages = [{ role: 'user', content: prompt }]
      if (blocks.length > 0) messages.push({ role: 'assistant', content: blocks })
      const data = await this.post(endpoint, headers, { ...base, messages }, signal)
      if (!Array.isArray(data.content)) {
        throw new Error(`${this.id}: unexpected response from ${new URL(endpoint).host}`)
      }
      blocks.push(...data.content)
      if (data.stop_reason !== 'pause_turn') break
    }

    const collected = collectResult(blocks)
    if (collected.sources.length === 0 && collected.errors.length > 0) {
      throw new Error(`${this.id}: native web search failed (${collected.errors.join(', ')})`)
    }
    // A route that accepts the tool but never runs it answers plainly; that is not a search.
    if (collected.sources.length === 0) {
      throw new Error(`${this.id}: ${target.provider}/${target.model} returned no search results; the endpoint does not run the ${this.config.toolType} server tool`)
    }
    return collected
  }

  /**
   * One search over an OpenAI Responses route. The automatic form uses
   * `alpha/search` while it works and remembers a failure for
   * {@link ALPHA_RETRY_MS}; cancellation never falls back. A reply with no
   * results counts as a failure, so an endpoint that answers without searching
   * falls back instead of returning an invented answer.
   */
  async searchOpenAI(target, request, signal) {
    if (target.transport === 'alpha-search') return this.searchAlpha(target, request, signal)
    if (target.transport === 'responses') return this.searchResponses(target, request, signal)
    if (this.alphaBlocked(target)) return this.searchResponses(target, request, signal)
    try {
      return await this.searchAlpha(target, request, signal)
    } catch (error) {
      if (signal?.aborted === true) throw error
      this.blockAlpha(target)
      this.ctx.logger.info(`${this.id}: alpha/search did not answer for ${target.provider}/${target.model}; using Responses for the next ${ALPHA_RETRY_MS / 60000} minutes`)
      return this.searchResponses(target, request, signal)
    }
  }

  /** One `alpha/search` call: its `results` are the sources and `output` is the searched text. */
  async searchAlpha(target, request, signal) {
    const body = alphaBody({
      model: target.model,
      query: request.query,
      reasoning: this.reasoningOf(target.route, target.model, target.effort),
      domains: this.config.allowedDomains,
    })
    const data = await this.post(alphaEndpoint(target.route.baseURL), {
      ...target.route.headers,
      authorization: `Bearer ${target.apiKey}`,
    }, body, signal)
    const collected = collectAlpha(data)
    // Text without sources is an answer the endpoint wrote without searching; that is not a search.
    if (collected.sources.length === 0) {
      throw new Error(`${this.id}: alpha/search returned no results for ${target.model}`)
    }
    return collected
  }

  /** One Responses call with the server-side search tool. */
  async searchResponses(target, request, signal) {
    const endpoint = responsesEndpoint(target.route.baseURL)
    const body = responsesBody({
      model: target.model,
      input: buildPrompt(request.query, this.config.answer),
      reasoning: this.reasoningOf(target.route, target.model, target.effort),
      maxTokens: this.config.maxTokens,
    })
    const data = await this.post(endpoint, {
      ...target.route.headers,
      authorization: `Bearer ${target.apiKey}`,
    }, body, signal)
    const collected = collectResponses(data)
    // The same rule as alpha: an answer with no search behind it is not a search result.
    if (collected.sources.length === 0) {
      throw new Error(`${this.id}: Responses returned no results for ${target.model}`)
    }
    return collected
  }
}

/** Register the native search provider with `ctx.web`. */
export function apply(ctx, config) {
  if (config.allowedDomains.length > 0 && config.blockedDomains.length > 0) {
    throw new Error('web-search-native: allowedDomains and blockedDomains cannot both be set')
  }
  ctx.web.registerSearchProvider(new NativeSearchProvider(ctx, config))
}
