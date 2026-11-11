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
    const nativeItems = message.source?.provider === options.provider
      ? message.source?.replayState?.response?.codexNativeItems : undefined
    if (message.role === 'assistant' && Array.isArray(nativeItems)) items.push(...nativeItems)
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

// Codex finishes native tools; DSH receives its own calls at a complete response boundary.
export async function* readStep(rpc, threadId, turnId, names) {
  let index = 0
  const blocks = new Map()
  const ended = new Set()
  const calls = new Set()
  const nativeCalls = new Set()
  const nativeItems = []
  let nativeResponse = false
  let responseReady = false
  let responses = 0
  let usage
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
  const finish = function* () {
    if (usage) yield { type: 'usage', usage }
    yield* finishText()
    yield { type: 'finish', reason: { kind: calls.size ? 'tool-calls' : 'stop' },
      ...(nativeItems.length ? { replayState: { response: { codexNativeItems: nativeItems } } } : {}) }
  }
  while (true) {
    const message = await rpc.next()
    const p = message.params ?? {}
    if (message.id !== undefined) {
      // Leave dynamic calls unanswered. DSH executes them AFTER this stream ends.
      if (message.method === 'item/tool/call' && p.threadId === threadId && names.has(p.tool)) {
        if (nativeCalls.size && !calls.has(p.callId)) {
          rpc.write({ id: message.id, result: { success: false, contentItems: [{ type: 'inputText',
            text: `Call ${p.tool} directly as a function tool, outside exec. DSH executes this tool and supplies its result in the next step.` }] } })
        }
        continue
      }
      // This model provider has no approval/input UI; let Codex report the refusal to the model.
      if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
        rpc.write({ id: message.id, result: { decision: 'decline' } })
      } else if (message.method === 'item/permissions/requestApproval') {
        rpc.write({ id: message.id, result: { permissions: {}, scope: 'turn' } })
      } else if (message.method === 'item/tool/requestUserInput') {
        rpc.write({ id: message.id, result: { answers: {} } })
      } else {
        rpc.write({ id: message.id, error: { code: -32601, message: `Unsupported client interaction: ${message.method}` } })
      }
      continue
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
      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        const name = names.get(item.name)
        if (!name || (item.namespace && item.namespace !== 'functions')) {
          nativeItems.push(item)
          nativeCalls.add(item.call_id)
          nativeResponse = true
          continue
        }
        if (!calls.has(item.call_id)) {
          const args = item.type === 'custom_tool_call' ? item.input : item.arguments
          if (typeof args !== 'string') throw new Error(`Invalid Codex tool arguments for ${name}: expected a JSON string`)
          JSON.parse(args)
          calls.add(item.call_id)
          yield* finishText()
          yield* completeBlock(index++, { type: 'tool-call', id: item.call_id, name, arguments: args })
        }
      } else if (['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(item.type)) {
        if (nativeCalls.has(item.call_id)) nativeItems.push(item)
        nativeCalls.delete(item.call_id)
      } else if (['local_shell_call', 'tool_search_call', 'web_search_call', 'image_generation_call'].includes(item.type)) {
        nativeItems.push(item)
        if (['local_shell_call', 'tool_search_call'].includes(item.type) && item.call_id) nativeCalls.add(item.call_id)
        nativeResponse = true
      } else if (!['message', 'reasoning', 'compaction'].includes(item.type)) {
        throw new Error(`Unexpected Codex response item: ${item.type}`)
      }
    }
    if (message.method === 'rawResponse/completed') {
      responses++
      if (p.usage) {
        usage ??= {}
        for (const [key, value] of Object.entries(usageChunk(p.usage).usage)) usage[key] = (usage[key] ?? 0) + value
      }
      yield* finishText()
      responseReady = calls.size > 0 || !nativeResponse
      nativeResponse = false
    }
    if (responseReady && !nativeCalls.size) {
      yield* finish()
      return
    }
    if (message.method === 'turn/completed') {
      if (p.turn.status !== 'completed') throw new Error(p.turn.error?.message ?? `Codex turn ${p.turn.status}`)
      if (!responses) throw new Error('Codex did not emit rawResponse/completed; this bridge requires Codex 0.167.0 experimental APIs')
      yield* finish()
      return
    }
  }
}
