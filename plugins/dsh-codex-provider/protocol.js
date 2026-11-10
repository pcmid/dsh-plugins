import { createHash } from 'node:crypto'

// Keep names stable across history rewrites and distinct from every native Codex tool.
export function wireName(name) {
  return `dsh_${createHash('sha256').update(name).digest('hex').slice(0, 40)}`
}

function textContent(content) {
  return content.map(block => {
    if (block.type !== 'text') throw new Error(`Codex bridge expects projected text; unsupported block: ${block.type}`)
    return block.text
  }).join('\n')
}

export function projectRequest(options) {
  const instructions = [options.system ?? '']
  const items = []
  for (const message of options.messages) {
    if (message.role === 'system') {
      instructions.push(textContent(message.content))
      continue
    }
    if (message.role === 'tool') {
      items.push({ type: 'function_call_output', call_id: message.toolCallId,
        output: `${message.isError ? 'Tool failed:\n' : ''}${textContent(message.content)}` })
      continue
    }
    let content = []
    const flush = () => {
      if (content.length) items.push({ type: 'message', role: message.role, content })
      content = []
    }
    for (const block of message.content) {
      if (block.type === 'text') {
        content.push({ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: block.text })
      } else if (block.type === 'tool-call' && message.role === 'assistant') {
        flush()
        items.push({ type: 'function_call', call_id: block.id, name: wireName(block.name), arguments: block.arguments })
      } else if (block.type !== 'reasoning') {
        throw new Error(`Codex bridge expects projected text; unsupported block: ${block.type}`)
      }
    }
    flush()
  }
  const names = new Map()
  const dynamicTools = (options.tools ?? []).map(tool => {
    const name = wireName(tool.name)
    if (names.has(name)) throw new Error(`Duplicate DSH tool: ${tool.name}`)
    names.set(name, tool.name)
    return { type: 'function', name, description: tool.description, inputSchema: tool.parameters }
  })
  return { instructions: instructions.filter(Boolean).join('\n\n'), items, names, dynamicTools }
}

export function usageChunk(usage) {
  return { type: 'usage', usage: {
    inputTokens: Math.max(0, usage.inputTokens - (usage.cachedInputTokens ?? 0) - (usage.cacheWriteInputTokens ?? 0)),
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cachedInputTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteInputTokens ?? 0,
    reasoningTokens: usage.reasoningOutputTokens ?? 0,
  } }
}

export function* completeBlock(index, block) {
  yield { type: 'block-start', index, blockType: block.type }
  if (block.type === 'tool-call') {
    yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments }
  } else {
    yield { type: `${block.type}-delta`, index, text: block.text }
  }
  yield { type: 'block-end', index, block }
}

// This consumes exactly ONE upstream model response, before Codex can run another step.
export async function* readStep(rpc, threadId, turnId, names) {
  let index = 0
  const blocks = new Map()
  const ended = new Set()
  const calls = new Set()
  const blockFor = (key, type) => {
    if (!blocks.has(key)) blocks.set(key, { index: index++, block: { type, text: '' }, started: false })
    return blocks.get(key)
  }
  const finishText = function* () {
    for (const [key, entry] of blocks) {
      if (entry.started) yield { type: 'block-end', index: entry.index, block: entry.block }
      ended.add(key)
    }
    blocks.clear()
  }
  while (true) {
    const message = await rpc.next()
    const p = message.params ?? {}
    if (message.id !== undefined) {
      // Leave dynamic calls unanswered. DSH executes them AFTER this stream ends.
      if (message.method === 'item/tool/call' && p.threadId === threadId && names.has(p.tool)) continue
      throw new Error(`Unexpected Codex server request: ${message.method}; only DSH tools are allowed`)
    }
    if (p.threadId !== threadId || (p.turnId ?? p.turn?.id) !== turnId) continue
    if (message.method === 'error' && !p.willRetry) throw new Error(p.error?.message ?? 'Codex generation failed')
    if (message.method === 'item/agentMessage/delta' || message.method === 'item/reasoning/summaryTextDelta') {
      const type = message.method === 'item/agentMessage/delta' ? 'text' : 'reasoning'
      const entry = blockFor(`${p.itemId}:${type}`, type)
      if (!entry.started) {
        entry.started = true
        yield { type: 'block-start', index: entry.index, blockType: type }
      }
      entry.block.text += p.delta
      yield { type: `${type}-delta`, index: entry.index, text: p.delta }
    }
    if (message.method === 'item/completed' && p.item.type === 'agentMessage') {
      const key = `${p.item.id}:text`
      if (!ended.has(key)) {
        const entry = blocks.get(key)
        if (entry?.started) yield { type: 'block-end', index: entry.index, block: entry.block }
        else if (p.item.text) yield* completeBlock(index++, { type: 'text', text: p.item.text })
        blocks.delete(key)
        ended.add(key)
      }
    }
    if (message.method === 'rawResponseItem/completed') {
      const item = p.item
      if (item.type === 'function_call') {
        const name = names.get(item.name)
        if (!name || (item.namespace && item.namespace !== 'functions')) {
          throw new Error(`Codex attempted a non-DSH tool: ${item.name}`)
        }
        if (!calls.has(item.call_id)) {
          JSON.parse(item.arguments)
          calls.add(item.call_id)
          yield* finishText()
          yield* completeBlock(index++, { type: 'tool-call', id: item.call_id, name, arguments: item.arguments })
        }
      } else if (!['message', 'reasoning'].includes(item.type)) {
        throw new Error(`Unexpected Codex response item: ${item.type}`)
      }
    }
    if (message.method === 'rawResponse/completed') {
      if (p.usage) yield usageChunk(p.usage)
      yield* finishText()
      yield { type: 'finish', reason: { kind: calls.size ? 'tool-calls' : 'stop' } }
      return
    }
    if (message.method === 'turn/completed') {
      if (p.turn.status !== 'completed') throw new Error(p.turn.error?.message ?? `Codex turn ${p.turn.status}`)
      throw new Error('Codex did not emit rawResponse/completed; this bridge requires Codex 0.167.0 experimental APIs')
    }
  }
}
