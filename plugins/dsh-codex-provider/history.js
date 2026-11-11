import { createHash } from 'node:crypto'
import { LlmError } from '@deepseek-ai/dsh-llm'

const hash = text => createHash('sha256').update(text).digest('hex')

// Codex refuses these names for client tools (thread/start fails, or the tool is silently skipped).
// `exec` and `wait` are the code-mode tools of current Codex models.
const RESERVED_NAMES = new Set(['exec_command', 'shell_command', 'mcp', 'exec', 'wait'])
const VALID_NAME = /^[a-zA-Z0-9_-]{1,64}$/

function sanitize(name) {
  const base = name.replace(/^mcp__/, 'mcp_').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return base || 'tool'
}

/**
 * Map DSH tools to Codex dynamic tools. A name Codex accepts is kept verbatim, so the model sees
 * the same names the DSH system prompt uses; other names are sanitized, with a stable hash suffix
 * when that would collide.
 * @param tools - DSH tool schemas.
 * @returns `specs` for `thread/start`, and the name maps in both directions.
 */
export function toolNames(tools = []) {
  const toWire = new Map()
  const toDsh = new Map()
  const fits = name => VALID_NAME.test(name) && !RESERVED_NAMES.has(name) && !name.startsWith('mcp__')
  for (const tool of tools) {
    if (toWire.has(tool.name)) throw new LlmError(`Duplicate DSH tool: ${tool.name}`, 'INVALID_REQUEST')
    if (fits(tool.name)) {
      toWire.set(tool.name, tool.name)
      toDsh.set(tool.name, tool.name)
    }
  }
  for (const tool of tools) {
    if (toWire.has(tool.name)) continue
    let wire = sanitize(tool.name).slice(0, 64)
    if (!fits(wire) || toDsh.has(wire)) wire = `${wire.slice(0, 55)}_${hash(tool.name).slice(0, 8)}`
    for (let n = 2; toDsh.has(wire); n++) wire = `${wire.slice(0, 52)}_${hash(`${tool.name}#${n}`).slice(0, 8)}`
    toWire.set(tool.name, wire)
    toDsh.set(wire, tool.name)
  }
  const specs = tools.map(tool => ({
    type: 'function', name: toWire.get(tool.name), description: tool.description, inputSchema: tool.parameters,
  }))
  return { specs, toWire, toDsh }
}

function text(message, allow = []) {
  const parts = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
    else if (!allow.includes(block.type)) {
      throw new LlmError(`Codex Provider cannot send ${block.type} content in a ${message.role} message`, 'UNSUPPORTED_CONTENT')
    }
  }
  return parts.join('\n')
}

/**
 * Split the request into Codex base instructions and the conversation history: the one-shot
 * `system` field and leading system messages become the instructions.
 * @param options - DSH request.
 * @returns `instructions` and the remaining `messages`.
 */
export function splitInstructions(options) {
  const instructions = options.system ? [options.system] : []
  let start = 0
  while (start < options.messages.length && options.messages[start].role === 'system') {
    instructions.push(text(options.messages[start]))
    start++
  }
  return { instructions: instructions.filter(Boolean).join('\n\n'), messages: options.messages.slice(start) }
}

const CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'tool_search_call'])
const OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'tool_search_output'])

/** Whether a Responses item is a tool call that needs a matching output. */
export const isCallItem = item => CALL_TYPES.has(item?.type) && typeof item.call_id === 'string'
/** Whether a Responses item is a tool output. */
export const isOutputItem = item => OUTPUT_TYPES.has(item?.type)

/**
 * The Codex output items recorded for an assistant message this provider produced, when they
 * still describe the message DSH logged.
 * @param message - DSH assistant message.
 * @param provider - this provider route.
 * @returns the recorded Responses items, or `undefined` to rebuild them from the message blocks.
 */
export function recordedItems(message, provider) {
  if (message.source?.provider !== provider) return undefined
  const codex = message.source?.replayState?.response?.codex
  if (!Array.isArray(codex?.items)) return undefined
  // Calls made inside a code-mode script reach the model through the script's output instead.
  const nested = new Set(Array.isArray(codex.nested) ? codex.nested : [])
  const recorded = new Set(codex.items.filter(isCallItem).map(item => item.call_id))
  const calls = message.content.filter(block => block.type === 'tool-call' && !nested.has(block.id))
  return calls.every(block => recorded.has(block.id)) ? codex.items : undefined
}

/**
 * Project DSH history to Responses items for `thread/inject_items`. Assistant messages from this
 * provider replay the exact items Codex produced, including encrypted reasoning; other assistant
 * messages are rebuilt from their text and tool-call blocks (reasoning text is not replayed).
 * @param messages - DSH messages after the instructions.
 * @param provider - this provider route.
 * @param toWire - DSH tool name to Codex tool name.
 * @returns Responses items where every tool call has an output and every output has a call.
 */
export function projectHistory(messages, provider, toWire) {
  const recorded = new Map(messages.flatMap(message => {
    const items = message.role === 'assistant' ? recordedItems(message, provider) : undefined
    return items ? [[message, items]] : []
  }))
  let items = project(messages, recorded, toWire)
  // A recorded call whose output never arrived (a script still running when the thread was
  // lost) would be dropped with everything it produced; rebuild those messages from DSH blocks.
  const outputs = new Set(items.filter(isOutputItem).map(item => item.call_id))
  let rebuilt = false
  for (const [message, list] of recorded) {
    if (list.some(item => isCallItem(item) && !outputs.has(item.call_id))) {
      recorded.delete(message)
      rebuilt = true
    }
  }
  if (rebuilt) items = project(messages, recorded, toWire)
  // Responses rejects a call without an output and an output without a call.
  const calls = new Set(items.filter(isCallItem).map(item => item.call_id))
  const answered = new Set(items.filter(isOutputItem).map(item => item.call_id))
  return items.filter(item => (isCallItem(item) ? answered.has(item.call_id) : isOutputItem(item) ? calls.has(item.call_id) : true))
}

function project(messages, recorded, toWire) {
  const items = []
  for (const message of messages) {
    switch (message.role) {
      case 'system':
      case 'developer': {
        const body = text(message, ['tool-addition', 'tool-removal'])
        if (body) items.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: body }] })
        break
      }
      case 'user':
        items.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: text(message) }] })
        break
      case 'tool':
        items.push({ type: 'function_call_output', call_id: message.toolCallId, output: text(message) })
        break
      case 'assistant': {
        if (recorded.has(message)) {
          items.push(...recorded.get(message))
          break
        }
        let content = []
        const flush = () => {
          if (content.length) items.push({ type: 'message', role: 'assistant', content })
          content = []
        }
        for (const block of message.content) {
          if (block.type === 'text') content.push({ type: 'output_text', text: block.text })
          else if (block.type === 'tool-call') {
            flush()
            items.push({ type: 'function_call', call_id: block.id, name: toWire.get(block.name) ?? block.name, arguments: block.arguments })
          } else if (block.type !== 'reasoning') {
            throw new LlmError(`Codex Provider cannot send ${block.type} content in an assistant message`, 'UNSUPPORTED_CONTENT')
          }
        }
        flush()
        break
      }
      default:
        throw new LlmError(`Codex Provider cannot send a ${message.role} message`, 'UNSUPPORTED_CONTENT')
    }
  }
  return items
}

/** Text a DSH tool result sends back to Codex. */
export const toolResultText = message => text(message)

/**
 * Identity of one DSH message's model-visible content, cached per message object.
 */
export class MessageKeys {
  constructor() { this.cache = new WeakMap() }

  /**
   * @param message - DSH request message.
   * @returns a digest of its role, identity and content.
   */
  of(message) {
    let key = this.cache.get(message)
    if (key === undefined) {
      key = hash(JSON.stringify([message.role, message.id ?? null, message.toolCallId ?? null, message.isError ?? false, message.content]))
      this.cache.set(message, key)
    }
    return key
  }
}

/**
 * Identity of the parts of a request that a Codex thread fixes at `thread/start`.
 * @returns a digest of the model, instructions and tool specs.
 */
export const threadSpec = (model, instructions, specs) => hash(JSON.stringify([model, instructions, specs]))
