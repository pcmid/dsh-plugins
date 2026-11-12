#!/usr/bin/env node
/**
 * Live OAuth-protected MCP server for trying the plugin against a real DSH. Not imported by `npm test`.
 *
 * Serves, on one loopback origin:
 * - an OAuth 2.1 authorization server (./oauth-as.mjs): RFC 9728 / 8414 metadata, `/as/register`,
 *   `/as/authorize` (a page with Approve / Deny), `/as/token`, `/as/revoke`;
 * - a Streamable HTTP MCP endpoint `/mcp` with the tools `whoami` and `echo`, which answers 401 with
 *   `WWW-Authenticate: Bearer resource_metadata=…` unless the request carries a valid access token.
 *
 * The MCP SDK and zod are resolved from the CURRENT DIRECTORY (bare specifiers through `createRequire`),
 * so run it from a package that depends on them, for example:
 *
 *   cd deepseek-harness/packages/mcp/mcp-client
 *   node <plugin>/test/fixtures/oauth-mcp-server.mjs --port 47301 --expires-in 120
 *
 * Options: `--port <n>` (default 47301), `--expires-in <seconds>` (access token lifetime, default 3600;
 * `0` omits `expires_in`), `--no-registration` (require a client ID; `--client-id <id>` registers one,
 * default `dsh-test-client`), `--no-rotate` (keep refresh tokens on refresh), `--reject-refresh`
 * (answer every refresh with `invalid_grant`). Then add `http://localhost:<port>/mcp` in DSH.
 */

import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { createAuthorizationServer } from './oauth-as.mjs'

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '47301' },
    'expires-in': { type: 'string', default: '3600' },
    'no-registration': { type: 'boolean', default: false },
    'client-id': { type: 'string', default: 'dsh-test-client' },
    'no-rotate': { type: 'boolean', default: false },
    'reject-refresh': { type: 'boolean', default: false },
  },
})

const fromCwd = createRequire(path.join(process.cwd(), 'noop.js'))
let sdk
try {
  sdk = {
    ...fromCwd('@modelcontextprotocol/server'),
    ...fromCwd('@modelcontextprotocol/node'),
    z: fromCwd('zod').z,
  }
} catch (error) {
  console.error(`Cannot load the MCP SDK from ${process.cwd()}: ${error.message}\nRun this from a directory where @modelcontextprotocol/server, @modelcontextprotocol/node, and zod resolve (for example deepseek-harness/packages/mcp/mcp-client).`)
  process.exit(1)
}
const { createMcpHandler, McpServer, toNodeHandler, z } = sdk

const port = Number(values.port)
const expiresIn = Number(values['expires-in'])
const as = createAuthorizationServer({
  approval: 'page',
  expiresIn: expiresIn > 0 ? expiresIn : undefined,
  registration: !values['no-registration'],
  staticClients: values['no-registration'] ? [{ clientId: values['client-id'] }] : [],
  rotateRefreshTokens: !values['no-rotate'],
})
as.state.rejectRefresh = values['reject-refresh']

const mcp = createMcpHandler(({ requestInfo }) => {
  const server = new McpServer({ name: 'oauth-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.registerTool('whoami', { description: 'Reports the OAuth client and scope of the access token used for this call.', inputSchema: z.object({}) }, async () => {
    const grant = as.verify(requestInfo?.headers.get('authorization') ?? undefined)
    return { content: [{ type: 'text', text: grant === undefined ? 'unauthenticated' : `client ${grant.clientId}, scope "${grant.scope}"` }] }
  })
  server.registerTool('echo', { description: 'Returns the text it receives.', inputSchema: z.object({ text: z.string().describe('Text to return.') }) }, async ({ text }) => ({
    content: [{ type: 'text', text }],
  }))
  return server
})
const handleMcp = toNodeHandler(mcp)

const handleRequest = (request, response) => {
  const url = new URL(request.url ?? '/', as.state.base)
  as.handle(request, response, url).then(async (handled) => {
    if (handled) return
    if (url.pathname !== '/mcp') {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    if (as.verify(request.headers.authorization) === undefined) {
      console.log(`${new Date().toISOString()} ${request.method} /mcp -> 401`)
      request.resume()
      response.writeHead(401, { 'www-authenticate': as.challenge(), 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'invalid_token', error_description: 'A valid Bearer token is required' }))
      return
    }
    await handleMcp(request, response)
  }).catch((error) => {
    console.error(error)
    if (!response.headersSent) response.writeHead(500).end(String(error))
  })
}

// Metadata names http://localhost:<port>, so both loopback addresses are served.
const servers = [http.createServer(handleRequest), http.createServer(handleRequest)]
as.setBase(`http://localhost:${port}`)
servers[0].listen(port, '127.0.0.1', () => {
  console.log(`OAuth MCP fixture: MCP endpoint ${as.state.base}/mcp (use this URL in DSH), issuer ${as.issuer()}`)
  console.log(`Access tokens expire after ${expiresIn > 0 ? `${expiresIn} s` : 'never (no expires_in)'}; registration ${values['no-registration'] ? `off (client ID ${values['client-id']})` : 'on'}.`)
})
servers[1].on('error', () => { /* IPv6 loopback is unavailable; 127.0.0.1 serves localhost. */ })
servers[1].listen(port, '::1')

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const server of servers) server.close()
    void mcp.close?.()
    process.exit(0)
  })
}
