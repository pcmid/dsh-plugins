/**
 * End-to-end fixture: registers the scripted `fixture` model and, in the
 * `start` phase, opens one Web conversation and gives it a task.
 *
 * Every model request appends one JSON line to `config.record`. Lead requests
 * in the `start` and `hang` phases never finish, so the turn is still running
 * when the test stops the process; in the `continue` phase they answer at once.
 * With `spawn`, the first lead request starts one subagent, whose requests
 * always hang, and the lead then ends its turn while the subagent works.
 */
import { appendFileSync } from 'node:fs'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'auto-restart-fixture'
export const inject = ['llm', 'sessionController', 'sessions', 'appReady']

function text(content) {
  return content.filter(block => block.type === 'text').map(block => block.text).join('')
}

class FixtureAdapter extends LlmAdapter {
  constructor(ctx, config) {
    super()
    this.ctx = ctx
    this.config = config
  }

  async resolveModel(provider, model) {
    return { provider, id: model, name: model }
  }

  record(entry) {
    appendFileSync(this.config.record, `${JSON.stringify({ phase: this.config.phase, pid: process.pid, ...entry })}\n`)
  }

  async * stream(options) {
    const session = options.sessionId === undefined ? undefined : this.ctx.sessions.get(options.sessionId)
    const child = session?.header.origin === 'subagent'
    const users = options.messages
      .filter(message => message.role === 'user')
      .map(message => ({ kind: message.source?.kind, attempt: message.source?.attempt, text: text(message.content).slice(0, 4000) }))
    const last = options.messages.at(-1)
    this.record({
      sessionId: options.sessionId,
      child,
      lastRole: last?.role,
      users,
      tools: (options.tools ?? []).map(tool => tool.name),
    })
    // The first lead request of a conversation has no assistant history yet.
    if (this.config.spawn && !child && !options.messages.some(message => message.role === 'assistant')) {
      const tool = this.config.spawn.tool
      const args = JSON.stringify(this.config.spawn.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: 'spawn-1', name: tool, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'spawn-1', name: tool, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const answer = child || this.config.phase === 'start' || this.config.phase === 'hang'
      ? (this.config.spawn && !child && last?.role === 'tool' ? 'Subagent started; waiting for it.' : undefined)
      : 'Continued after the restart.'
    if (answer === undefined) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      await new Promise((resolve) => {
        options.signal?.addEventListener('abort', resolve, { once: true })
      })
      yield { type: 'finish', reason: { kind: 'aborted' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx, config) {
  ctx.llm.registerAdapter(['fixture'], new FixtureAdapter(ctx, config))
  if (config.phase !== 'start') return
  ctx.effect(() => ctx.appReady.onReady(() => {
    void (async () => {
      const { sessionId } = await ctx.sessionController.create({ cwd: config.cwd })
      const resolved = await ctx.sessionController.resolveAgent(sessionId)
      if ('error' in resolved) throw resolved.error
      const agent = resolved.agent
      agent.model.select({ provider: 'fixture', model: 'fixture' })
      if (config.goal) ctx.get('goals').create(agent, { objective: 'Finish the long report.', maxGoalRounds: 3 })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Write the long report.' }], source: { kind: 'user' } }))
      appendFileSync(config.record, `${JSON.stringify({ phase: 'start', pid: process.pid, created: sessionId })}\n`)
    })().catch((error) => {
      appendFileSync(config.record, `${JSON.stringify({ phase: 'start', pid: process.pid, error: String(error?.stack ?? error) })}\n`)
    })
  }))
}
