/**
 * End-to-end fixture: registers the scripted `fixture` model, opens one Web
 * conversation with a goal, and gives it a task that makes it delegate twice.
 *
 * The model answers by role. The conversation's own agent is `lead`; a
 * subagent is known by the `ROLE:` word of its task.
 *
 * - `lead` delegates `server`, then `tester`, and ends its turn.
 * - `server` starts a background command that never ends and ends its turn.
 * - `tester` runs a foreground command that lasts as long as the check needs.
 *
 * Every request appends one JSON line to `config.record` with the role, what
 * it does next, and the user messages its request holds.
 */
import { appendFileSync } from 'node:fs'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'agent-monitor-fixture'
export const inject = ['llm', 'sessionController', 'appReady', 'goals']

function text(content) {
  return content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** The tool calls a request's history holds. */
function callsOf(messages) {
  return messages.filter(message => message.role === 'assistant')
    .flatMap(message => message.content.filter(block => block.type === 'tool-call'))
    .map(block => ({ name: block.name, args: JSON.parse(block.arguments) }))
}

function* toolCall(id, name, args) {
  const json = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

function* say(answer) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: answer }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

const delegate = (role, description) => ['subagent', { description, name: role, prompt: `ROLE:${role} ${description} and report.` }]

class FixtureAdapter extends LlmAdapter {
  constructor(config) {
    super()
    this.config = config
    this.lead = undefined
  }

  async resolveModel(provider, model) {
    return { provider, id: model, name: model }
  }

  /** What one role does next: a tool call as `[name, args]`, or the text that ends its turn. */
  next(role, calls) {
    const { server, tests } = this.config
    if (role === 'server') {
      return calls.length === 0
        ? ['bash', { command: server, description: 'Start the dev server', run_in_background: true }]
        : 'The dev server is running in the background.'
    }
    if (role === 'tester') {
      return calls.length === 0
        ? ['bash', { command: tests, description: 'Run the test suite', timeoutMs: 60000 }]
        : 'The tests are done.'
    }
    const delegated = to => calls.some(call => call.name === 'subagent' && call.args.name === to)
    if (!delegated('server')) return delegate('server', 'Start the dev server')
    if (!delegated('tester')) return delegate('tester', 'Run the test suite')
    return 'The server and the tester are at work.'
  }

  async * stream(options) {
    const users = options.messages.filter(message => message.role === 'user').map(message => text(message.content))
    // The task is not always the first user message: the host may put context of its own before it.
    const role = options.sessionId === this.lead
      ? 'lead'
      : users.map(user => /ROLE:(\w+)/.exec(user)?.[1]).find(found => found !== undefined) ?? 'unknown'
    const calls = callsOf(options.messages)
    const action = this.next(role, calls)
    appendFileSync(this.config.record, `${JSON.stringify({ sessionId: options.sessionId, role, action, users })}\n`)
    if (typeof action === 'string') yield* say(action)
    else yield* toolCall(`${role}-${calls.length}`, ...action)
  }
}

export function apply(ctx, config) {
  const adapter = new FixtureAdapter(config)
  ctx.llm.registerAdapter(['fixture'], adapter)
  ctx.effect(() => ctx.appReady.onReady(() => {
    void (async () => {
      const { sessionId } = await ctx.sessionController.create({ cwd: config.cwd })
      const resolved = await ctx.sessionController.resolveAgent(sessionId)
      if ('error' in resolved) throw resolved.error
      adapter.lead = sessionId
      resolved.agent.model.select({ provider: 'fixture', model: 'fixture' })
      ctx.goals.create(resolved.agent, { objective: 'Keep the server running and the tests green' })
      appendFileSync(config.record, `${JSON.stringify({ created: sessionId })}\n`)
      resolved.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Start the dev server, then run the tests.' }], source: { kind: 'user' } }))
    })().catch((error) => {
      appendFileSync(config.record, `${JSON.stringify({ error: String(error?.stack ?? error) })}\n`)
    })
  }))
}
