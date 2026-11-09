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
 * Decisions are written to the Host log and, unless disabled, appended to a
 * JSONL decision log.
 *
 * @module @local/dsh-retry-advisor
 */

import z from '@deepseek-ai/schemastery'
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'retry-advisor'

/** The model-call service used for the analysis request. */
export const inject = ['llm']

/** Request purpose attached to the analysis call. */
export const PURPOSE = 'retry-advisor'

export const Config = z.object({
  provider: z.string()
    .description('Provider route for the analysis request. Set together with model; when both are empty, the analysis runs on the failed conversation\'s current model.'),
  model: z.string()
    .description('Model id for the analysis request. Set together with provider.'),
  reasoningEffort: z.string().default('low')
    .description('Reasoning effort for the analysis request, applied only when the analysis model offers it.'),
  maxTokens: z.natural().min(256).default(4096)
    .description('Output-token cap of the analysis request; thinking output counts toward it.'),
  timeoutMs: z.natural().min(1000).max(600000).default(60000)
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
})

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
    'If you choose to retry, the harness re-sends exactly the same request: same conversation, same tools, same model. Nothing in the request can be changed, so a retry helps only when the failure came from something transient or random in the provider, gateway, network, or response stream.',
    '',
    'Failures that usually succeed on retry:',
    '- gateway, proxy, network, or server errors; overload; rate limits (wait longer, and honor any retry-after hint)',
    '- truncated, duplicated, garbled, or empty response streams, including tool-call arguments that are not valid JSON because the stream was cut off or replayed',
    '- unclassified errors whose text points to a temporary condition',
  ]
  if (config.allowGiveUp) {
    lines.push(
      '',
      'Failures where re-sending the identical request fails the same way, so do not retry:',
      '- authentication, permission, missing or invalid credential, quota or billing exhaustion',
      '- the request itself rejected as invalid (bad parameter, unsupported field, payload too large, unknown model)',
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
      decision: entry.retry ? `retried after ${entry.delayMs}ms` : 'not retried',
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
 * Run one analysis request.
 * @returns the parsed decision and the route that produced it.
 * @throws when the route cannot be resolved, the request fails or times out, or the answer is unusable.
 */
export async function analyze(ctx, config, { agent, provider, turn, step, failure, attempts, signal }) {
  const selection = agent.model.current()
  const route = config.provider && config.model
    ? { provider: config.provider, model: config.model }
    : selection === undefined ? undefined : { provider: selection.provider, model: selection.model }
  if (route === undefined) throw new Error('no analysis model: configure provider and model, or select a conversation model')

  const callSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)])
  const call = await ctx.llm.prepareCall({ ...route, maxTokens: config.maxTokens }, callSignal, (controls, model) => {
    const efforts = model.reasoning?.efforts ?? []
    return config.reasoningEffort && efforts.some(effort => effort.id === config.reasoningEffort)
      ? { ...controls, reasoningEffort: config.reasoningEffort }
      : controls
  })
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
  return { decision: parseDecision(text, config), route }
}

/**
 * Build the `agent/request-error` listener.
 * @param ctx - plugin context exposing `llm` and `logger`.
 * @param config - resolved plugin config.
 * @param deps - replaceable analysis and logging functions.
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
  const wait = deps.sleep ?? sleep
  /** Failures seen in the current step, keyed by Session. */
  const steps = new WeakMap()

  function record(entry) {
    writeLog({ time: new Date().toISOString(), ...entry }).catch((error) => {
      ctx.logger.warn(`retry-advisor: could not write the decision log: ${describeError(error)}`)
    })
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
    if (granted >= config.maxRetriesPerStep) {
      ctx.logger.info(`retry-advisor: ${failure.code} in turn ${turn} step ${step} stays terminal; ${granted} retries already granted`)
      record({ ...base, outcome: 'budget-exhausted', granted })
      return downstream
    }

    let result
    try {
      result = await runAnalysis({ agent, provider, turn, step, failure, attempts: [...state.attempts], signal })
    } catch (error) {
      if (signal.aborted) return downstream
      ctx.logger.warn(`retry-advisor: analysis failed, ${failure.code} stays terminal: ${describeError(error)}`)
      record({ ...base, outcome: 'analysis-failed', error: describeError(error) })
      return downstream
    }

    const { decision, route } = result
    state.attempts.push({ code: failure.code, message: String(failure.message ?? ''), ...decision })
    const summary = `${failure.code} → ${decision.retry ? `retry in ${decision.delayMs}ms` : 'no retry'} (${route.provider}/${route.model}): ${decision.cause} ${decision.reason}`
    ctx.logger.info(`retry-advisor: ${summary}`)
    record({ ...base, outcome: decision.retry ? 'retry' : 'give-up', analysisModel: `${route.provider}/${route.model}`, ...decision })
    if (!decision.retry) return downstream
    if (!(await wait(decision.delayMs, signal))) return downstream
    return { kind: 'retry' }
  }
}

/** Register the advisor as a last-resort `agent/request-error` listener. */
export function apply(ctx, config) {
  if (Boolean(config.provider) !== Boolean(config.model)) {
    throw new Error('retry-advisor: provider and model must be set together')
  }
  ctx.on('agent/request-error', createListener(ctx, config))
}
