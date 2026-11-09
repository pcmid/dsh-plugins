import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Config, analyze, apply, buildSystemPrompt, clip, createListener, parseDecision } from '../index.js'

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

function harness(cfg, analysis) {
  const logger = fakeLogger()
  const records = []
  const sleeps = []
  const calls = []
  const listener = createListener({ logger }, cfg, {
    analyze: async (input) => {
      calls.push(input)
      return analysis(input)
    },
    writeLog: async (record) => { records.push(record) },
    sleep: async (ms, signal) => {
      sleeps.push(ms)
      return !signal.aborted
    },
  })
  return { listener, logger, records, sleeps, calls }
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

  it('runs on the conversation model with the configured low effort', async () => {
    const fake = fakeLlm(answer)
    const result = await analyze(fake, config(), { ...payload(), attempts: [] })
    assert.deepEqual(result.route, route)
    assert.equal(fake.seen.controls.reasoningEffort, 'low')
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

  it('registers one agent/request-error listener', () => {
    const events = []
    apply({ on: (name) => events.push(name), logger: fakeLogger() }, config())
    assert.deepEqual(events, ['agent/request-error'])
  })

  it('has the documented defaults', () => {
    const resolved = Config({})
    assert.equal(resolved.maxRetriesPerStep, 3)
    assert.equal(resolved.allowGiveUp, true)
    assert.deepEqual(resolved.skipCodes, ['ABORTED'])
    assert.match(resolved.decisionLog, /\.dsh\/retry-advisor\/decisions\.jsonl$/)
    assert.equal(resolved.provider, undefined)
  })
})
