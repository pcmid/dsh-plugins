import { createHash } from 'node:crypto'
import { LlmError, offloadedImageText } from '@deepseek-ai/dsh-llm'

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
    type: 'function', name: toWire.get(tool.name), inputSchema: tool.parameters,
    description: tool.name === 'read_image'
      ? tool.description + '\nIn Codex code mode this returns a string. On success, pass its last line (the data:image/ URL) to image() and the preceding description to text(). On error, use text() for the error message.'
      : tool.description,
  }))
  return { specs, toWire, toDsh }
}

const unsupported = (message, block) =>
  new LlmError(`Codex Provider cannot send ${block.type} content in a ${message.role} message`, 'UNSUPPORTED_CONTENT')

function text(message, allow = []) {
  const parts = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
    else if (!allow.includes(block.type)) {
      throw unsupported(message, block)
    }
  }
  return parts.join('\n')
}

/** Read only images being sent to Codex, once per request and attachment. */
export async function prepareImages(messages, { readImage, resolveImageAccess }) {
  const urls = new Map()
  if (readImage) {
    for (const message of messages) {
      if (message.role !== 'user' && message.role !== 'tool') continue
      for (const block of message.content) {
        if (block.type !== 'image' || block.offloaded === true) continue
        if (!block.attachment) throw unsupported(message, block)
        const ref = block.attachment
        if (!urls.has(ref.attachmentId)) {
          const { mediaType, data } = await readImage(ref)
          urls.set(ref.attachmentId, `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`)
        }
      }
    }
  }
  return { urls, resolveImageAccess }
}

/** Responses-shaped text and images, preserving their order. */
function inputItems(message, { urls, resolveImageAccess } = {}) {
  const items = []
  let parts = []
  const flush = () => {
    if (parts.length) items.push({ type: 'input_text', text: parts.join('\n') })
    parts = []
  }
  for (const block of message.content) {
    if (block.type === 'text') {
      parts.push(block.text)
      continue
    }
    if (block.type !== 'image' || !block.attachment) throw unsupported(message, block)
    const ref = block.attachment
    if (block.offloaded === true) {
      parts.push(offloadedImageText(ref, resolveImageAccess?.(ref)))
      continue
    }
    const imageUrl = urls?.get(ref.attachmentId)
    if (!imageUrl) throw unsupported(message, block)
    flush()
    items.push({ type: 'input_image', image_url: imageUrl })
  }
  flush()
  return items.length ? items : [{ type: 'input_text', text: '' }]
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
const inlineImage = text => typeof text === 'string' && /data:image\/[^;,\s]+;base64,/i.test(text)
/** Code mode's image() emits a block, but text() can print the same data URL as text. */
export const hasOutputImage = item => Array.isArray(item.output)
  ? item.output.some(part => part?.type === 'input_image' || inlineImage(part?.text))
  : inlineImage(item.output)

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

/** A Code Mode script can consume DSH results from several steps before emitting one output. */
function rebuildNestedImageTurns(messages, recorded) {
  const imageResults = new Set(messages.filter(message => message.role === 'tool'
    && message.content.some(block => block.type === 'image')).map(message => message.toolCallId))
  const imageTurns = new Set()
  const nested = new Map()
  for (const message of recorded.keys()) {
    const replay = message.source.replayState.response.codex
    if (!replay.turn) continue
    const turn = JSON.stringify([replay.thread, replay.turn])
    const calls = Array.isArray(replay.nested) ? replay.nested : []
    if (calls.length) nested.set(message, turn)
    if (replay.imageOutput || calls.some(id => imageResults.has(id))) imageTurns.add(turn)
  }
  // Rebuild only assistant steps with calls inside the affected script turn. Other raw items can
  // still replay; the call/output pairing below discards the now-unmatched script results.
  for (const [message, turn] of nested) if (imageTurns.has(turn)) recorded.delete(message)
}

/**
 * Project DSH history to Responses items for `thread/inject_items`. Assistant messages from this
 * provider replay the exact items Codex produced, including encrypted reasoning; other assistant
 * messages are rebuilt from their text and tool-call blocks (reasoning text is not replayed).
 * @param messages - DSH messages after the instructions.
 * @param provider - this provider route.
 * @param toWire - DSH tool name to Codex tool name.
 * @param images - prepared request images and optional path resolver.
 * @returns Responses items where every tool call has an output and every output has a call.
 */
export function projectHistory(messages, provider, toWire, images) {
  const recorded = new Map(messages.flatMap(message => {
    const items = message.role === 'assistant' ? recordedItems(message, provider) : undefined
    return items ? [[message, items]] : []
  }))
  rebuildNestedImageTurns(messages, recorded)
  let items = project(messages, recorded, toWire, images)
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
  if (rebuilt) items = project(messages, recorded, toWire, images)
  // Responses rejects a call without an output and an output without a call.
  const calls = new Set(items.filter(isCallItem).map(item => item.call_id))
  const answered = new Set(items.filter(isOutputItem).map(item => item.call_id))
  return items.filter(item => (isCallItem(item) ? answered.has(item.call_id) : isOutputItem(item) ? calls.has(item.call_id) : true))
}

function project(messages, recorded, toWire, images) {
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
        items.push({ type: 'message', role: 'user', content: inputItems(message, images) })
        break
      case 'tool': {
        const content = inputItems(message, images)
        items.push({ type: 'function_call_output', call_id: message.toolCallId,
          output: content.length === 1 && content[0].type === 'input_text' ? content[0].text : content })
        break
      }
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

/** Dynamic tool replies use app-server's camelCase instead of Responses item fields. */
export const toolResultItems = (message, images) => inputItems(message, images).map(item => item.type === 'input_text'
  ? { type: 'inputText', text: item.text }
  : { type: 'inputImage', imageUrl: item.image_url })

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
