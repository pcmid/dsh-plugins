/**
 * AI retry advisor for failed model requests.
 *
 * Listens on the `agent/request-error` waterfall as a last resort: it first
 * delegates to every other recovery listener (automatic retry for transient
 * codes, context compaction, image offload). Only when all of them leave the
 * failure terminal does it ask a model to analyze the failure and choose a
 * recovery plan: retry after a delay, or give up. If that analysis itself
 * fails (request error, timeout, unparsable answer), the failure stays
 * terminal and the turn ends as before.
 *
 * A retry re-sends the identical request; nothing about the request changes.
 * The one exception is the optional "drop invalid thinking" setting: when the
 * provider rejects thinking in the history as invalid (for example blocks
 * bound to a different conversation after a fork), the request is resent at
 * once in the way that API drops such thinking, and the conversation keeps
 * dropping it for its later requests.
 * Decisions are written to the Host log, appended to the conversation's Session
 * log as `plugin:retry-advisor/decision` records that the Chat view shows, and,
 * unless disabled, appended to a JSONL decision log.
 *
 * @module @pcmid/dsh-retry-advisor
 */

import z from '@deepseek-ai/schemastery'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'retry-advisor'

/** The model-call service used for the analysis request. */
export const inject = ['llm']

/** Request purpose attached to the analysis call. */
export const PURPOSE = 'retry-advisor'

/**
 * Session record type of one shown decision. Every record of one failure
 * carries the same `id` and the complete current state; the latest wins.
 */
export const RECORD = 'plugin:retry-advisor/decision'

/** Failure-message characters kept in a shown decision record. */
const RECORD_FAILURE_CHARS = 1000

export const Config = z.object({
  provider: z.string()
    .description('Provider route for the analysis request. Set together with model; when both are empty, the analysis runs on the failed conversation\'s current model.'),
  model: z.string()
    .description('Model id for the analysis request. Set together with provider.'),
  reasoningEffort: z.string()
    .description('Reasoning effort of the analysis request. Empty runs the analysis without thinking: the off effort when the model offers one, otherwise no effort, which leaves only a route\'s configured default effort in place. An effort the analysis model does not offer is ignored the same way.'),
  maxTokens: z.natural().min(256)
    .description('Output-token cap of the analysis request; thinking output counts toward it. Empty uses the analysis model\'s default, as conversation requests do.'),
  timeoutMs: z.natural().min(1000).max(600000).default(180000)
    .description('Deadline of one analysis request. A timed-out analysis counts as a failed analysis, so the request is not retried.'),
  maxRetriesPerStep: z.natural().default(3)
    .description('Maximum retries this plugin grants within one step. After that the failure stays terminal without analysis.'),
  maxDelayMs: z.natural().max(600000).default(30000)
    .description('Upper bound for the wait the analysis may choose before a retry.'),
  allowGiveUp: z.boolean().default(true)
    .description('Let the analysis decide not to retry deterministic failures such as authentication or invalid requests. When false, the analysis only chooses the delay.'),
  skipCodes: z.array(z.string()).default(['ABORTED'])
    .description('Failure codes left terminal without analysis.'),
  maxFailureChars: z.natural().min(200).default(4000)
    .description('Maximum characters of the failure message sent to the analysis model; longer messages keep their head and tail.'),
  reasonLanguage: z.string().default('Simplified Chinese')
    .description('Language of the cause and reason the analysis writes into the logs.'),
  decisionLog: z.string().default(join(homedir(), '.dsh', 'retry-advisor', 'decisions.jsonl'))
    .description('JSONL file that receives one line per decision. Empty disables the file.'),
  dropInvalidThinking: z.boolean().default(false).volatile()
    .description('Drop invalid thinking. When the provider rejects thinking in the conversation history as invalid, resend at once in the way that API drops such thinking, and keep dropping it for the rest of the conversation. The dropped thinking leaves the model\'s context. Supported APIs: Anthropic Messages (thinking blocks bound to a different conversation, as after a fork; dropped through thinking.block_binding.prefix_mismatch_behavior = drop_block).'),
})

/** `fix` value of a retry that switched the conversation to dropping invalid thinking. */
export const DROP_THINKING_FIX = 'drop-invalid-thinking'

/**
 * `fix` value of a retry that resends one conversation request as an ordinary
 * request, without the drop, after a request that carried the drop failed.
 */
export const DROP_THINKING_FALLBACK = 'drop-thinking-fallback'

/**
 * Header that marks a request of a conversation that drops invalid thinking.
 * The fetch wrapper removes it, so it never leaves the process.
 */
export const DROP_THINKING_HEADER = 'x-dsh-retry-advisor-drop-thinking'

/** Anthropic beta that accepts `thinking.block_binding`; pi-ai pairs the two the same way. */
export const ANTHROPIC_THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01'

/**
 * Anthropic Messages: add `block_binding.prefix_mismatch_behavior: "drop_block"`
 * to the request's `thinking` object, so the provider drops thinking blocks
 * bound to a different conversation instead of rejecting the request.
 * Disabled or absent thinking is left alone because the API rejects
 * `block_binding` there.
 * @param body - parsed JSON request body; changed in place.
 * @returns whether the body changed.
 */
function dropAnthropicThinking(body) {
  const thinking = body.thinking
  if (thinking === null || typeof thinking !== 'object' || Array.isArray(thinking) || thinking.type === 'disabled') return false
  const binding = thinking.block_binding !== null && typeof thinking.block_binding === 'object' && !Array.isArray(thinking.block_binding)
    ? thinking.block_binding
    : {}
  if (binding.prefix_mismatch_behavior === 'drop_block') return false
  body.thinking = { ...thinking, block_binding: { ...binding, prefix_mismatch_behavior: 'drop_block' } }
  return true
}

/**
 * Each provider API rejects invalid thinking and drops it in its own way.
 * `matches` recognizes the API's rejection of invalid thinking; `dropFailed`
 * recognizes a failure of a request that carried the drop and still failed
 * because of it (the drop rejected, or the thinking still rejected); `drop`
 * changes a parsed request body of that API and leaves bodies of other APIs
 * unchanged; `betas` are the `anthropic-beta` features a changed request needs.
 */
export const THINKING_DROPPERS = Object.freeze([
  Object.freeze({
    api: 'anthropic-messages',
    matches: (message) => /prefix_mismatch_behavior/.test(message)
      || /thinking[\s\S]{0,40}bound to a different conversation/i.test(message),
    dropFailed: (message) => /block_binding|thinking-binding-controls/.test(message),
    drop: dropAnthropicThinking,
    betas: Object.freeze([ANTHROPIC_THINKING_BINDING_BETA]),
  }),
])

/**
 * The API whose invalid-thinking rejection a failure is.
 * @param failure - the failed request's failure.
 * @returns the matching dropper, or undefined for any other failure.
 */
export function invalidThinkingDropper(failure) {
  const message = String(failure?.message ?? '')
  return THINKING_DROPPERS.find(dropper => dropper.matches(message))
}

/**
 * The API whose drop a failure of a request that carried the drop concerns.
 * @param failure - the failed request's failure.
 * @returns the matching dropper, or undefined when the failure has nothing to do with the drop.
 */
export function failedDropper(failure) {
  const message = String(failure?.message ?? '')
  return THINKING_DROPPERS.find(dropper => dropper.dropFailed(message))
}

/**
 * Rewrite a JSON request body so the provider drops invalid thinking.
 * @param text - JSON request body text.
 * @returns the rewritten body and the `anthropic-beta` features it needs, or undefined when nothing changes.
 */
export function dropInvalidThinking(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  const betas = []
  let changed = false
  for (const dropper of THINKING_DROPPERS) {
    if (!dropper.drop(body)) continue
    changed = true
    betas.push(...dropper.betas)
  }
  return changed ? { body: JSON.stringify(body), betas } : undefined
}

/** Append `anthropic-beta` features to a header set, keeping the ones already there. */
function addBetas(headers, betas) {
  if (betas.length === 0) return
  const current = (headers.get('anthropic-beta') ?? '').split(',').map(value => value.trim()).filter(Boolean)
  headers.set('anthropic-beta', [...new Set([...current, ...betas])].join(','))
}

/** Whether fetch init headers carry the drop-thinking marker, without copying them. */
function hasDropMarker(headers) {
  if (headers === undefined || headers === null) return false
  if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.has(DROP_THINKING_HEADER)
  if (Array.isArray(headers)) return headers.some(entry => String(entry?.[0]).toLowerCase() === DROP_THINKING_HEADER)
  if (typeof headers === 'object') return Object.keys(headers).some(name => name.toLowerCase() === DROP_THINKING_HEADER)
  return false
}

/**
 * Wrap a fetch function: a request carrying {@link DROP_THINKING_HEADER}
 * loses that header, its JSON body is rewritten by {@link dropInvalidThinking},
 * and the betas the rewrite needs join its `anthropic-beta` header. Every
 * other request passes through with its original arguments.
 * @param base - the fetch to delegate to.
 * @returns the wrapping fetch.
 */
export function createDropThinkingFetch(base) {
  return async function dropThinkingFetch(...args) {
    const [input, init] = args
    if (hasDropMarker(init?.headers)) {
      const headers = new Headers(init.headers)
      headers.delete(DROP_THINKING_HEADER)
      const dropped = typeof init.body === 'string' ? dropInvalidThinking(init.body) : undefined
      if (dropped === undefined) return base(input, { ...init, headers })
      headers.delete('content-length')
      addBetas(headers, dropped.betas)
      return base(input, { ...init, headers, body: dropped.body })
    }
    if (typeof Request !== 'undefined' && input instanceof Request && init?.headers === undefined
      && input.headers.has(DROP_THINKING_HEADER)) {
      const headers = new Headers(input.headers)
      headers.delete(DROP_THINKING_HEADER)
      if (input.method === 'GET' || input.method === 'HEAD' || input.body === null) {
        return base(new Request(input, { headers }), init)
      }
      const text = await input.text()
      const dropped = dropInvalidThinking(text)
      if (dropped !== undefined) {
        headers.delete('content-length')
        addBetas(headers, dropped.betas)
      }
      return base(new Request(input, { headers, body: dropped?.body ?? text }), init)
    }
    return base(...args)
  }
}

/**
 * Replace `target.fetch` with {@link createDropThinkingFetch}.
 * @param target - object owning `fetch`; the global object by default.
 * @returns a function that removes the wrapper again. When another wrapper was
 *   installed on top meanwhile, ours stays in the chain as a pass-through.
 */
export function installDropThinkingFetch(target = globalThis) {
  const base = target.fetch
  if (typeof base !== 'function') return () => {}
  const wrapped = createDropThinkingFetch(base)
  let active = true
  const patched = function fetch(...args) {
    return active ? wrapped(...args) : base(...args)
  }
  target.fetch = patched
  return () => {
    active = false
    if (target.fetch === patched) target.fetch = base
  }
}

/**
 * Conversations that drop invalid thinking, and which of their requests carry
 * the drop. The fetch wrapper is installed only once the first conversation
 * is added.
 *
 * Every request of a switched conversation carries the drop, except this
 * plugin's own analysis requests, and except the one conversation request
 * after a fallback. A conversation request is one without a `purpose`.
 * @param target - object owning `fetch`; the global object by default.
 */
export function createThinkingDrop(target = globalThis) {
  const sessions = new Set()
  /** Sessions whose next conversation request goes without the drop. */
  const fallback = new Set()
  /** Whether each session's latest conversation request carried the drop. */
  const carried = new Map()
  let uninstall
  return {
    has: sessionId => sessions.has(String(sessionId)),
    enable(sessionId) {
      sessions.add(String(sessionId))
      uninstall ??= installDropThinkingFetch(target)
    },
    /** Send the session's next conversation request without the drop. */
    fallBack(sessionId) {
      fallback.add(String(sessionId))
    },
    /** Whether the session's latest conversation request carried the drop. */
    carried: sessionId => carried.get(String(sessionId)) === true,
    /**
     * Decide whether one request carries the drop, and remember the decision
     * for conversation requests.
     * @param request - the request's `sessionId` and `purpose`.
     * @param enabled - the current setting.
     */
    mark({ sessionId, purpose } = {}, enabled = true) {
      if (sessionId === undefined || purpose === PURPOSE) return false
      const id = String(sessionId)
      const conversation = purpose === undefined
      let drop = enabled && sessions.has(id)
      if (conversation && fallback.delete(id)) drop = false
      if (conversation) carried.set(id, drop)
      return drop
    },
    dispose() {
      sessions.clear()
      fallback.clear()
      carried.clear()
      uninstall?.()
      uninstall = undefined
    },
  }
}

/**
 * Read a boolean Config field that may be volatile.
 * @param value - a boolean, or a volatile reference exposing `get()`.
 */
export function flag(value) {
  return typeof value?.get === 'function' ? value.get() === true : value === true
}

/**
 * Build the `llm-pi-ai/request-headers` listener that marks the requests of
 * conversations that drop invalid thinking, while the setting is on; see
 * {@link createThinkingDrop} for which requests.
 * @param thinkingDrop - the conversations to mark.
 * @param enabled - reads the current setting.
 * @returns the waterfall listener.
 */
export function createHeaderListener(thinkingDrop, enabled = () => true) {
  return function onRequestHeaders(request, headers, next) {
    if (thinkingDrop.mark(request ?? {}, enabled())) headers.set(DROP_THINKING_HEADER, 'drop')
    return next()
  }
}

/** Whether the configured reason language is Chinese. */
function chinese(language) {
  return /chinese|中文|^zh/i.test(language)
}

/**
 * Cause and reason shown when invalid thinking is dropped.
 * @param language - configured reason language; Chinese gets Chinese text, anything else English.
 */
function dropThinkingText(language) {
  return chinese(language)
    ? {
      cause: '服务端认为请求里的历史思考无效（例如分叉会话带来的、绑定在另一段对话上的思考块），拒绝了请求。',
      reason: '按「丢弃无效思考」设置立即重发，让服务端丢弃这些思考；本会话之后的请求都这样处理，被丢弃的思考不再进入上下文。',
    }
    : {
      cause: 'The provider rejected thinking in the conversation history as invalid (for example thinking blocks bound to a different conversation after a fork).',
      reason: 'Resending now under the drop-invalid-thinking setting so the provider drops that thinking; later requests of this conversation do the same, and the dropped thinking leaves the context.',
    }
}

/**
 * Cause and reason shown when a request that carried the drop failed and is
 * resent once as an ordinary request.
 * @param language - configured reason language; Chinese gets Chinese text, anything else English.
 */
function fallbackText(language) {
  return chinese(language)
    ? {
      cause: '带着丢弃无效思考的参数，请求仍然失败。',
      reason: '回退为普通请求立即重发一次，不带这个参数；之后的请求照常带上。',
    }
    : {
      cause: 'The request still failed while carrying the drop-invalid-thinking parameter.',
      reason: 'Resending once now as an ordinary request without that parameter; later requests carry it again.',
    }
}
/**
 * System prompt of the analysis request.
 * @param config - resolved plugin config.
 * @returns the complete system prompt.
 */
export function buildSystemPrompt(config) {
  const lines = [
    'You decide how a coding agent recovers from one failed model request.',
    '',
    'The agent sent a request to its model provider and the request failed. Every built-in recovery handler (automatic retry for known transient error codes, context compaction, image offload) has already declined or given up.',
    'If you choose to retry, the harness re-sends exactly the same request: same conversation, same tools, same model. Nothing in the request can be changed, so a retry helps only when the outcome can differ between attempts: the failure came from something transient or random in the provider, gateway, network, or response stream, or from a provider check that judges the newly sampled output.',
    '',
    'Failures that usually succeed on retry:',
    '- gateway, proxy, network, or server errors; overload; rate limits (wait longer, and honor any retry-after hint)',
    '- truncated, duplicated, garbled, or empty response streams, including tool-call arguments that are not valid JSON because the stream was cut off or replayed',
    '- a provider safety, usage-policy, or terms-of-service block, such as "This request was blocked as it seems to violate ... Terms of Service", "Output blocked by content filtering policy", or a refusal stop reason. These come from automated classifiers that also judge the output the model is generating, so on ordinary software work they are often false positives and a resend that samples new output passes. Retry once after a short delay of a few seconds. Do not retry when the same block already appears among the earlier failures listed for this step.',
    '- unclassified errors whose text points to a temporary condition',
  ]
  if (config.allowGiveUp) {
    lines.push(
      '',
      'Failures where re-sending the identical request fails the same way, so do not retry:',
      '- authentication, permission, missing or invalid credential, quota or billing exhaustion',
      '- the request itself rejected as invalid (bad parameter, unsupported field, payload too large, unknown model); a safety or policy block is not an invalid request',
      '- context window exceeded',
      '- the same deterministic error already repeated in earlier attempts listed for this step',
    )
  } else {
    lines.push('', 'You must retry. Choose only how long to wait first.')
  }
  lines.push(
    '',
    'Reply with exactly one line of JSON and nothing else:',
    `{"retry": true or false, "delayMs": integer milliseconds to wait before retrying (0 to ${config.maxDelayMs}), "cause": "likely cause", "reason": "why this decision"}`,
    `Write cause and reason in ${config.reasonLanguage}, one short sentence each.`,
  )
  return lines.join('\n')
}

/**
 * Shorten text by keeping its head and tail.
 * @param text - text to shorten.
 * @param max - maximum characters kept.
 * @returns text of at most about `max` characters.
 */
export function clip(text, max) {
  if (text.length <= max) return text
  const half = Math.floor((max - 20) / 2)
  return `${text.slice(0, half)}\n…[${text.length - 2 * half} chars omitted]…\n${text.slice(-half)}`
}

/**
 * User message of the analysis request.
 * @returns JSON text describing the failure and earlier attempts in this step.
 */
export function buildAnalysisInput({ provider, selection, turn, step, failure, attempts, config }) {
  const describe = {
    failedRequest: {
      provider,
      model: selection?.provider === provider ? selection.model : undefined,
      turn,
      step,
    },
    failure: {
      code: failure.code,
      message: clip(String(failure.message ?? ''), config.maxFailureChars),
      ...failure.status === undefined ? {} : { httpStatus: failure.status },
      ...failure.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: failure.providerRetryAfterMs },
      ...failure.requestId === undefined ? {} : { requestId: failure.requestId },
    },
    retriesGrantedInThisStep: attempts.filter(entry => entry.retry === true).length,
    retryBudgetLeft: config.maxRetriesPerStep - attempts.filter(entry => entry.retry === true).length,
    earlierFailuresInThisStep: attempts.map(entry => ({
      code: entry.code,
      message: clip(entry.message, 400),
      decision: entry.fix === DROP_THINKING_FIX
        ? `retried with invalid thinking dropped (${entry.api})`
        : entry.fix === DROP_THINKING_FALLBACK
          ? 'retried once as an ordinary request without the invalid-thinking drop'
        : entry.retry ? `retried after ${entry.delayMs}ms` : 'not retried',
    })),
  }
  return JSON.stringify(describe, null, 2)
}

/**
 * Parse the analysis answer.
 * @param text - model output text.
 * @param config - resolved plugin config.
 * @returns a validated decision.
 * @throws when the answer holds no valid decision object.
 */
export function parseDecision(text, config) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`analysis answer has no JSON object: ${clip(text, 300)}`)
  let value
  try {
    value = JSON.parse(text.slice(start, end + 1))
  } catch (error) {
    throw new Error(`analysis answer is not valid JSON: ${clip(text, 300)}`, { cause: error })
  }
  if (value === null || typeof value !== 'object' || typeof value.retry !== 'boolean') {
    throw new Error(`analysis answer lacks a boolean "retry": ${clip(text, 300)}`)
  }
  const rawDelay = Number(value.delayMs ?? 0)
  if (!Number.isFinite(rawDelay)) throw new Error(`analysis answer has an invalid "delayMs": ${clip(text, 300)}`)
  return {
    retry: config.allowGiveUp ? value.retry : true,
    delayMs: Math.min(Math.max(Math.round(rawDelay), 0), config.maxDelayMs),
    cause: typeof value.cause === 'string' ? value.cause : '',
    reason: typeof value.reason === 'string' ? value.reason : '',
  }
}

/**
 * Wait unless cancelled.
 * @returns whether the full delay elapsed.
 */
function sleep(ms, signal) {
  if (signal.aborted) return Promise.resolve(false)
  if (ms <= 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** One-line error description for logs. */
function describeError(error) {
  if (error instanceof Error) return error.code ? `${error.code}: ${error.message}` : error.message
  return String(error)
}

/**
 * Choose the analysis route: the configured provider and model, otherwise the
 * conversation's current model.
 * @param config - resolved plugin config.
 * @param selection - the conversation's current model selection, when known.
 * @returns the route, or undefined when neither is available.
 */
export function analysisRoute(config, selection) {
  if (config.provider && config.model) return { provider: config.provider, model: config.model }
  return selection === undefined ? undefined : { provider: selection.provider, model: selection.model }
}

/**
 * Choose the analysis request's reasoning effort. The analysis runs without
 * thinking: the `off` effort when the model offers one, otherwise no effort,
 * which a route without a default effort sends as no thinking at all. A
 * configured `reasoningEffort` the model offers overrides that.
 * @param controls - the proposed call controls.
 * @param model - the resolved model's reasoning efforts.
 * @param configured - the configured effort, when any.
 * @returns the controls with the chosen effort, or without one.
 */
export function analysisControls(controls, model, configured) {
  const { reasoningEffort: _proposed, ...rest } = controls
  const efforts = model?.reasoning?.efforts ?? []
  const offered = id => efforts.some(effort => effort.id === id)
  if (configured && offered(configured)) return { ...rest, reasoningEffort: configured }
  if (offered('off')) return { ...rest, reasoningEffort: 'off' }
  return rest
}

/**
 * Run one analysis request, without thinking unless `reasoningEffort` is
 * configured (see {@link analysisControls}), and with the model's default
 * output cap unless `maxTokens` is configured.
 * @returns the parsed decision and the route and effort that produced it.
 * @throws when the route cannot be resolved, the request fails or times out, or the answer is unusable.
 */
export async function analyze(ctx, config, { agent, provider, turn, step, failure, attempts, signal }) {
  const selection = agent.model.current()
  const route = analysisRoute(config, selection)
  if (route === undefined) throw new Error('no analysis model: configure provider and model, or select a conversation model')

  const callSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)])
  const call = await ctx.llm.prepareCall({
    ...route,
    ...config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens },
  }, callSignal, (controls, model) => analysisControls(controls, model, config.reasoningEffort))
  const input = buildAnalysisInput({ provider, selection, turn, step, failure, attempts, config })
  const options = {
    ...call.config,
    system: buildSystemPrompt(config),
    messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
    sessionId: agent.session.id,
    purpose: PURPOSE,
    signal: callSignal,
  }
  let text = ''
  let finish
  for await (const chunk of call.stream(options)) {
    if (chunk.type === 'block-end' && chunk.block.type === 'text') text += chunk.block.text
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  callSignal.throwIfAborted()
  if (finish === undefined) throw new Error('analysis stream ended without a finish')
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    const error = new Error(`analysis request failed: ${finish.failure?.message ?? finish.kind}`)
    error.code = finish.failure?.code
    throw error
  }
  const usedEffort = call.config?.reasoningEffort
  return {
    decision: parseDecision(text, config),
    route: usedEffort === undefined ? route : { ...route, reasoningEffort: usedEffort },
  }
}

/**
 * Build the `agent/request-error` listener.
 * @param ctx - plugin context exposing `llm` and `logger`.
 * @param config - resolved plugin config.
 * @param deps - replaceable analysis, logging, Session-record, wait, and thinking-binding dependencies.
 * @returns the waterfall listener.
 */
export function createListener(ctx, config, deps = {}) {
  const runAnalysis = deps.analyze ?? ((payload) => analyze(ctx, config, payload))
  const writeLog = deps.writeLog ?? (config.decisionLog
    ? async (record) => {
      await mkdir(dirname(config.decisionLog), { recursive: true })
      await appendFile(config.decisionLog, `${JSON.stringify(record)}\n`)
    }
    : async () => {})
  const appendRecord = deps.appendRecord ?? ((session, data) => appendPluginRecord(session, RECORD, data))
  const wait = deps.sleep ?? sleep
  const thinkingDrop = deps.thinkingDrop
  /** Failures seen in the current step, keyed by Session. */
  const steps = new WeakMap()

  function record(entry) {
    writeLog({ time: new Date().toISOString(), ...entry }).catch((error) => {
      ctx.logger.warn(`retry-advisor: could not write the decision log: ${describeError(error)}`)
    })
  }

  /** Append one complete decision state to the conversation; a failed append is only logged. */
  function show(session, data) {
    try {
      appendRecord(session, data)
    } catch (error) {
      ctx.logger.warn(`retry-advisor: could not show the decision in the conversation: ${describeError(error)}`)
    }
  }

  return async function onRequestError(payload, next) {
    const { agent, turn, step, provider, failure, signal } = payload
    const downstream = await next()
    if (downstream?.kind === 'retry' || signal.aborted) return downstream
    if (config.skipCodes.includes(failure.code)) return downstream

    let state = steps.get(agent.session)
    if (state === undefined || state.turn !== turn || state.step !== step) {
      state = { turn, step, attempts: [] }
      steps.set(agent.session, state)
    }
    const base = { sessionId: agent.session.id, turn, step, provider, code: failure.code }
    const granted = state.attempts.filter(entry => entry.retry === true).length
    const shown = {
      id: randomUUID(),
      turn,
      step,
      provider,
      code: failure.code,
      failure: clip(String(failure.message ?? ''), RECORD_FAILURE_CHARS),
      granted,
      maxRetries: config.maxRetriesPerStep,
    }
    if (granted >= config.maxRetriesPerStep) {
      ctx.logger.info(`retry-advisor: ${failure.code} in turn ${turn} step ${step} stays terminal; ${granted} retries already granted`)
      record({ ...base, outcome: 'budget-exhausted', granted })
      show(agent.session, { ...shown, outcome: 'budget-exhausted' })
      return downstream
    }

    // Invalid thinking in the history fails every identical resend; with the
    // drop-invalid-thinking setting on, the conversation switches to dropping
    // it without asking a model. When a conversation request that carried the
    // drop still fails because of it, the next attempt goes once as an
    // ordinary request without the drop. Any further failure goes to the
    // ordinary analysis.
    const dropping = thinkingDrop !== undefined && flag(config.dropInvalidThinking)
    const sessionId = agent.session.id
    const failed = dropping && thinkingDrop.has(sessionId) && thinkingDrop.carried(sessionId)
      ? failedDropper(failure)
      : undefined
    if (failed !== undefined) {
      thinkingDrop.fallBack(sessionId)
      const fix = { retry: true, delayMs: 0, ...fallbackText(config.reasonLanguage), fix: DROP_THINKING_FALLBACK, api: failed.api }
      state.attempts.push({ code: failure.code, message: String(failure.message ?? ''), ...fix })
      ctx.logger.info(`retry-advisor: ${failure.code} with invalid thinking dropped (${failed.api}) → retry once as an ordinary request for session ${sessionId}`)
      record({ ...base, outcome: 'retry', ...fix })
      show(agent.session, { ...shown, outcome: 'retry', delayMs: 0, cause: fix.cause, reason: fix.reason, fix: DROP_THINKING_FALLBACK, api: failed.api })
      return { kind: 'retry' }
    }
    const dropper = dropping ? invalidThinkingDropper(failure) : undefined
    if (dropper !== undefined && !thinkingDrop.has(sessionId)) {
      thinkingDrop.enable(sessionId)
      const fix = { retry: true, delayMs: 0, ...dropThinkingText(config.reasonLanguage), fix: DROP_THINKING_FIX, api: dropper.api }
      state.attempts.push({ code: failure.code, message: String(failure.message ?? ''), ...fix })
      ctx.logger.info(`retry-advisor: ${failure.code} → retry with invalid thinking dropped (${dropper.api}) for session ${sessionId}`)
      record({ ...base, outcome: 'retry', ...fix })
      show(agent.session, { ...shown, outcome: 'retry', delayMs: 0, cause: fix.cause, reason: fix.reason, fix: DROP_THINKING_FIX, api: dropper.api })
      return { kind: 'retry' }
    }

    const planned = analysisRoute(config, agent.model.current())
    const plannedModel = planned === undefined ? {} : { analysisModel: `${planned.provider}/${planned.model}` }
    show(agent.session, { ...shown, outcome: 'analyzing', ...plannedModel })
    let result
    try {
      result = await runAnalysis({ agent, provider, turn, step, failure, attempts: [...state.attempts], signal })
    } catch (error) {
      if (signal.aborted) return downstream
      ctx.logger.warn(`retry-advisor: analysis failed, ${failure.code} stays terminal: ${describeError(error)}`)
      record({ ...base, outcome: 'analysis-failed', error: describeError(error) })
      show(agent.session, { ...shown, outcome: 'analysis-failed', ...plannedModel, error: describeError(error) })
      return downstream
    }

    const { decision, route } = result
    state.attempts.push({ code: failure.code, message: String(failure.message ?? ''), ...decision })
    const analysisModel = `${route.provider}/${route.model}`
    const effort = route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }
    const summary = `${failure.code} → ${decision.retry ? `retry in ${decision.delayMs}ms` : 'no retry'} (${analysisModel}${route.reasoningEffort === undefined ? '' : `, ${route.reasoningEffort}`}): ${decision.cause} ${decision.reason}`
    ctx.logger.info(`retry-advisor: ${summary}`)
    const outcome = decision.retry ? 'retry' : 'give-up'
    record({ ...base, outcome, analysisModel, ...effort, ...decision })
    show(agent.session, { ...shown, outcome, analysisModel, ...effort, delayMs: decision.delayMs, cause: decision.cause, reason: decision.reason })
    if (!decision.retry) return downstream
    if (!(await wait(decision.delayMs, signal))) return downstream
    return { kind: 'retry' }
  }
}

/**
 * Register the advisor as a last-resort `agent/request-error` listener, and
 * the request marking for conversations that drop invalid thinking. The
 * drop-invalid-thinking setting is volatile: both read it on every use, so
 * switching it takes effect without a reload.
 */
export function apply(ctx, config) {
  if (Boolean(config.provider) !== Boolean(config.model)) {
    throw new Error('retry-advisor: provider and model must be set together')
  }
  const thinkingDrop = createThinkingDrop()
  ctx.on('agent/request-error', createListener(ctx, config, { thinkingDrop }))
  ctx.on('llm-pi-ai/request-headers', createHeaderListener(thinkingDrop, () => flag(config.dropInvalidThinking)))
  ctx.on('dispose', () => thinkingDrop.dispose())
}
