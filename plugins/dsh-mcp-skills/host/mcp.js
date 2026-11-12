/**
 * `mcp-tools`: the tools one MCP server contributes, read from the global tool registry.
 */

import { HostError } from './errors.js'

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

/**
 * List the tools named `mcp__<server>__<tool>` in `ctx.tools.schemas()`.
 * @param {object} ctx - plugin context; `tools` is read lazily with `ctx.get`.
 * @param {{ server?: unknown }} payload - `{ server }`.
 * @returns {{ tools: { name: string, description: string }[] }} tool names without the prefix, with full
 *   descriptions, in registry order.
 * @throws {HostError} `bad-request` for an invalid server name; `unavailable` without a tool registry.
 */
export function listMcpTools(ctx, payload) {
  const server = payload.server
  if (typeof server !== 'string' || !SERVER_NAME.test(server)) {
    throw new HostError('bad-request', `MCP server name ${JSON.stringify(server)} is invalid: use 1-32 letters, digits, "_", or "-"`)
  }
  const tools = ctx.get('tools')
  if (tools === undefined) throw new HostError('unavailable', 'The DSH tool registry is not available')
  const prefix = `mcp__${server}__`
  const result = []
  for (const schema of tools.schemas()) {
    if (typeof schema?.name !== 'string' || !schema.name.startsWith(prefix) || schema.name.length === prefix.length) continue
    result.push({ name: schema.name.slice(prefix.length), description: typeof schema.description === 'string' ? schema.description : '' })
  }
  return { tools: result }
}
