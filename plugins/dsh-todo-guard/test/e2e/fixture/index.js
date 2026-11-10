/**
 * End-to-end fixture: registers the scripted `fixture` model, writes the
 * guard's settings through the Settings service (the path the plugin page's
 * form takes), opens one Web conversation, and gives it a task.
 *
 * The model's reply depends on how many assistant messages the request
 * already carries: the first reply writes a three-item task list, the next
 * `config.workSteps` replies each read `notes.txt`, and the last one answers
 * in text without updating the list. Before answering the request that
 * carries `config.retune.replies` replies, it writes `config.retune.patch`
 * through the Settings service while the turn runs. Every request appends one
 * JSON line to `config.record` with its user-role messages.
 */
import { appendFileSync } from 'node:fs'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'todo-guard-fixture'
export const inject = ['llm', 'sessionController', 'appReady', 'settings']

export const TODOS = [
  { content: 'Read the notes', status: 'in_progress' },
  { content: 'Summarize the notes', status: 'pending' },
  { content: 'Report the summary', status: 'pending' },
]

function text(content) {
  return content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function* toolCall(id, name, args) {
  const json = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

class FixtureAdapter extends LlmAdapter {
  constructor(ctx, config) {
    super()
    this.ctx = ctx
    this.config = config
    this.retuned = false
  }

  async resolveModel(provider, model) {
    return { provider, id: model, name: model }
  }

  async * stream(options) {
    const replies = options.messages.filter(message => message.role === 'assistant').length
    appendFileSync(this.config.record, `${JSON.stringify({
      sessionId: options.sessionId,
      replies,
      tools: (options.tools ?? []).map(tool => tool.name),
      users: options.messages.filter(message => message.role === 'user')
        .map(message => ({ source: message.source, text: text(message.content) })),
    })}\n`)
    if (replies === this.config.retune.replies && !this.retuned) {
      this.retuned = true
      await this.ctx.settings.update('todo-guard', this.config.retune.patch)
      appendFileSync(this.config.record, `${JSON.stringify({ retuned: this.config.retune.patch })}\n`)
    }
    if (replies === 0) {
      yield* toolCall('todo-1', 'todo_write', { todos: TODOS })
      return
    }
    if (replies <= this.config.workSteps) {
      yield* toolCall(`read-${replies}`, 'read', { file_path: this.config.notes })
      return
    }
    const answer = 'Done.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx, config) {
  ctx.llm.registerAdapter(['fixture'], new FixtureAdapter(ctx, config))
  ctx.effect(() => ctx.appReady.onReady(() => {
    void (async () => {
      await ctx.settings.update('todo-guard', config.settings)
      const { sessionId } = await ctx.sessionController.create({ cwd: config.cwd })
      const resolved = await ctx.sessionController.resolveAgent(sessionId)
      if ('error' in resolved) throw resolved.error
      resolved.agent.model.select({ provider: 'fixture', model: 'fixture' })
      resolved.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read the notes and report.' }], source: { kind: 'user' } }))
      appendFileSync(config.record, `${JSON.stringify({ created: sessionId })}\n`)
    })().catch((error) => {
      appendFileSync(config.record, `${JSON.stringify({ error: String(error?.stack ?? error) })}\n`)
    })
  }))
}
