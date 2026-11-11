import { LlmError, EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm'
import { declineServerRequest } from './app-server.js'
import { isOutputItem, projectHistory, toolResultText } from './history.js'

const INPUT_ROLES = new Set(['user', 'developer', 'system'])

/**
 * Decide how a request continues a live thread. The thread must already hold exactly the
 * request's earlier messages and the assistant message of its last step; what follows must be
 * either the DSH results for the tool calls Codex is waiting on (then optional new input) or,
 * after a completed turn, new input only.
 * @param state - the conversation's committed state.
 * @param request - the prepared request.
 * @returns `{ kind: 'tools', results, extra }`, `{ kind: 'turn', extra }`, or `undefined` to rebuild.
 */
export function planContinuation(state, request) {
  if (request.spec !== state.spec) return undefined
  const committed = state.committed
  if (request.keys.length <= committed.length) return undefined
  for (let i = 0; i < committed.length; i++) if (request.keys[i] !== committed[i]) return undefined
  const assistant = request.messages[committed.length]
  const marker = assistant.source?.provider === request.provider ? assistant.source?.replayState?.response?.codex : undefined
  if (assistant.role !== 'assistant' || marker?.thread !== state.threadId || marker?.step !== state.step) return undefined
  const tail = request.messages.slice(committed.length + 1)
  if (state.awaiting) {
    if (request.effort !== state.effort) return undefined
    const calls = assistant.content.filter(block => block.type === 'tool-call').map(block => block.id)
    const results = tail.slice(0, state.awaiting.size)
    const answered = new Set(results.map(message => message.role === 'tool' ? message.toolCallId : undefined))
    if (calls.length !== state.awaiting.size || !calls.every(id => state.awaiting.has(id))) return undefined
    if (answered.size !== state.awaiting.size || ![...answered].every(id => state.awaiting.has(id))) return undefined
    const extra = tail.slice(state.awaiting.size)
    return extra.every(message => INPUT_ROLES.has(message.role)) ? { kind: 'tools', results, extra } : undefined
  }
  return tail.length && tail.every(message => INPUT_ROLES.has(message.role)) ? { kind: 'turn', extra: tail } : undefined
}

/** A failed Codex turn, carrying Codex's error classification. */
export class CodexTurnError extends Error {
  constructor(error) {
    super(error?.message || 'Codex generation failed')
    this.name = 'CodexTurnError'
    this.info = error?.codexErrorInfo ?? undefined
  }
}

class Blocks {
  constructor() {
    this.next = 0
    this.count = 0
    this.open = new Map()
    this.done = new Set()
  }

  *delta(key, type, text, part) {
    if (this.done.has(key) || !text) return
    let entry = this.open.get(key)
    if (!entry) {
      entry = { index: this.next++, block: { type, text: '' }, part }
      this.open.set(key, entry)
      yield { type: 'block-start', index: entry.index, blockType: type }
    } else if (part !== entry.part) {
      entry.part = part
      if (entry.block.text) text = `\n\n${text}`
    }
    entry.block.text += text
    yield { type: `${type}-delta`, index: entry.index, text }
  }

  *end(key, type, fallback) {
    const entry = this.open.get(key)
    if (entry) {
      this.open.delete(key)
      this.done.add(key)
      this.count++
      yield { type: 'block-end', index: entry.index, block: entry.block }
    } else if (!this.done.has(key) && fallback) {
      this.done.add(key)
      yield* this.complete({ type, text: fallback })
    }
  }

  *endAll() {
    for (const [key, entry] of [...this.open]) yield* this.end(key, entry.block.type)
  }

  *complete(block) {
    const index = this.next++
    this.count++
    yield { type: 'block-start', index, blockType: block.type }
    if (block.type === 'tool-call') {
      yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments }
    } else {
      yield { type: `${block.type}-delta`, index, text: block.text }
    }
    yield { type: 'block-end', index, block }
  }
}

function addUsage(total, usage) {
  const cached = usage.cachedInputTokens ?? 0
  const written = usage.cacheWriteInputTokens ?? 0
  total.inputTokens += Math.max(0, usage.inputTokens - cached - written)
  total.outputTokens += usage.outputTokens
  total.cacheReadTokens += cached
  total.cacheWriteTokens += written
  total.reasoningTokens += usage.reasoningOutputTokens ?? 0
}

// Code-mode scripts that start several DSH tools at once (Promise.all) send their calls back to
// back; collect them into one DSH step instead of one step per call.
const NESTED_CALL_SETTLE_MS = 25

const delay = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', abort)
    resolve()
  }, ms)
  const abort = () => {
    clearTimeout(timer)
    reject(signal.reason)
  }
  signal.addEventListener('abort', abort, { once: true })
})

const parses = text => {
  try {
    JSON.parse(text)
    return true
  } catch {
    // Codex answers unparsable arguments itself and never asks DSH to run the call.
    return false
  }
}

/**
 * One Codex thread kept for one DSH session. Between DSH steps the thread stays in its turn with
 * the DSH tool calls unanswered; the next step answers them with the real DSH results, so the
 * thread keeps its history, encrypted reasoning and prompt-cache identity.
 */
export class Conversation {
  /**
   * @param connection - the app-server connection that owns the thread.
   * @param threadId - Codex thread id.
   * @param request - the prepared request that started the thread.
   * @param onUsageWindow - receives `(model, contextWindow)` when Codex reports the model window.
   */
  constructor(connection, threadId, request, onUsageWindow) {
    this.connection = connection
    this.threadId = threadId
    this.spec = request.spec
    this.model = request.model
    this.names = request.names
    this.provider = request.provider
    this.effort = request.effort
    this.onUsageWindow = onUsageWindow
    this.committed = []
    this.step = 0
    this.turnId = undefined
    this.turnActive = false
    this.awaiting = undefined
    this.requested = new Map()
    this.dshCalls = new Set()
    this.events = []
    this.wake = undefined
    this.busy = false
    this.broken = false
    this.disposed = false
    this.idleTimer = undefined
    this.unsubscribe = connection.subscribe(threadId, message => this.receive(message))
  }

  receive(message) {
    const p = message.params ?? {}
    if (message.method === 'item/tool/call' && message.id !== undefined) {
      if (p.namespace == null && this.names.toDsh.has(p.tool)) {
        this.requested.set(p.callId, message.id)
        this.push({ method: 'tool/requested', params: { turnId: p.turnId, callId: p.callId, tool: p.tool, arguments: p.arguments } })
      } else {
        this.connection.respond(message.id, { result: { success: false, contentItems: [{ type: 'inputText', text: `Unknown tool: ${p.tool}` }] } })
      }
      return
    }
    if (message.id !== undefined) {
      this.connection.respond(message.id, declineServerRequest(message))
      return
    }
    if (message.method === 'connection/failed') this.broken = true
    if (message.method === 'thread/tokenUsage/updated' && p.tokenUsage?.modelContextWindow) {
      this.onUsageWindow?.(this.model, p.tokenUsage.modelContextWindow)
    }
    this.push(message)
  }

  push(message) {
    this.events.push(message)
    this.wake?.()
  }

  next(signal) {
    if (this.events.length) return Promise.resolve(this.events.shift())
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.wake = undefined
        reject(signal.reason)
      }
      signal.addEventListener('abort', abort, { once: true })
      this.wake = () => {
        this.wake = undefined
        signal.removeEventListener('abort', abort)
        resolve(this.events.shift())
      }
    })
  }

  /**
   * Send the request's new content and start or resume generation.
   * @param plan - `start` (fresh thread), `turn`, or `tools`, from {@link planContinuation}.
   * @param request - the prepared request.
   */
  async begin(plan, request) {
    const items = projectHistory(plan.kind === 'start' ? request.messages : plan.extra, request.provider, this.names.toWire)
    if (items.length) await this.connection.request('thread/inject_items', { threadId: this.threadId, items })
    if (plan.kind === 'tools') {
      // Codex queues injected input during a turn and records it after these tool outputs.
      for (const message of plan.results) {
        this.connection.respond(this.awaiting.get(message.toolCallId), { result: {
          success: !message.isError, contentItems: [{ type: 'inputText', text: toolResultText(message) }],
        } })
        this.requested.delete(message.toolCallId)
      }
      this.awaiting = undefined
      return
    }
    this.awaiting = undefined
    this.effort = request.effort
    const { turn } = await this.connection.request('turn/start', {
      threadId: this.threadId, input: [], ...(request.effort ? { effort: request.effort } : {}),
    })
    this.turnId = turn.id
    this.turnActive = true
  }

  /**
   * Stream one DSH step: until Codex waits on DSH tool calls, or the turn completes.
   * @param request - the prepared request; its message keys become the committed history.
   * @param signal - aborts the read.
   * @returns DSH stream chunks.
   */
  async *read(request, signal) {
    const blocks = new Blocks()
    const items = []
    const batch = []
    // DSH tools called from a code-mode `exec` script arrive only as tool requests, with no
    // function_call item of their own.
    const nested = []
    let settled = 0
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
    let reported = false
    let responseDone = false
    const finish = function* (kind) {
      yield* blocks.endAll()
      if (!blocks.count) throw new LlmError('Codex returned an empty response', EMPTY_RESPONSE_CODE)
      if (reported) yield { type: 'usage', usage }
      this.step++
      this.committed = request.keys
      this.awaiting = kind === 'tool-calls' ? new Map(batch.map(id => [id, this.requested.get(id)])) : undefined
      yield { type: 'finish', reason: { kind },
        replayState: { response: { codex: { thread: this.threadId, step: this.step, items, ...(nested.length ? { nested } : {}) } } } }
    }.bind(this)
    while (true) {
      const ready = responseDone && batch.length && batch.every(id => this.requested.has(id))
      if (ready && nested.length && !this.events.length && settled !== batch.length) {
        settled = batch.length
        await delay(NESTED_CALL_SETTLE_MS, signal)
        continue
      }
      if (ready && !(nested.length && this.events.length)) {
        yield* finish('tool-calls')
        return
      }
      const message = await this.next(signal)
      const p = message.params ?? {}
      if (message.method === 'connection/failed') throw p.error
      if ((p.turnId ?? p.turn?.id) !== this.turnId) continue
      switch (message.method) {
        case 'item/agentMessage/delta':
          responseDone = false
          yield* blocks.delta(`text:${p.itemId}`, 'text', p.delta)
          break
        case 'item/reasoning/summaryTextDelta':
          responseDone = false
          yield* blocks.delta(`reasoning:${p.itemId}`, 'reasoning', p.delta, p.summaryIndex)
          break
        case 'item/reasoning/textDelta':
          responseDone = false
          yield* blocks.delta(`reasoning:${p.itemId}`, 'reasoning', p.delta, `content:${p.contentIndex}`)
          break
        case 'item/completed':
          if (p.item.type === 'agentMessage') yield* blocks.end(`text:${p.item.id}`, 'text', p.item.text)
          if (p.item.type === 'reasoning') yield* blocks.end(`reasoning:${p.item.id}`, 'reasoning', p.item.summary?.join('\n\n'))
          break
        case 'rawResponseItem/completed': {
          const item = p.item
          // Input echoes (DSH messages Codex recorded) belong to DSH history, not to this response.
          if (item.type === 'message' && item.role !== 'assistant') break
          if (isOutputItem(item)) {
            // Codex echoes the DSH results it received; they are already DSH tool messages.
            if (batch.includes(item.call_id)) throw new Error(`Codex answered DSH tool call ${item.call_id} itself`)
            if (!this.dshCalls.has(item.call_id)) items.push(item)
            break
          }
          responseDone = false
          items.push(item)
          const name = item.type === 'function_call' && item.namespace == null ? this.names.toDsh.get(item.name) : undefined
          if (nested.includes(item.call_id)) {
            // The tool request overtook its function_call item: the call is direct after all.
            nested.splice(nested.indexOf(item.call_id), 1)
          } else if (name !== undefined && typeof item.arguments === 'string' && parses(item.arguments)) {
            yield* blocks.endAll()
            yield* blocks.complete({ type: 'tool-call', id: item.call_id, name, arguments: item.arguments })
            batch.push(item.call_id)
            this.dshCalls.add(item.call_id)
          }
          break
        }
        case 'tool/requested':
          if (!batch.includes(p.callId) && !this.dshCalls.has(p.callId)) {
            yield* blocks.endAll()
            yield* blocks.complete({ type: 'tool-call', id: p.callId, name: this.names.toDsh.get(p.tool), arguments: JSON.stringify(p.arguments ?? {}) })
            batch.push(p.callId)
            nested.push(p.callId)
            this.dshCalls.add(p.callId)
          }
          break
        case 'rawResponse/completed':
          if (p.usage) {
            addUsage(usage, p.usage)
            reported = true
          }
          responseDone = true
          yield* blocks.endAll()
          break
        case 'error':
          if (!p.willRetry) throw new CodexTurnError(p.error)
          break
        case 'turn/completed':
          this.turnActive = false
          if (p.turn.status === 'completed') {
            if (batch.length) throw new Error('Codex completed the turn without waiting for DSH tool results')
            yield* finish('stop')
            return
          }
          if (p.turn.status === 'interrupted') throw new DOMException('Codex turn interrupted', 'AbortError')
          throw new CodexTurnError(p.turn.error)
      }
    }
  }

  /** Arm the idle timer; `onIdle` runs once if the conversation is not used again in time. */
  idle(ms, onIdle) {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(onIdle, ms)
    this.idleTimer.unref?.()
  }

  /** Stop any active turn and release the thread. Codex unloads it after its own delay. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.broken = true
    clearTimeout(this.idleTimer)
    this.unsubscribe()
    const ignore = () => {
      // The thread or the whole process may already be gone; nothing remains to release.
    }
    if (this.turnActive) {
      this.connection.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(ignore)
    }
    this.connection.request('thread/unsubscribe', { threadId: this.threadId }).catch(ignore)
  }
}
