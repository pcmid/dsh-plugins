import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  Config,
  DROP_THINKING_FIX,
  DROP_THINKING_HEADER,
  analyze,
  apply,
  buildAnalysisInput,
  buildSystemPrompt,
  clip,
  createDropThinkingFetch,
  createHeaderListener,
  createListener,
  createThinkingDrop,
  dropInvalidThinking,
  flag,
  installDropThinkingFetch,
  invalidThinkingDropper,
  parseDecision,
} from '../index.js'

const config = (overrides = {}) => Config({ decisionLog: '', ...overrides })

function fakeLogger() {
  const lines = []
  return { lines, info: line => lines.push(['info', line]), warn: line => lines.push(['warn', line]) }
}

function fakeAgent(selection = { provider: 'ccmax', model: 'claude-opus-5-5', reasoningEffort: 'xhigh' }) {
  return { session: { id: 'session-test' }, model: { current: () => selection } }
}

function payload(overrides = {}) {
  return {
    agent: overrides.agent ?? fakeAgent(),
    turn: 1,
    step: 34,
    provider: 'ccmax',
    failure: { code: 'MALFORMED_RESPONSE', message: 'Tool call "bash": Expected \',\' or \'}\'' },
    retryPolicy: undefined,
    signal: new AbortController().signal,
    ...overrides,
  }
}

function harness(cfg, analysis, thinkingDrop = fakeDrop()) {
  const logger = fakeLogger()
  const records = []
  const shown = []
  const sleeps = []
  const calls = []
  const listener = createListener({ logger }, cfg, {
    analyze: async (input) => {
      calls.push(input)
      return analysis(input)
    },
    writeLog: async (record) => { records.push(record) },
    appendRecord: (_session, data) => { shown.push(data) },
    sleep: async (ms, signal) => {
      sleeps.push(ms)
      return !signal.aborted
    },
    thinkingDrop,
  })
  return { listener, logger, records, shown, sleeps, calls, thinkingDrop }
}

function fakeDrop() {
  const sessions = new Set()
  return { sessions, has: id => sessions.has(String(id)), enable: id => sessions.add(String(id)), dispose: () => sessions.clear() }
}

const bindingFailure = {
  code: 'INVALID_REQUEST',
  message: '400 {"error":{"type":"<nil>","message":"messages.1.content.5: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to \\"drop_block\\". (request id: 2026)"},"type":"error"}',
}

const route = { provider: 'ccmax', model: 'claude-opus-5-5' }
const terminal = () => Promise.resolve(undefined)

describe('request-error listener', () => {
  it('returns a downstream retry without analysis', async () => {
    const h = harness(config(), () => assert.fail('analysis must not run'))
    assert.deepEqual(await h.listener(payload(), () => Promise.resolve({ kind: 'retry' })), { kind: 'retry' })
    assert.equal(h.calls.length, 0)
  })

  it('leaves skipped codes terminal without analysis', async () => {
    const h = harness(config(), () => assert.fail('analysis must not run'))
    const result = await h.listener(payload({ failure: { code: 'ABORTED', message: 'stop' } }), terminal)
    assert.equal(result, undefined)
    assert.equal(h.calls.length, 0)
  })

  it('retries after the chosen delay when the analysis says so', async () => {
    const h = harness(config(), () => ({ decision: { retry: true, delayMs: 1500, cause: 'stream replay', reason: 'transient' }, route }))
    assert.deepEqual(await h.listener(payload(), terminal), { kind: 'retry' })
    assert.deepEqual(h.sleeps, [1500])
    assert.equal(h.records[0].outcome, 'retry')
    assert.equal(h.records[0].analysisModel, 'ccmax/claude-opus-5-5')
  })

  it('does not retry when the analysis gives up', async () => {
    const h = harness(config(), () => ({ decision: { retry: false, delayMs: 0, cause: 'bad key', reason: 'deterministic' }, route }))
    assert.equal(await h.listener(payload({ failure: { code: 'AUTH', message: '401' } }), terminal), undefined)
    assert.equal(h.sleeps.length, 0)
    assert.equal(h.records[0].outcome, 'give-up')
  })

  it('does not retry when the analysis fails', async () => {
    const h = harness(config(), () => { throw Object.assign(new Error('502 bad gateway'), { code: 'SERVER' }) })
    assert.equal(await h.listener(payload(), terminal), undefined)
    assert.equal(h.records[0].outcome, 'analysis-failed')
    assert.match(h.records[0].error, /SERVER: 502/)
    assert.equal(h.logger.lines[0][0], 'warn')
  })

  it('stops analyzing once the step budget is spent and resets on a new step', async () => {
    const h = harness(config({ maxRetriesPerStep: 2 }), () => ({ decision: { retry: true, delayMs: 0, cause: '', reason: '' }, route }))
    const agent = fakeAgent()
    assert.deepEqual(await h.listener(payload({ agent }), terminal), { kind: 'retry' })
    assert.deepEqual(await h.listener(payload({ agent }), terminal), { kind: 'retry' })
    assert.equal(await h.listener(payload({ agent }), terminal), undefined)
    assert.equal(h.calls.length, 2)
    assert.equal(h.records[2].outcome, 'budget-exhausted')
    assert.equal(h.calls[1].attempts.length, 1, 'the second analysis sees the first attempt')
    assert.deepEqual(await h.listener(payload({ agent, step: 35 }), terminal), { kind: 'retry' })
    assert.equal(h.calls[2].attempts.length, 0)
  })

  it('does not retry when cancelled during the wait', async () => {
    const controller = new AbortController()
    const h = harness(config(), () => {
      controller.abort()
      return { decision: { retry: true, delayMs: 10, cause: '', reason: '' }, route }
    })
    assert.equal(await h.listener(payload({ signal: controller.signal }), terminal), undefined)
  })

  it('does not analyze after a cancelled downstream', async () => {
    const controller = new AbortController()
    const h = harness(config(), () => assert.fail('analysis must not run'))
    const result = await h.listener(payload({ signal: controller.signal }), () => {
      controller.abort()
      return Promise.resolve(undefined)
    })
    assert.equal(result, undefined)
  })
})

describe('parseDecision', () => {
  it('reads fenced JSON and clamps the delay', () => {
    const text = '```json\n{"retry": true, "delayMs": 999999, "cause": "c", "reason": "r"}\n```'
    assert.deepEqual(parseDecision(text, config({ maxDelayMs: 30000 })), { retry: true, delayMs: 30000, cause: 'c', reason: 'r' })
  })

  it('rejects answers without a boolean retry', () => {
    assert.throws(() => parseDecision('I think you should retry.', config()), /no JSON object/)
    assert.throws(() => parseDecision('{"retry": "yes"}', config()), /boolean "retry"/)
    assert.throws(() => parseDecision('{"retry": true, "delayMs": "soon"}', config()), /delayMs/)
  })

  it('forces a retry when giving up is not allowed', () => {
    assert.equal(parseDecision('{"retry": false, "delayMs": 0}', config({ allowGiveUp: false })).retry, true)
  })
})

describe('prompt', () => {
  it('omits the give-up rules when giving up is not allowed', () => {
    assert.match(buildSystemPrompt(config()), /do not retry/)
    assert.match(buildSystemPrompt(config({ allowGiveUp: false })), /You must retry/)
  })

  it('clips long text keeping head and tail', () => {
    const clipped = clip(`HEAD${'x'.repeat(10000)}TAIL`, 300)
    assert.ok(clipped.length < 320)
    assert.ok(clipped.startsWith('HEAD') && clipped.endsWith('TAIL'))
  })
})

describe('analyze', () => {
  function fakeLlm(chunks, efforts = [{ id: 'low' }, { id: 'xhigh' }]) {
    const seen = {}
    return {
      seen,
      llm: {
        async prepareCall(callConfig, signal, configure) {
          seen.callConfig = callConfig
          const controls = configure({ maxTokens: callConfig.maxTokens }, { reasoning: { efforts } })
          seen.controls = controls
          return {
            config: { provider: callConfig.provider, model: callConfig.model, ...controls },
            async *stream(options) {
              seen.options = options
              yield* chunks
            },
          }
        },
      },
    }
  }

  const answer = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '{"retry": true, "delayMs": 2000, "cause": "流被重放", "reason": "重发即可"}' } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]

  it('runs on the conversation model with its reasoning effort and default output cap', async () => {
    const fake = fakeLlm(answer)
    const result = await analyze(fake, config(), { ...payload(), attempts: [] })
    assert.deepEqual(result.route, { ...route, reasoningEffort: 'xhigh' })
    assert.equal(fake.seen.controls.reasoningEffort, 'xhigh')
    assert.equal(fake.seen.callConfig.maxTokens, undefined)
    assert.equal(fake.seen.options.purpose, 'retry-advisor')
    assert.equal(fake.seen.options.messages[0].role, 'user')
    assert.match(fake.seen.options.messages[0].content[0].text, /MALFORMED_RESPONSE/)
    assert.equal(result.decision.delayMs, 2000)
  })

  it('uses the configured route and skips an effort the model lacks', async () => {
    const fake = fakeLlm(answer, [{ id: 'high' }])
    const result = await analyze(fake, config({ provider: 'ccmax', model: 'claude-haiku-5-5' }), { ...payload(), attempts: [] })
    assert.deepEqual(result.route, { provider: 'ccmax', model: 'claude-haiku-5-5' })
    assert.equal(fake.seen.controls.reasoningEffort, undefined)
  })

  it('throws when the analysis request fails', async () => {
    const fake = fakeLlm([{ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: '502' } } }])
    await assert.rejects(analyze(fake, config(), { ...payload(), attempts: [] }), /analysis request failed: 502/)
  })

  it('throws on a timeout', async () => {
    const slow = {
      llm: {
        async prepareCall(callConfig, signal) {
          return {
            config: callConfig,
            async *stream() {
              await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
              yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } }
            },
          }
        },
      },
    }
    await assert.rejects(analyze(slow, config({ timeoutMs: 1000 }), { ...payload(), attempts: [] }))
  })
})

describe('apply', () => {
  it('rejects a provider without a model', () => {
    assert.throws(() => apply({ on: () => {} }, config({ provider: 'ccmax' })), /set together/)
  })

  it('registers the request-error listener, header marking, and cleanup', () => {
    const events = []
    apply({ on: (name) => events.push(name), logger: fakeLogger() }, config())
    assert.deepEqual(events, ['agent/request-error', 'llm-pi-ai/request-headers', 'dispose'])
  })

  it('has the documented defaults', () => {
    const resolved = Config({})
    assert.equal(resolved.maxRetriesPerStep, 3)
    assert.equal(resolved.allowGiveUp, true)
    assert.deepEqual(resolved.skipCodes, ['ABORTED'])
    assert.match(resolved.decisionLog, /\.dsh\/retry-advisor\/decisions\.jsonl$/)
    assert.equal(resolved.provider, undefined)
    assert.equal(flag(resolved.dropInvalidThinking), false, 'dropping invalid thinking is off by default')
    assert.equal(typeof resolved.dropInvalidThinking.get, 'function', 'the switch is volatile')
  })
})

describe('drop invalid thinking', () => {
  const on = (overrides = {}) => config({ dropInvalidThinking: true, ...overrides })

  it('recognizes the Anthropic bound-to-a-different-conversation rejection only', () => {
    assert.equal(invalidThinkingDropper(bindingFailure)?.api, 'anthropic-messages')
    assert.equal(invalidThinkingDropper({ message: 'messages.3.content.0: Invalid `signature` in `thinking` block' }), undefined)
    assert.equal(invalidThinkingDropper({ message: '529 overloaded' }), undefined)
    assert.equal(invalidThinkingDropper(undefined), undefined)
  })

  it('leaves the failure to the analysis while the setting is off', async () => {
    const h = harness(config(), () => ({ decision: { retry: false, delayMs: 0, cause: '', reason: '' }, route }))
    assert.equal(await h.listener(payload({ failure: bindingFailure }), terminal), undefined)
    assert.equal(h.calls.length, 1)
    assert.equal(h.thinkingDrop.sessions.size, 0)
  })

  it('switches the session to dropping and retries at once without analysis', async () => {
    const h = harness(on(), () => assert.fail('analysis must not run'))
    assert.deepEqual(await h.listener(payload({ failure: bindingFailure }), terminal), { kind: 'retry' })
    assert.equal(h.thinkingDrop.has('session-test'), true)
    assert.deepEqual(h.sleeps, [])
    assert.equal(h.records[0].outcome, 'retry')
    assert.equal(h.records[0].fix, DROP_THINKING_FIX)
    assert.equal(h.records[0].api, 'anthropic-messages')
    assert.equal(h.shown.length, 1)
    assert.equal(h.shown[0].outcome, 'retry')
    assert.equal(h.shown[0].fix, DROP_THINKING_FIX)
    assert.equal(h.shown[0].analysisModel, undefined)
  })

  it('reads the volatile setting at each failure', async () => {
    let current = false
    const h = harness({ ...on(), dropInvalidThinking: { get: () => current } }, () => ({ decision: { retry: false, delayMs: 0, cause: '', reason: '' }, route }))
    assert.equal(await h.listener(payload({ failure: bindingFailure }), terminal), undefined)
    current = true
    assert.deepEqual(await h.listener(payload({ failure: bindingFailure, step: 35 }), terminal), { kind: 'retry' })
  })

  it('sends a repeat of the failure to the ordinary analysis, which sees the drop', async () => {
    const h = harness(on(), () => ({ decision: { retry: false, delayMs: 0, cause: 'c', reason: 'r' }, route }))
    const agent = fakeAgent()
    assert.deepEqual(await h.listener(payload({ agent, failure: bindingFailure }), terminal), { kind: 'retry' })
    assert.equal(await h.listener(payload({ agent, failure: bindingFailure }), terminal), undefined)
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].attempts[0].fix, DROP_THINKING_FIX)
    const input = JSON.parse(buildAnalysisInput({ ...h.calls[0], selection: undefined, config: on() }))
    assert.match(input.earlierFailuresInThisStep[0].decision, /invalid thinking dropped \(anthropic-messages\)/)
    assert.equal(input.retriesGrantedInThisStep, 1)
  })

  it('is skipped once the step budget is spent', async () => {
    const h = harness(on({ maxRetriesPerStep: 0 }), () => assert.fail('analysis must not run'))
    assert.equal(await h.listener(payload({ failure: bindingFailure }), terminal), undefined)
    assert.equal(h.records[0].outcome, 'budget-exhausted')
    assert.equal(h.thinkingDrop.sessions.size, 0)
  })

  it('writes Chinese text for a Chinese reason language and English otherwise', async () => {
    const zh = harness(on(), () => assert.fail('analysis must not run'))
    await zh.listener(payload({ failure: bindingFailure }), terminal)
    assert.match(zh.records[0].reason, /丢弃无效思考/)
    const en = harness(on({ reasonLanguage: 'English' }), () => assert.fail('analysis must not run'))
    await en.listener(payload({ failure: bindingFailure }), terminal)
    assert.match(en.records[0].reason, /drop-invalid-thinking/)
  })

  it('marks requests of switched sessions only while the setting is on', () => {
    const drop = fakeDrop()
    drop.enable('session-a')
    let enabled = true
    const listener = createHeaderListener(drop, () => enabled)
    const headersA = new Headers({ a: '1' })
    assert.equal(listener({ provider: 'ccmax', model: 'm', sessionId: 'session-a' }, headersA, () => headersA), headersA)
    assert.equal(headersA.has(DROP_THINKING_HEADER), true)
    assert.equal(headersA.get('a'), '1')
    const headersB = new Headers()
    listener({ provider: 'ccmax', model: 'm', sessionId: 'session-b' }, headersB, () => headersB)
    assert.equal(headersB.has(DROP_THINKING_HEADER), false)
    const headersC = new Headers()
    assert.equal(listener({ provider: 'ccmax', model: 'm' }, headersC, () => 'next result'), 'next result')
    assert.equal(headersC.has(DROP_THINKING_HEADER), false)
    enabled = false
    const headersD = new Headers()
    listener({ provider: 'ccmax', model: 'm', sessionId: 'session-a' }, headersD, () => headersD)
    assert.equal(headersD.has(DROP_THINKING_HEADER), false, 'switching the setting off stops dropping at once')
  })
})

describe('dropInvalidThinking', () => {
  it('adds drop_block to enabled or adaptive Anthropic thinking', () => {
    const adaptive = JSON.parse(dropInvalidThinking(JSON.stringify({ model: 'm', thinking: { type: 'adaptive', display: 'summarized' }, stream: true })))
    assert.deepEqual(adaptive.thinking, { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } })
    assert.equal(adaptive.stream, true)
    const enabled = JSON.parse(dropInvalidThinking(JSON.stringify({ thinking: { type: 'enabled', budget_tokens: 1024, block_binding: { other: 1 } } })))
    assert.deepEqual(enabled.thinking.block_binding, { other: 1, prefix_mismatch_behavior: 'drop_block' })
  })

  it('leaves disabled, absent, already dropped, other-API, and non-JSON bodies unchanged', () => {
    assert.equal(dropInvalidThinking(JSON.stringify({ thinking: { type: 'disabled' } })), undefined)
    assert.equal(dropInvalidThinking(JSON.stringify({ model: 'gpt', reasoning: { effort: 'high' } })), undefined)
    assert.equal(dropInvalidThinking(JSON.stringify({ thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } })), undefined)
    assert.equal(dropInvalidThinking('not json'), undefined)
    assert.equal(dropInvalidThinking('[1,2]'), undefined)
  })
})

describe('drop-thinking fetch', () => {
  function recorder() {
    const calls = []
    const base = async (...args) => {
      calls.push(args)
      return new Response('ok')
    }
    return { calls, base }
  }

  const body = JSON.stringify({ model: 'claude', thinking: { type: 'adaptive' }, messages: [] })
  const dropped = text => JSON.parse(text).thinking.block_binding.prefix_mismatch_behavior === 'drop_block'

  it('rewrites marked requests and strips the marker', async () => {
    const { calls, base } = recorder()
    const fetch = createDropThinkingFetch(base)
    const headers = new Headers({ 'content-type': 'application/json', [DROP_THINKING_HEADER]: 'drop' })
    await fetch('https://api.example/v1/messages', { method: 'POST', headers, body })
    const [url, init] = calls[0]
    assert.equal(url, 'https://api.example/v1/messages')
    assert.equal(init.headers.has(DROP_THINKING_HEADER), false)
    assert.equal(init.headers.get('content-type'), 'application/json')
    assert.ok(dropped(init.body))
    assert.equal(headers.has(DROP_THINKING_HEADER), true, 'the caller headers are not mutated')
  })

  it('accepts record and array headers', async () => {
    const { calls, base } = recorder()
    const fetch = createDropThinkingFetch(base)
    await fetch('u', { method: 'POST', headers: { 'X-DSH-Retry-Advisor-Drop-Thinking': 'drop' }, body })
    await fetch('u', { method: 'POST', headers: [[DROP_THINKING_HEADER, 'drop']], body })
    for (const [, init] of calls) {
      assert.equal(init.headers.has(DROP_THINKING_HEADER), false)
      assert.ok(dropped(init.body))
    }
  })

  it('passes unmarked requests through with the original arguments', async () => {
    const { calls, base } = recorder()
    const fetch = createDropThinkingFetch(base)
    const init = { method: 'POST', headers: { a: '1' }, body }
    await fetch('u', init)
    await fetch('v')
    assert.equal(calls[0][1], init)
    assert.deepEqual(calls[1], ['v'])
  })

  it('rewrites a marked Request object', async () => {
    const { calls, base } = recorder()
    const fetch = createDropThinkingFetch(base)
    await fetch(new Request('https://api.example/v1/messages', { method: 'POST', headers: { [DROP_THINKING_HEADER]: 'drop' }, body }))
    const [request] = calls[0]
    assert.equal(request.headers.has(DROP_THINKING_HEADER), false)
    assert.ok(dropped(await request.text()))
  })

  it('installs lazily and restores the original fetch on dispose', async () => {
    const { calls, base } = recorder()
    const target = { fetch: base }
    const drop = createThinkingDrop(target)
    assert.equal(target.fetch, base, 'nothing is installed before a session is switched')
    drop.enable('s')
    drop.enable('s2')
    assert.notEqual(target.fetch, base)
    await target.fetch('u', { method: 'POST', headers: { [DROP_THINKING_HEADER]: 'drop' }, body })
    assert.ok(dropped(calls[0][1].body))
    drop.dispose()
    assert.equal(target.fetch, base)
    assert.equal(drop.has('s'), false)
  })

  it('stays a pass-through when another wrapper sits on top at dispose', async () => {
    const { calls, base } = recorder()
    const target = { fetch: base }
    const uninstall = installDropThinkingFetch(target)
    const ours = target.fetch
    const outer = (...args) => ours(...args)
    target.fetch = outer
    uninstall()
    assert.equal(target.fetch, outer)
    const init = { method: 'POST', headers: { [DROP_THINKING_HEADER]: 'drop' }, body }
    await target.fetch('u', init)
    assert.equal(calls[0][1], init)
  })
})
