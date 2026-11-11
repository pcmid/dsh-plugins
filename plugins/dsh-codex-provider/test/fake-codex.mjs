// A small in-memory Codex app-server: threads, turns, dynamic tool calls and raw response events.
// Each turn samples the next scripted model output and records the input the model would see.

export const reasoning = (id, summary, encrypted = `ENC-${id}`) => ({ type: 'reasoning', id, summary: [{ type: 'summary_text', text: summary }], encrypted_content: encrypted })
export const message = (id, text) => ({ type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text }] })
export const call = (id, name, args = {}) => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) })
// A code-mode `exec` script that calls DSH tools; Codex sends only the tool requests.
export const exec = (id, calls) => ({ type: 'custom_tool_call', id: `ctc_${id}`, call_id: id, name: 'exec', input: 'await tools.run()', calls })
export const usage = { inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 4, totalTokens: 110 }

export class FakeCodex {
  constructor(script = [], { models } = {}) {
    this.script = script
    this.models = models ?? [{ model: 'gpt-test', displayName: 'GPT Test', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }, { reasoningEffort: 'high', description: 'Deep' }], defaultReasoningEffort: 'high' }]
    this.threads = new Map()
    this.samples = []
    this.calls = []
    this.answers = []
    this.listeners = new Map()
    this.sequence = 0
    this.failure = undefined
    this.closed = new Promise(resolve => { this.resolveClosed = resolve })
  }

  async initialize(clientInfo) {
    this.clientInfo = clientInfo
    return {}
  }

  emit(thread, method, params) {
    this.listeners.get(thread.id)?.({ method, params: { threadId: thread.id, ...params } })
  }

  async request(method, params) {
    if (this.failure) throw this.failure
    this.calls.push({ method, params })
    const thread = this.threads.get(params?.threadId)
    switch (method) {
      case 'config/read': return { config: this.config ?? {} }
      case 'model/list': return { data: this.models, nextCursor: null }
      case 'thread/start': {
        const id = `thread-${this.threads.size + 1}`
        this.threads.set(id, { id, params, history: [], turn: undefined, interrupted: 0, unsubscribed: false })
        return { thread: { id } }
      }
      case 'thread/inject_items':
        if (thread.turn) thread.turn.queued.push(...params.items)
        else thread.history.push(...params.items)
        return {}
      case 'turn/start': {
        thread.turn = { id: `turn-${++this.sequence}`, pending: new Map(), queued: [] }
        thread.effort = params.effort
        setImmediate(() => this.sample(thread))
        return { turn: { id: thread.turn.id } }
      }
      case 'turn/interrupt':
        if (thread.turn?.id === params.turnId) {
          thread.interrupted++
          const turnId = thread.turn.id
          thread.turn = undefined
          this.emit(thread, 'turn/completed', { turn: { id: turnId, status: 'interrupted' } })
        }
        return {}
      case 'thread/unsubscribe':
        thread.unsubscribed = true
        return { status: 'unsubscribed' }
      default:
        throw new Error(`Unexpected request ${method}`)
    }
  }

  sample(thread) {
    const turn = thread.turn
    if (!turn) return
    const output = this.script.shift() ?? [message('msg_default', 'default')]
    this.samples.push({ threadId: thread.id, input: structuredClone(thread.history), tools: thread.params.dynamicTools.map(tool => tool.name) })
    const at = { turnId: turn.id }
    if (output.hang) return
    if (output.error) {
      this.emit(thread, 'error', { ...at, error: output.error, willRetry: false })
      thread.turn = undefined
      this.emit(thread, 'turn/completed', { turn: { id: turn.id, status: 'failed', error: output.error } })
      return
    }
    const known = new Set(thread.params.dynamicTools.map(tool => tool.name))
    const native = []
    for (const entry of output) {
      const { calls: _calls, ...item } = entry
      if (item.type === 'message') {
        if (!item.silent) this.emit(thread, 'item/agentMessage/delta', { ...at, itemId: item.id, delta: item.content[0].text })
        this.emit(thread, 'item/completed', { ...at, item: { type: 'agentMessage', id: item.id, text: item.content[0].text } })
      } else if (item.type === 'reasoning') {
        this.emit(thread, 'item/reasoning/summaryTextDelta', { ...at, itemId: item.id, delta: item.summary[0].text, summaryIndex: 0 })
        this.emit(thread, 'item/completed', { ...at, item: { type: 'reasoning', id: item.id, summary: [item.summary[0].text], content: [] } })
      }
      this.emit(thread, 'rawResponseItem/completed', { ...at, item })
      thread.history.push(item)
    }
    this.emit(thread, 'rawResponse/completed', { ...at, responseId: `resp-${this.samples.length}`, usage })
    for (const script of output.filter(item => item.calls)) {
      for (const nested of script.calls) {
        const id = ++this.sequence
        turn.pending.set(id, { callId: nested.id, script: script.call_id })
        this.listeners.get(thread.id)?.({ id, method: 'item/tool/call', params: { threadId: thread.id, turnId: turn.id, callId: nested.id, namespace: null, tool: nested.name, arguments: nested.args ?? {} } })
      }
    }
    for (const item of output.filter(item => item.type === 'function_call')) {
      let valid = true
      try { JSON.parse(item.arguments) } catch { valid = false }
      if (known.has(item.name) && valid) {
        const id = ++this.sequence
        turn.pending.set(id, { callId: item.call_id })
        this.listeners.get(thread.id)?.({ id, method: 'item/tool/call', params: { threadId: thread.id, turnId: turn.id, callId: item.call_id, namespace: null, tool: item.name, arguments: JSON.parse(item.arguments) } })
      } else {
        native.push({ type: 'function_call_output', call_id: item.call_id, output: valid ? `unsupported call: ${item.name}` : 'failed to parse function arguments' })
      }
    }
    for (const item of native) {
      thread.history.push(item)
      this.emit(thread, 'rawResponseItem/completed', { ...at, item })
    }
    if (turn.pending.size) return
    if (native.length) return setImmediate(() => this.sample(thread))
    thread.turn = undefined
    this.emit(thread, 'turn/completed', { turn: { id: turn.id, status: 'completed' } })
  }

  respond(id, body) {
    this.answers.push({ id, ...body })
    for (const thread of this.threads.values()) {
      const turn = thread.turn
      const pending = turn?.pending.get(id)
      if (pending === undefined) continue
      turn.pending.delete(id)
      const text = body.result.contentItems.map(item => item.text).join('')
      if (pending.script) {
        (turn.scripts ??= new Map()).set(pending.script, [...(turn.scripts.get(pending.script) ?? []), text])
      } else {
        const output = { type: 'function_call_output', call_id: pending.callId, output: text }
        thread.history.push(output)
        this.emit(thread, 'rawResponseItem/completed', { turnId: turn.id, item: output })
      }
      if (!turn.pending.size) {
        for (const [script, texts] of turn.scripts ?? []) {
          const output = { type: 'custom_tool_call_output', call_id: script, output: texts.join('\n') }
          thread.history.push(output)
          this.emit(thread, 'rawResponseItem/completed', { turnId: turn.id, item: output })
        }
        turn.scripts = undefined
        thread.history.push(...turn.queued)
        turn.queued = []
        setImmediate(() => this.sample(thread))
      }
    }
  }

  subscribe(threadId, listener) {
    this.listeners.set(threadId, listener)
    return () => this.listeners.delete(threadId)
  }

  crash(error = new Error('Codex app-server exited (1)')) {
    this.failure = error
    for (const listener of this.listeners.values()) listener({ method: 'connection/failed', params: { error } })
    this.listeners.clear()
    this.resolveClosed()
  }

  async close() {
    this.isClosed = true
    if (!this.failure) this.failure = new Error('Codex app-server closed')
    this.resolveClosed()
  }
}

/** A connect factory that hands out FakeCodex instances and records them. */
export function fakes(...scripts) {
  const instances = []
  const factory = { instances, config: {} }
  factory.connect = (executable, args, options) => {
    const fake = new FakeCodex(scripts[instances.length] ?? [])
    Object.assign(fake, { executable, args, options, config: factory.config })
    instances.push(fake)
    return fake
  }
  return factory
}
