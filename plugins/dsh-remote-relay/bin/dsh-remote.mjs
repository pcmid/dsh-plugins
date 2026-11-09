#!/usr/bin/env node
/**
 * dsh-remote: computer connector for the DSH remote relay bundle.
 *
 * `pair` exchanges a one-time pairing code (or launcher link) for a device key stored in
 * `~/.dsh-remote/hosts.json`. `connect` keeps an end-to-end encrypted tunnel to the paired DSH
 * through its relay and serves that DSH's Web GUI on a loopback port of this computer. The local
 * port requires the session token printed at start, rejects foreign Host and Origin headers, and
 * never forwards browser cookies, because whoever reaches it acts as the DSH owner.
 *
 * Requires Node 22 or later (global WebSocket and WebCrypto). No dependencies.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  RemoteHost, TunnelError, createIdentity, decodePairing, headerPairs, importIdentity, pairDevice,
} from '../launcher/tunnel.js'

const VERSION = '0.1.0'
const HOME = process.env.DSH_REMOTE_HOME ?? path.join(os.homedir(), '.dsh-remote')
const STORE = path.join(HOME, 'hosts.json')
const TOKEN_PARAM = 'dsh-remote-token'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_WS_MESSAGE = 64 * 1024 * 1024
const HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'cookie', 'origin', 'referer',
])
const USAGE = `dsh-remote ${VERSION} — reach a DSH through its relay

Usage:
  dsh-remote pair <pairing-code-or-link> [--name <device name>]
  dsh-remote connect [host] [--port <port>] [--open]
  dsh-remote list
  dsh-remote forget <host>

pair      Pair this computer using the code from DSH Settings → Remote access.
connect   Serve the paired DSH on http://127.0.0.1:<port>/ (default port 7878).
          [host] picks a paired DSH by name or id prefix when several are paired.
list      Show paired DSH hosts.
forget    Delete the local key for a host (also remove the device in DSH Settings).

Keys are stored in ${STORE}; set DSH_REMOTE_HOME to change the directory.
`

function fail(message) {
  console.error(`dsh-remote: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') flags.help = true
    else if (arg === '--open') flags.open = true
    else if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=', 2)
      flags[name] = inline ?? argv[++i]
      if (flags[name] === undefined) fail(`--${name} needs a value`)
    } else positional.push(arg)
  }
  return { command: positional.shift(), positional, flags }
}

async function readStore() {
  try {
    const store = JSON.parse(await fs.readFile(STORE, 'utf8'))
    if (store?.version !== 1 || !Array.isArray(store.hosts)) throw new Error(`${STORE} has an unsupported format`)
    return store
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, hosts: [] }
    throw error
  }
}

async function writeStore(store) {
  await fs.mkdir(HOME, { recursive: true, mode: 0o700 })
  const temporary = `${STORE}.${process.pid}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temporary, STORE)
}

function pickHost(store, query) {
  if (store.hosts.length === 0) fail('no DSH is paired yet; run `dsh-remote pair <code>` first')
  if (query === undefined) {
    if (store.hosts.length === 1) return store.hosts[0]
    fail(`several hosts are paired; name one of: ${store.hosts.map((host) => host.hostName).join(', ')}`)
  }
  const lower = query.toLowerCase()
  const matches = store.hosts.filter((host) => host.serverId.startsWith(query) || host.hostName.toLowerCase() === lower)
  if (matches.length !== 1) fail(matches.length === 0 ? `no paired host matches "${query}"` : `"${query}" matches several hosts`)
  return matches[0]
}

async function commandPair(positional, flags) {
  const input = positional[0]
  if (input === undefined) fail('pass the pairing code or link shown in DSH Settings → Remote access')
  const pairing = decodePairing(input)
  const deviceName = String(flags.name ?? os.hostname().replace(/\.local$/i, '')).slice(0, 80)
  const device = await createIdentity({ extractable: true })
  console.log(`Pairing with ${pairing.hostName || pairing.serverId.slice(0, 8)} through ${pairing.relayUrl} …`)
  const result = await pairDevice({ pairing, device, deviceName })
  const store = await readStore()
  store.hosts = store.hosts.filter((host) => host.serverId !== pairing.serverId)
  store.hosts.push({
    serverId: pairing.serverId,
    relayUrl: pairing.relayUrl,
    hostName: result.hostName || pairing.hostName,
    deviceId: device.id,
    deviceName: result.device.name || deviceName,
    privateJwk: device.privateJwk,
    pairedAt: Date.now(),
  })
  await writeStore(store)
  console.log(`Paired as "${result.device.name || deviceName}". Run: dsh-remote connect${store.hosts.length > 1 ? ` "${result.hostName}"` : ''}`)
}

async function commandList() {
  const store = await readStore()
  if (store.hosts.length === 0) {
    console.log('No DSH is paired.')
    return
  }
  for (const host of store.hosts) {
    console.log(`${host.hostName}\t${host.serverId.slice(0, 10)}…\t${host.relayUrl}\tas "${host.deviceName}"`)
  }
}

async function commandForget(positional) {
  const store = await readStore()
  const host = pickHost(store, positional[0])
  store.hosts = store.hosts.filter((candidate) => candidate !== host)
  await writeStore(store)
  console.log(`Forgot ${host.hostName}. Remove "${host.deviceName}" in DSH Settings → Remote access as well.`)
}

function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return undefined
}

function sameSecret(a, b) {
  const left = Buffer.from(String(a ?? ''))
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Loopback fence plus session-token check for one incoming request. */
function makeGate(port, token) {
  const cookieName = `dsh_remote_${port}`
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])
  return {
    cookieName,
    check(req) {
      const host = String(req.headers.host ?? '').toLowerCase()
      if (!allowedHosts.has(host)) return { status: 403, message: 'Unexpected Host header' }
      if (req.headers['sec-fetch-site'] === 'cross-site') return { status: 403, message: 'Cross-site request refused' }
      const origin = req.headers.origin
      if (origin !== undefined && origin !== `http://${host}`) return { status: 403, message: 'Cross-origin request refused' }
      if (sameSecret(readCookie(req.headers.cookie, cookieName), token)) return { status: 200 }
      const url = new URL(req.url ?? '/', `http://${host}`)
      if (req.method === 'GET' && sameSecret(url.searchParams.get(TOKEN_PARAM), token)) {
        url.searchParams.delete(TOKEN_PARAM)
        return { status: 303, location: `${url.pathname}${url.search}` }
      }
      return { status: 401, message: 'Open the address printed by `dsh-remote connect` to sign in.' }
    },
  }
}

function forwardHeaders(req) {
  return headerPairs(req.headers).filter(([name]) => !HOP_HEADERS.has(name) && !name.startsWith('sec-websocket-'))
}

async function handleRequest(remote, gate, req, res) {
  const verdict = gate.check(req)
  if (verdict.status === 303) {
    res.writeHead(303, {
      location: verdict.location,
      'set-cookie': `${gate.cookieName}=${gate.token}; Path=/; HttpOnly; SameSite=Strict`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end()
    return
  }
  if (verdict.status !== 200) {
    res.writeHead(verdict.status, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(verdict.message)
    return
  }
  const abort = new AbortController()
  res.on('close', () => { if (!res.writableFinished) abort.abort() })
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  try {
    const response = await remote.request({ method: req.method, path: req.url, headers: forwardHeaders(req), body: hasBody ? req : null }, abort.signal)
    const headers = {}
    for (const [name, value] of response.headers) {
      if (HOP_HEADERS.has(name)) continue
      headers[name] = headers[name] === undefined ? value : [].concat(headers[name], value)
    }
    res.writeHead(response.status, response.statusText || undefined, headers)
    if (response.body !== null) {
      for await (const chunk of response.body) {
        if (!res.write(chunk)) await new Promise((resolve) => { res.once('drain', resolve) })
      }
    }
    res.end()
  } catch (error) {
    if (abort.signal.aborted) return
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`dsh-remote: ${error.message}`)
    } else res.destroy()
  }
}

function wsFrame(opcode, payload) {
  const length = payload.length
  let header
  if (length < 126) header = Buffer.from([0x80 | opcode, length])
  else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

function closePayload(code, reason) {
  if (!(code === 1000 || (code >= 3000 && code <= 4999) || (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006))) return Buffer.alloc(0)
  const body = Buffer.alloc(2)
  body.writeUInt16BE(code, 0)
  return Buffer.concat([body, Buffer.from(String(reason ?? '').slice(0, 120))])
}

/** Minimal RFC 6455 server side: parses masked client frames and reassembles messages. */
function frameReader(onMessage, onControl, onError) {
  let buffer = Buffer.alloc(0)
  let fragments = []
  let fragmentType = 0
  let fragmentSize = 0
  return (chunk) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 2) return
      const fin = (buffer[0] & 0x80) !== 0
      const opcode = buffer[0] & 0x0f
      const masked = (buffer[1] & 0x80) !== 0
      let length = buffer[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        length = Number(buffer.readBigUInt64BE(2))
        offset = 10
      }
      if (!masked) return onError(1002, 'client frames must be masked')
      if (length > MAX_WS_MESSAGE) return onError(1009, 'message too large')
      if (buffer.length < offset + 4 + length) return
      const mask = buffer.subarray(offset, offset + 4)
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length))
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3]
      buffer = buffer.subarray(offset + 4 + length)
      if (opcode >= 0x8) {
        onControl(opcode, payload)
        continue
      }
      if (opcode !== 0) {
        fragments = []
        fragmentSize = 0
        fragmentType = opcode
      }
      fragments.push(payload)
      fragmentSize += payload.length
      if (fragmentSize > MAX_WS_MESSAGE) return onError(1009, 'message too large')
      if (fin) {
        onMessage(fragmentType, fragments.length === 1 ? fragments[0] : Buffer.concat(fragments))
        fragments = []
        fragmentSize = 0
      }
    }
  }
}

function handleUpgrade(remote, gate, req, socket, head) {
  socket.on('error', () => {})
  const refuse = (status, text) => {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }
  const verdict = gate.check(req)
  if (verdict.status !== 200) return refuse(verdict.status === 303 ? 401 : verdict.status, 'Refused')
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string' || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') return refuse(400, 'Bad Request')
  const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((item) => item.trim()).filter(Boolean)
  const tunnel = remote.openWebSocket(`ws://${req.headers.host}${req.url}`, req.url, { protocols, headers: forwardHeaders(req) })
  tunnel.binaryType = 'arraybuffer'
  let open = false
  let closing = false
  const sendClose = (code, reason) => {
    if (closing) return
    closing = true
    socket.end(wsFrame(0x8, closePayload(code, reason)))
  }
  const read = frameReader(
    (opcode, payload) => { tunnel.send(opcode === 0x1 ? payload.toString('utf8') : payload) },
    (opcode, payload) => {
      if (opcode === 0x9) socket.write(wsFrame(0xA, payload))
      else if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000
        tunnel.close(code === 1005 || code === 1006 ? 1000 : code, payload.subarray(2).toString('utf8'))
        sendClose(code, '')
      }
    },
    (code, reason) => {
      sendClose(code, reason)
      tunnel.close(1000, reason)
    },
  )
  tunnel.onopen = () => {
    open = true
    const lines = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${createHash('sha1').update(key + WS_GUID).digest('base64')}`,
    ]
    if (tunnel.protocol) lines.push(`Sec-WebSocket-Protocol: ${tunnel.protocol}`)
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    socket.setNoDelay(true)
    if (head.length > 0) read(head)
    socket.on('data', read)
  }
  tunnel.onmessage = (event) => {
    if (closing) return
    if (typeof event.data === 'string') socket.write(wsFrame(0x1, Buffer.from(event.data, 'utf8')))
    else socket.write(wsFrame(0x2, Buffer.from(event.data)))
  }
  tunnel.onclose = (event) => {
    if (!open) refuse(502, 'Bad Gateway')
    else sendClose(event.code, event.reason)
  }
  socket.on('close', () => { if (tunnel.readyState < 2) tunnel.close(1001, 'browser went away') })
}

function openBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
}

async function commandConnect(positional, flags) {
  const store = await readStore()
  const host = pickHost(store, positional[0])
  const port = Number(flags.port ?? 7878)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) fail('--port must be a TCP port number')
  const device = await importIdentity(host.privateJwk)
  let last = ''
  const remote = new RemoteHost({
    relayUrl: host.relayUrl,
    serverId: host.serverId,
    device,
    deviceName: host.deviceName,
    onstatus: (status) => {
      const line = status.state === 'connected' ? `connected to ${status.hostName || host.hostName}`
        : status.state === 'rejected' ? `rejected: ${status.error}`
          : status.state === 'retrying' ? `cannot reach ${host.hostName}: ${status.error} (retrying)`
            : status.state === 'connecting' && status.error ? `reconnecting: ${status.error}` : ''
      if (line !== '' && line !== last) {
        last = line
        console.log(`[${new Date().toLocaleTimeString()}] ${line}`)
      }
      if (status.state === 'rejected') {
        console.error('This computer is no longer paired. Pair again with a new code from DSH Settings → Remote access.')
        process.exit(2)
      }
    },
  })
  const token = randomBytes(24).toString('base64url')
  const gate = { ...makeGate(port, token), token }
  const server = http.createServer((req, res) => { void handleRequest(remote, gate, req, res) })
  server.on('upgrade', (req, socket, head) => { handleUpgrade(remote, gate, req, socket, head) })
  server.on('clientError', (_error, socket) => { socket.destroy() })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  }).catch((error) => fail(error.code === 'EADDRINUSE' ? `port ${port} is in use; pass --port` : error.message))
  remote.start()
  const url = `http://127.0.0.1:${port}/?${TOKEN_PARAM}=${token}`
  console.log(`DSH "${host.hostName}" → ${url}`)
  console.log('Anyone with this address can act as you on that DSH. Press Ctrl+C to stop.')
  if (flags.open) openBrowser(url)
  const stop = () => {
    remote.stop()
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2))
  if (flags.help || command === undefined || command === 'help') {
    process.stdout.write(USAGE)
    return
  }
  if (typeof WebSocket !== 'function' || globalThis.crypto?.subtle === undefined) fail('Node 22 or later is required')
  switch (command) {
    case 'pair': await commandPair(positional, flags); break
    case 'connect': await commandConnect(positional, flags); break
    case 'list': await commandList(); break
    case 'forget': await commandForget(positional); break
    default: fail(`unknown command "${command}"\n\n${USAGE}`)
  }
}

main().catch((error) => {
  fail(error instanceof TunnelError ? error.message : error?.stack ?? String(error))
})
