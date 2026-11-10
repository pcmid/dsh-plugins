import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Config, SOURCE_KIND, apply, reminderSummary } from '../index.js'

/**
 * Host stand-in: one Session whose `append` publishes `session/event`, one
 * agent, and the listeners the plugin registered.
 */
function harness(overrides = {}) {
  const listeners = new Map()
  const events = []
  const warnings = []
  const session = {
    append(type, data) {
      const event = { type, data, seq: events.length }
      events.push(event)
      for (const listener of listeners.get('session/event') ?? []) listener(session, event)
      return event
    },
  }
  const agent = { session, inbox: { nextStep: [] } }
  const ctx = {
    logger: { warn: line => warnings.push(line) },
    on(name, listener) {
      listeners.set(name, [...listeners.get(name) ?? [], listener])
    },
  }
  apply(ctx, Config(overrides))
  const h = {
    agent, events, warnings, listeners,
    append: (type, data) => session.append(type, data),
    /** Run one call through the post-execute waterfall and return the decision. */
    tool(name, { parent, result = { isError: false }, downstream = async () => ({ kind: 'accept' }) } = {}) {
      const [listener] = listeners.get('tools/post-execute')
      return listener({ name, agent, parent }, result, downstream)
    },
    /** Open a step whose assistant message calls `names`. */
    step(turn, step, names, extra = {}) {
      h.append('step/start', { turn, step })
      h.append('assistant/message', {
        turn, step, ...extra,
        message: { content: names.map((name, index) => ({ type: 'tool-call', id: `${name}-${step}-${index}`, name, arguments: '{}' })) },
      })
    },
    /** A complete tool step: open it, run every call, close it; returns the decisions. */
    async toolStep(turn, step, names) {
      h.step(turn, step, names)
      const decisions = []
      for (const name of names) {
        if (name === 'todo_write') h.append('todo/write', { todos: h.nextTodos ?? PLAN })
        decisions.push(await h.tool(name))
      }
      h.append('step/end', { turn, step })
      return decisions
    },
    /** Dispatch `agent/turn-stopping` the way the loop does before `turn/end`. */
    stopTurn(turn, { aborted = false } = {}) {
      const controller = new AbortController()
      if (aborted) controller.abort()
      for (const listener of listeners.get('agent/turn-stopping') ?? []) listener({ agent, turn, signal: controller.signal })
    },
    lastWrite: () => events.findLast(event => event.type === 'todo/write')?.data.todos,
  }
  return h
}

const PLAN = [
  { content: 'Recon the repository', status: 'completed' },
  { content: 'Implement the fix', status: 'in_progress' },
  { content: 'Run the test suite', status: 'pending' },
]

const contexts = decisions => decisions.flatMap(decision => decision.additionalContexts ?? [])

/** Turn 1 with a list written in step 1, then `count` single-call tool steps; returns the steps' decisions. */
async function workSteps(h, count, tool = 'bash') {
  h.append('turn/start', { turn: 1 })
  await h.toolStep(1, 1, ['todo_write'])
  const out = []
  for (let step = 2; step < 2 + count; step += 1) out.push(await h.toolStep(1, step, [tool]))
  return out
}

describe('mid-turn reminder', () => {
  it('reminds after stepThreshold steps without a todo_write, with the list verbatim', async () => {
    const h = harness({ stepThreshold: 3 })
    const steps = await workSteps(h, 3)
    assert.equal(contexts(steps[0]).length, 0)
    assert.equal(contexts(steps[1]).length, 0)
    const [reminder, ...rest] = contexts(steps[2])
    assert.equal(rest.length, 0)
    assert.equal(reminder.role, 'user')
    assert.equal(reminder.source.kind, SOURCE_KIND)
    assert.equal(reminder.source.form, 'notice')
    assert.equal(reminder.source.summary, 'Todo list 1/3 completed · Implement the fix')
    assert.equal(typeof reminder.id, 'string')
    assert.ok(Object.isFrozen(reminder) && Object.isFrozen(reminder.content[0]))
    const text = reminder.content[0].text
    assert.match(text, /^Todo list check: 1\/3 completed, 3 step\(s\) and 3 tool call\(s\) since your last todo_write\./)
    assert.match(text, /\n1\. \[completed\] Recon the repository\n2\. \[in_progress\] Implement the fix\n3\. \[pending\] Run the test suite\n/)
    assert.match(text, /If it still matches, continue without calling todo_write\./)
  })

  it('uses 5 steps and 10 calls by default', async () => {
    const h = harness()
    const steps = await workSteps(h, 5)
    assert.deepEqual(steps.map(step => contexts(step).length), [0, 0, 0, 0, 1])
  })

  it('reminds on the call threshold', async () => {
    const h = harness({ stepThreshold: 10, callThreshold: 3 })
    h.append('turn/start', { turn: 1 })
    await h.toolStep(1, 1, ['todo_write'])
    const decisions = await h.toolStep(1, 2, ['read', 'grep', 'glob'])
    assert.equal(decisions[0].additionalContexts?.length, 1, 'the assistant message already announced all three calls')
    assert.equal(decisions[1].additionalContexts, undefined)
    assert.equal(decisions[2].additionalContexts, undefined)
  })

  it('reminds at most once per step, even when nested calls cross the threshold again', async () => {
    const h = harness({ stepThreshold: 10, callThreshold: 2 })
    h.append('turn/start', { turn: 1 })
    await h.toolStep(1, 1, ['todo_write'])
    h.step(1, 2, ['run_code', 'run_code'])
    assert.equal((await h.tool('run_code')).additionalContexts?.length, 1)
    for (const subCallId of ['a', 'b', 'c']) {
      h.append('tool/ptc-dispatch-start', { name: 'bash', rootCallId: 'r', parentCallId: 'r', subCallId })
    }
    assert.equal((await h.tool('run_code')).additionalContexts, undefined)
    h.append('step/end', { turn: 1, step: 2 })
    assert.equal(contexts(await h.toolStep(1, 3, ['bash'])).length, 1, 'the nested calls still count toward the next step')
  })

  it('restarts the count after a reminder', async () => {
    const h = harness({ stepThreshold: 2 })
    const steps = await workSteps(h, 6)
    assert.deepEqual(steps.map(step => contexts(step).length), [0, 1, 0, 1, 0, 1])
  })

  it('restarts the count after a todo_write', async () => {
    const h = harness({ stepThreshold: 2 })
    h.append('turn/start', { turn: 1 })
    await h.toolStep(1, 1, ['todo_write'])
    assert.equal(contexts(await h.toolStep(1, 2, ['bash'])).length, 0)
    assert.equal(contexts(await h.toolStep(1, 3, ['bash', 'todo_write'])).length, 0, 'the step itself updates the list')
    assert.equal(contexts(await h.toolStep(1, 4, ['bash'])).length, 0)
    assert.equal(contexts(await h.toolStep(1, 5, ['bash'])).length, 1)
  })

  it('counts a todo_write made from inside run_code', async () => {
    const h = harness({ stepThreshold: 2 })
    h.append('turn/start', { turn: 1 })
    await h.toolStep(1, 1, ['todo_write'])
    await h.toolStep(1, 2, ['bash'])
    h.step(1, 3, ['run_code'])
    h.append('tool/ptc-dispatch-start', { name: 'todo_write', rootCallId: 'r', parentCallId: 'r', subCallId: 's' })
    h.append('todo/write', { todos: PLAN })
    assert.equal((await h.tool('todo_write', { parent: {} })).additionalContexts, undefined)
    assert.equal((await h.tool('run_code')).additionalContexts, undefined)
    h.append('step/end', { turn: 1, step: 3 })
    assert.equal(contexts(await h.toolStep(1, 4, ['bash'])).length, 0, 'the nested write restarted the count')
  })

  it('does not count calls made in the step that wrote the list', async () => {
    const h = harness({ stepThreshold: 10, callThreshold: 3 })
    h.append('turn/start', { turn: 1 })
    await h.toolStep(1, 1, ['todo_write'])
    h.step(1, 2, ['run_code'])
    h.append('tool/ptc-dispatch-start', { name: 'todo_write', rootCallId: 'r', parentCallId: 'r', subCallId: 'w' })
    h.append('todo/write', { todos: PLAN })
    for (const subCallId of ['a', 'b', 'c']) {
      h.append('tool/ptc-dispatch-start', { name: 'bash', rootCallId: 'r', parentCallId: 'r', subCallId })
    }
    assert.equal((await h.tool('run_code')).additionalContexts, undefined)
    h.append('step/end', { turn: 1, step: 2 })
    assert.equal(contexts(await h.toolStep(1, 3, ['bash'])).length, 0)
    assert.equal(contexts(await h.toolStep(1, 4, ['bash', 'bash'])).length, 1, 'three calls since the write')
  })

  it('leaves nested calls and turn-concluding results alone', async () => {
    const h = harness({ stepThreshold: 1 })
    h.append('turn/start', { turn: 1 })
    await h.toolStep(1, 1, ['todo_write'])
    h.step(1, 2, ['run_code'])
    assert.equal((await h.tool('bash', { parent: {} })).additionalContexts, undefined)
    assert.equal((await h.tool('run_code', { result: { isError: false, concludesTurn: true } })).additionalContexts, undefined)
    assert.equal((await h.tool('run_code')).additionalContexts?.length, 1)
  })

  it('stays silent without a list, once every item is completed, and in a step that asks the user', async () => {
    const none = harness({ stepThreshold: 1 })
    none.append('turn/start', { turn: 1 })
    for (const step of [1, 2, 3]) assert.equal(contexts(await none.toolStep(1, step, ['bash'])).length, 0)

    const done = harness({ stepThreshold: 1 })
    done.nextTodos = PLAN.map(item => ({ ...item, status: 'completed' }))
    assert.equal((await workSteps(done, 3)).flatMap(contexts).length, 0)

    const asking = harness({ stepThreshold: 1 })
    asking.append('turn/start', { turn: 1 })
    await asking.toolStep(1, 1, ['todo_write'])
    assert.equal(contexts(await asking.toolStep(1, 2, ['ask_user_question'])).length, 0)
  })

  it('forgets the list when a new turn starts', async () => {
    const h = harness({ stepThreshold: 1 })
    await workSteps(h, 1)
    h.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    h.append('turn/start', { turn: 2 })
    assert.equal(contexts(await h.toolStep(2, 1, ['bash'])).length, 0)
  })

  it('starts tracking at the first todo_write when it loads mid-turn', async () => {
    const h = harness({ stepThreshold: 1, autoCompleteOnTurnEnd: true })
    // The plugin first sees this Session in the middle of turn 1.
    assert.equal(contexts(await h.toolStep(1, 7, ['bash'])).length, 0)
    await h.toolStep(1, 8, ['todo_write'])
    assert.equal(contexts(await h.toolStep(1, 9, ['bash'])).length, 1)
    const before = h.events.length
    h.stopTurn(1)
    assert.equal(h.events.length, before, 'the turn start was not seen, so the turn is not completed')
  })

  it('keeps a blocked downstream verdict and the downstream contexts', async () => {
    const h = harness({ stepThreshold: 1 })
    h.append('turn/start', { turn: 1 })
    await h.toolStep(1, 1, ['todo_write'])
    h.step(1, 2, ['bash'])
    const feedback = [{ type: 'text', text: 'blocked downstream' }]
    const theirs = { role: 'user', content: [], source: { kind: 'other' } }
    const decision = await h.tool('bash', { downstream: async () => ({ kind: 'block', feedback, additionalContexts: [theirs] }) })
    assert.equal(decision.kind, 'block')
    assert.equal(decision.feedback, feedback)
    assert.deepEqual(decision.additionalContexts.map(context => context.source.kind), [SOURCE_KIND, 'other'])
  })

  it('bounds the notice summary', () => {
    const summary = reminderSummary([{ content: 'x'.repeat(300), status: 'in_progress' }])
    assert.equal(summary.length, 120)
    assert.ok(summary.endsWith('…'))
  })
})

describe('turn-end completion', () => {
  /** Turn 1: list, one work step, then a final reply step. */
  async function finishedTurn(config, { finalStep = true } = {}) {
    const h = harness({ autoCompleteOnTurnEnd: true, ...config })
    await workSteps(h, 1)
    if (finalStep) {
      h.step(1, 3, [])
      h.append('step/end', { turn: 1, step: 3 })
    }
    return h
  }

  it('is off by default', async () => {
    const h = await finishedTurn({ autoCompleteOnTurnEnd: false })
    assert.equal(h.listeners.has('agent/turn-stopping'), false)
  })

  it('completes leftover items when the turn ends normally', async () => {
    const h = await finishedTurn()
    h.stopTurn(1)
    assert.deepEqual(h.lastWrite(), PLAN.map(item => ({ content: item.content, status: 'completed' })))
  })

  it('skips aborted turns, queued steering, interrupted replies, and a wrong turn', async () => {
    const aborted = await finishedTurn()
    const before = aborted.events.length
    aborted.stopTurn(1, { aborted: true })
    assert.equal(aborted.events.length, before)

    const steered = await finishedTurn()
    steered.agent.inbox.nextStep = [{ role: 'user' }]
    steered.stopTurn(1)
    assert.equal(steered.lastWrite(), PLAN)

    const interrupted = harness({ autoCompleteOnTurnEnd: true })
    await workSteps(interrupted, 1)
    interrupted.step(1, 3, [], { interrupted: true })
    interrupted.append('step/end', { turn: 1, step: 3 })
    interrupted.stopTurn(1)
    assert.equal(interrupted.lastWrite(), PLAN)

    const other = await finishedTurn()
    other.stopTurn(2)
    assert.equal(other.lastWrite(), PLAN)
  })

  it('skips a turn whose last tool step asked the user', async () => {
    const h = harness({ autoCompleteOnTurnEnd: true })
    await workSteps(h, 1, 'ask_user_question')
    h.stopTurn(1)
    assert.equal(h.lastWrite(), PLAN)
  })

  it('completes when the user was asked earlier and work went on', async () => {
    const h = harness({ autoCompleteOnTurnEnd: true })
    await workSteps(h, 1, 'ask_user_question')
    await h.toolStep(1, 3, ['bash'])
    h.stopTurn(1)
    assert.ok(h.lastWrite().every(item => item.status === 'completed'))
  })

  it('does not count work done before the list as work on it', async () => {
    const h = harness({ autoCompleteOnTurnEnd: true })
    h.nextTodos = [{ content: 'First', status: 'in_progress' }, { content: 'Second', status: 'pending' }]
    h.append('turn/start', { turn: 1 })
    await h.toolStep(1, 1, ['bash'])
    await h.toolStep(1, 2, ['todo_write'])
    h.stopTurn(1)
    assert.equal(h.lastWrite(), h.nextTodos)
  })

  it('leaves a complete list and a plan with no work behind it untouched', async () => {
    const complete = harness({ autoCompleteOnTurnEnd: true })
    complete.nextTodos = PLAN.map(item => ({ ...item, status: 'completed' }))
    await workSteps(complete, 1)
    const before = complete.events.length
    complete.stopTurn(1)
    assert.equal(complete.events.length, before)

    const planOnly = harness({ autoCompleteOnTurnEnd: true })
    planOnly.nextTodos = [{ content: 'First', status: 'in_progress' }, { content: 'Second', status: 'pending' }]
    planOnly.append('turn/start', { turn: 1 })
    await planOnly.toolStep(1, 1, ['todo_write'])
    planOnly.stopTurn(1)
    assert.equal(planOnly.lastWrite(), planOnly.nextTodos)
  })

  it('logs instead of throwing when the write is refused', async () => {
    const h = await finishedTurn()
    const append = h.agent.session.append
    h.agent.session.append = (type, data) => {
      if (type === 'todo/write') throw new Error('refused')
      return append(type, data)
    }
    h.stopTurn(1)
    assert.match(h.warnings[0], /could not complete the task list at turn end: refused/)
  })
})

describe('Config', () => {
  it('rejects thresholds below 1', () => {
    assert.throws(() => Config({ stepThreshold: 0 }))
    assert.throws(() => Config({ callThreshold: 0 }))
    assert.throws(() => Config({ stepThreshold: 1.5 }))
  })
})
