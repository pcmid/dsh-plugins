/**
 * Native web search provider for the DeepSeek Harness `ctx.web` seam.
 *
 * Each `ctx.web.search()` call becomes one Anthropic Messages request that
 * carries the API's server-side `web_search` tool. The request uses the small
 * model from the optional `smallModel` service when its route can run the
 * search, and otherwise the model the initiating Agent currently has selected.
 * The chosen model's route supplies the endpoint, credential, and headers, so no
 * model or endpoint is configured here. Without a usable small model, a route
 * that is not an `anthropic-messages` route answers not ready, which withdraws
 * the built-in `web_search` tool for model steps on that route.
 *
 * @module @pcmid/dsh-web-search-native
 */

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

/** Continuations allowed when the API pauses a long server-tool turn (`stop_reason: pause_turn`). */
const MAX_PAUSE_CONTINUATIONS = 3

/** Character cap for one source snippet assembled from cited passages. */
const SNIPPET_MAX_CHARS = 600

export const Config = z.object({
  providerId: z.string().default('native-search')
    .description('Search provider id. Pin it as web.searchProvider when several search providers are registered.'),
  toolType: z.string().default('web_search_20250305')
    .description('Server tool type sent to the API.'),
  maxUses: z.natural().min(1).default(3)
    .description('Maximum native searches the model may run for one query.'),
  maxTokens: z.natural().min(256).default(4096)
    .description('max_tokens of each Messages request; thinking output counts toward it.'),
  thinkingEffort: z.string().default('low')
    .description('output_config.effort for models the route marks compat.forceAdaptiveThinking, unless the small model names its own effort. Other models run with thinking disabled.'),
  answer: z.boolean().default(true)
    .description('Ask the model for a short cited answer in addition to the sources.'),
  allowedDomains: z.array(z.string()).default([])
    .description('Only search these domains (allowed_domains). Cannot be combined with blockedDomains.'),
  blockedDomains: z.array(z.string()).default([])
    .description('Never search these domains (blocked_domains).'),
  anthropicVersion: z.string().default(DEFAULT_ANTHROPIC_VERSION)
    .description('anthropic-version request header.'),
})

/** Messages endpoint for an API root, accepting roots with or without a trailing `/v1`. */
export function messagesEndpoint(baseURL) {
  const root = baseURL.replace(/\/+$/, '')
  return /\/v1$/.test(root) ? `${root}/messages` : `${root}/v1/messages`
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

/** Single-line, length-capped text. */
function clip(text, max) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
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
          title: typeof item.title === 'string' && item.title.trim() !== '' ? item.title.trim() : undefined,
          publishedAt: typeof item.page_age === 'string' && item.page_age.trim() !== '' ? item.page_age.trim() : undefined,
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
      const entry = citations.get(citation.url) ?? { title: citation.title, passages: [] }
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
      title: result?.title ?? (typeof cited.title === 'string' && cited.title.trim() !== '' ? cited.title.trim() : undefined),
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

/** Search provider that runs native web search on the initiating Agent's current model. */
export class NativeSearchProvider {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.id = config.providerId
    this.title = '接口原生搜索'
    this.description = {
      en: 'Runs the model API\'s built-in web search on the small model, or on the conversation\'s model when no '
        + 'small model is usable. Each query is one model request billed at that model\'s rate, including search '
        + 'fees and result tokens. Currently supports routes configured with api: anthropic-messages.',
      zh: '调用模型接口自带的网页搜索，优先使用小模型，小模型不可用时使用当前对话的模型。'
        + '每个查询是一次按该模型计费的请求，含搜索费用和结果 token。目前支持配置了 api: anthropic-messages 的路由。',
    }
  }

  /** Whether a search can run is decided per route by `ready()`, so the provider is always selectable. */
  available() {
    return true
  }

  /** Offer web_search while the small model or the step's Messages route can run it. Never touches the network. */
  async ready(llmProvider) {
    if ((await this.smallTarget()) !== undefined) return true
    const provider = llmProvider ?? this.currentSelection()?.provider
    if (provider === undefined) return false
    const route = this.routeOf(provider)
    return route !== undefined && (await this.apiKey(route)) !== undefined
  }

  /** Model selection of the Agent whose tool call is running, when one is. */
  currentSelection() {
    return this.ctx.agents.currentInitiator()?.model.current()
  }

  /**
   * The small model as a search target.
   * @returns its selection, route, key, and chosen effort, or undefined when none
   * is set, its route cannot run native search, the route no longer lists the
   * model, or its key does not resolve. Callers then use the current model.
   */
  async smallTarget() {
    const selection = this.ctx.get('smallModel')?.currentSelection()
    if (selection === undefined) return undefined
    const route = this.routeOf(selection.provider)
    if (route === undefined) return undefined
    const listed = route.profile.models
    if (listed?.length > 0 && !listed.some(entry => entry.id === selection.model)) return undefined
    const apiKey = await this.apiKey(route)
    return apiKey === undefined ? undefined : { selection, route, apiKey, effort: selection.reasoningEffort }
  }

  /**
   * The current conversation's model as a search target. Its reasoning effort is
   * not carried over: that choice is for the conversation, not for a search turn.
   * @returns its selection, route, and key.
   * @throws when no conversation initiated this search or its route cannot run it.
   */
  async currentTarget() {
    const selection = this.currentSelection()
    if (selection === undefined) {
      throw new Error(`${this.id}: web search runs on the current conversation's model, and no conversation initiated this search`)
    }
    const route = this.routeOf(selection.provider)
    if (route === undefined) {
      throw new Error(`${this.id}: route "${selection.provider}" cannot run native web search; it needs api: ${MESSAGES_API}, a baseURL, and an apiKeyEnv`)
    }
    const apiKey = await this.apiKey(route)
    if (apiKey === undefined) {
      throw new Error(`${this.id}: credential ${route.apiKeyRef} of route "${selection.provider}" is not set`)
    }
    return { selection, route, apiKey, effort: undefined }
  }

  /**
   * Connection facts of one route, read from its `llm-pi-ai` profile on every
   * call so a route edit applies to the next search.
   * @returns the endpoint, key reference, and headers, or undefined when the
   * route is not an `anthropic-messages` route naming both a `baseURL` and an
   * `apiKeyEnv`. Catalog routes and other adapters' routes declare neither.
   */
  routeOf(provider) {
    const row = this.ctx.llm.listConfigurableProviders().find(entry => entry.provider === provider)
    if (row === undefined) return undefined
    const owner = [...this.ctx.loader.entries()]
      .find(entry => entry.options.id === row.settingsNs && entry.options.name === ROUTE_OWNER_PACKAGE)
    const profile = owner?.fiber?.effectiveConfig?.providers?.get()?.[provider]
    if (profile?.api !== MESSAGES_API || !profile.baseURL || !profile.apiKeyEnv) return undefined
    return { baseURL: profile.baseURL, apiKeyRef: profile.apiKeyEnv, headers: profile.headers ?? {}, profile }
  }

  /**
   * Thinking fields for one search turn, keeping it as light as the model
   * allows. Models the route marks `compat.forceAdaptiveThinking` reject
   * `thinking: { type: disabled }`, so they get adaptive thinking at the
   * requested effort, translated through the route's effort table, or else at
   * the configured effort.
   */
  thinkingFields(route, model, effort) {
    const declared = route.profile.models?.find(entry => entry.id === model) ?? route.profile.modelOverrides?.[model]
    if (declared?.compat?.forceAdaptiveThinking !== true) return { thinking: { type: 'disabled' } }
    const requested = effort === undefined ? undefined : declared.reasoningEfforts?.[effort] ?? effort
    return { thinking: { type: 'adaptive' }, output_config: { effort: requested ?? this.config.thinkingEffort } }
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

  tool() {
    const tool = { type: this.config.toolType, name: 'web_search', max_uses: this.config.maxUses }
    if (this.config.allowedDomains.length > 0) tool.allowed_domains = this.config.allowedDomains
    else if (this.config.blockedDomains.length > 0) tool.blocked_domains = this.config.blockedDomains
    return tool
  }

  async post(endpoint, route, apiKey, body, signal) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...route.headers,
        'content-type': 'application/json',
        'anthropic-version': this.config.anthropicVersion,
        'x-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal,
    })
    const text = await response.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      data = undefined
    }
    if (!response.ok) {
      const detail = typeof data?.error?.message === 'string' ? data.error.message : clip(text, 300)
      throw new Error(`${this.id}: HTTP ${response.status} from ${new URL(endpoint).host} for model ${body.model}: ${detail}`)
    }
    if (!data || !Array.isArray(data.content)) {
      throw new Error(`${this.id}: unexpected response from ${new URL(endpoint).host}`)
    }
    return data
  }

  async search(request, signal) {
    const { selection, route, apiKey, effort } = (await this.smallTarget()) ?? (await this.currentTarget())
    this.ctx.logger.info(`native web search on ${selection.provider}/${selection.model}`)

    const endpoint = messagesEndpoint(route.baseURL)
    const prompt = buildPrompt(request.query, this.config.answer)
    const base = {
      model: selection.model,
      max_tokens: this.config.maxTokens,
      tools: [this.tool()],
      ...this.thinkingFields(route, selection.model, effort),
    }
    const blocks = []
    for (let round = 0; round <= MAX_PAUSE_CONTINUATIONS; round++) {
      const messages = [{ role: 'user', content: prompt }]
      if (blocks.length > 0) messages.push({ role: 'assistant', content: blocks })
      const data = await this.post(endpoint, route, apiKey, { ...base, messages }, signal)
      blocks.push(...data.content)
      if (data.stop_reason !== 'pause_turn') break
    }

    const collected = collectResult(blocks)
    if (collected.sources.length === 0 && collected.errors.length > 0) {
      throw new Error(`${this.id}: native web search failed (${collected.errors.join(', ')})`)
    }
    const limit = request.maxResults
    const truncated = limit !== undefined && collected.sources.length > limit
    return {
      ...(this.config.answer && collected.content !== undefined ? { content: collected.content } : {}),
      sources: truncated ? collected.sources.slice(0, limit) : collected.sources,
      truncated,
    }
  }
}

/** Register the native Messages search provider with `ctx.web`. */
export function apply(ctx, config) {
  if (config.allowedDomains.length > 0 && config.blockedDomains.length > 0) {
    throw new Error('web-search-native: allowedDomains and blockedDomains cannot both be set')
  }
  ctx.web.registerSearchProvider(new NativeSearchProvider(ctx, config))
}
