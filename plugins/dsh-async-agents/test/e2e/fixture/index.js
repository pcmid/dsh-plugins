/**
 * End-to-end fixture: registers the scripted `fixture` model, opens one Web
 * conversation, and gives it a task that makes it delegate.
 *
 * The model answers by role. The conversation's own agent is `lead`; a
 * subagent is known by the `ROLE:` word of its task. A role decides its next
 * step from what its request shows: the tool calls it made with their
 * results, and the notices it was sent. Notices reach a running agent and an
 * idle one at different points, so a count of replies would not do. What the
 * lead does also depends on whether the DSH under test can close a subagent,
 * which the fixture reports before it starts. Every request appends one JSON
 * line to `config.record` with the tools the model was given, its call
 * history, and the user messages it holds.
 */
import { appendFileSync } from 'node:fs'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'async-agents-fixture'
export const inject = ['llm', 'sessionController', 'appReady', 'subagents']

function text(content) {
  return content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** The tool calls a request's history holds, each with the result the agent got for it. */
function callsOf(messages) {
  const results = new Map()
  for (const message of messages) {
    if (message.role === 'tool') results.set(message.toolCallId, { isError: message.isError === true, text: text(message.content) })
  }
  return messages.filter(message => message.role === 'assistant')
    .flatMap(message => message.content.filter(block => block.type === 'tool-call'))
    .map(block => ({ name: block.name, args: JSON.parse(block.arguments), result: results.get(block.id) }))
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
const succeeded = call => call.result !== undefined && !call.result.isError

class FixtureAdapter extends LlmAdapter {
  constructor(config, closes) {
    super()
    this.config = config
    this.closes = closes
    this.lead = undefined
  }

  async resolveModel(provider, model) {
    return { provider, id: model, name: model }
  }

  /** What one role does next: a tool call as `[name, args]`, or the text that ends its turn. */
  next(role, calls, users) {
    const told = start => users.some(user => user.text.startsWith(start))
    if (role === 'server') {
      return calls.length === 0
        ? ['bash', { command: this.config.server, description: 'Start the dev server', run_in_background: true }]
        : 'The dev server is running in the background.'
    }
    if (role === 'tester') {
      return calls.length === 0 ? ['bash', { command: 'echo tests passed', description: 'Run the tests' }] : 'The tests pass.'
    }
    const delegations = to => calls.filter(call => call.name === 'subagent' && call.args.name === to)
    if (delegations('server').length === 0) return delegate('server', 'Start the dev server')
    // A DSH that cannot close a subagent unloads the server when its turn ends, and says so.
    if (!this.closes) return told('Background subagent server finished') ? 'All done.' : 'The server is starting.'
    const tester = delegations('tester')
    if (tester.some(succeeded)) return told('Background subagent tester finished') ? 'All done.' : 'The tester is running.'
    const closing = calls.filter(call => call.name === 'close_agent')
    if (closing.some(succeeded)) return delegate('tester', 'Run the tests')
    if (closing.length > 0) return 'The server could not be closed.'
    // The server keeps the one slot for its job, so the first delegation fails at the limit.
    if (tester.length > 0) return ['close_agent', { agent: 'server' }]
    return told('Background subagent server ended its turn. Work it started is still running.')
      ? delegate('tester', 'Run the tests')
      : 'The server is starting.'
  }

  async * stream(options) {
    const users = options.messages.filter(message => message.role === 'user')
      .map(message => ({ source: message.source, text: text(message.content) }))
    // The task is not always the first user message: the host may put context of its own before it.
    const role = options.sessionId === this.lead
      ? 'lead'
      : users.map(user => /ROLE:(\w+)/.exec(user.text)?.[1]).find(found => found !== undefined) ?? 'unknown'
    const calls = callsOf(options.messages)
    const tools = options.tools ?? []
    const parametersOf = toolName => tools.find(tool => tool.name === toolName)?.parameters?.properties ?? {}
    const action = this.next(role, calls, users)
    appendFileSync(this.config.record, `${JSON.stringify({
      sessionId: options.sessionId,
      role,
      action,
      calls,
      tools: tools.map(tool => tool.name),
      bashWait: parametersOf('bash').timeoutMs?.description,
      jobOutputParameters: Object.keys(parametersOf('job_output')),
      system: text(options.messages.find(message => message.role === 'system')?.content ?? []),
      users,
    })}\n`)
    if (typeof action === 'string') yield* say(action)
    else yield* toolCall(`${role}-${calls.length}`, ...action)
  }
}

export function apply(ctx, config) {
  const closes = typeof ctx.subagents.closeDescendant === 'function'
  const adapter = new FixtureAdapter(config, closes)
  ctx.llm.registerAdapter(['fixture'], adapter)
  ctx.effect(() => ctx.appReady.onReady(() => {
    void (async () => {
      const { sessionId } = await ctx.sessionController.create({ cwd: config.cwd })
      const resolved = await ctx.sessionController.resolveAgent(sessionId)
      if ('error' in resolved) throw resolved.error
      adapter.lead = sessionId
      resolved.agent.model.select({ provider: 'fixture', model: 'fixture' })
      appendFileSync(config.record, `${JSON.stringify({ created: sessionId, closes })}\n`)
      resolved.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Start the dev server, then run the tests.' }], source: { kind: 'user' } }))
    })().catch((error) => {
      appendFileSync(config.record, `${JSON.stringify({ error: String(error?.stack ?? error) })}\n`)
    })
  }))
}
