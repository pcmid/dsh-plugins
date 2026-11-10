/**
 * Loopback HTTP and WebSocket forwarding over a {@link RemoteHost} tunnel, used by the Host plugin's
 * device switcher (`remotes.js`) to serve another DSH on a loopback origin.
 *
 * The caller owns admission: it decides which requests reach these functions. They forward the
 * request without browser credentials (cookies, Origin, Referer, hop-by-hop headers) and return the
 * remote answer without cookies or framing restrictions. WebSocket upgrades are answered with a
 * minimal RFC 6455 server that relays whole messages through the tunnel.
 *
 * Node 22 or later. No dependencies.
 * @module dsh-remote/loopback
 */

import { createHash } from 'node:crypto'
import { headerPairs } from './launcher/tunnel.js'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_WS_MESSAGE = 64 * 1024 * 1024
/** Request and response headers that describe this hop or carry browser credentials. */
export const HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'cookie', 'origin', 'referer',
])
/** Response headers dropped in addition to {@link HOP_HEADERS}: cookies and framing restrictions. */
const DROP_RESPONSE_HEADERS = new Set(['set-cookie', 'x-frame-options'])

function forwardHeaders(req) {
  return headerPairs(req.headers).filter(([name]) => !HOP_HEADERS.has(name) && !name.startsWith('sec-websocket-'))
}

function responseHeaders(pairs) {
  const headers = {}
  for (const [name, raw] of pairs) {
    if (HOP_HEADERS.has(name) || DROP_RESPONSE_HEADERS.has(name)) continue
    const value = name === 'content-security-policy'
      ? raw.split(';').filter((directive) => !/^\s*frame-ancestors\b/i.test(directive)).join(';')
      : raw
    headers[name] = headers[name] === undefined ? value : [].concat(headers[name], value)
  }
  return headers
}

/**
 * Forward one HTTP request through the tunnel and stream the answer back.
 * @param {import('./launcher/tunnel.js').RemoteHost} remote - connected or connecting tunnel.
 * @param {import('node:http').IncomingMessage} req - admitted request.
 * @param {import('node:http').ServerResponse} res - its response.
 * @param {{ onerror?: (error: Error) => string }} [options] - turns a tunnel failure into a 502 body.
 * @returns {Promise<void>} settles when the exchange ends.
 */
export async function forwardRequest(remote, req, res, options = {}) {
  const abort = new AbortController()
  res.on('close', () => { if (!res.writableFinished) abort.abort() })
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  try {
    const response = await remote.request({ method: req.method, path: req.url, headers: forwardHeaders(req), body: hasBody ? req : null }, abort.signal)
    res.writeHead(response.status, response.statusText || undefined, responseHeaders(response.headers))
    if (response.body !== null) {
      for await (const chunk of response.body) {
        if (!res.write(chunk)) await new Promise((resolve) => { res.once('drain', resolve) })
      }
    }
    res.end()
  } catch (error) {
    if (abort.signal.aborted) return
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(options.onerror?.(error) ?? `dsh-remote: ${error.message}`)
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

/**
 * Answer an admitted WebSocket upgrade by opening the same socket on the remote host.
 * @param {import('./launcher/tunnel.js').RemoteHost} remote - connected or connecting tunnel.
 * @param {import('node:http').IncomingMessage} req - admitted upgrade request.
 * @param {import('node:stream').Duplex} socket - client socket.
 * @param {Buffer} head - bytes read past the upgrade head.
 * @param {{ onclose?: () => void }} [options] - called once when the socket pair is gone.
 */
export function forwardUpgrade(remote, req, socket, head, options = {}) {
  socket.on('error', () => {})
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    options.onclose?.()
  }
  const refuse = (status, text) => {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    finish()
  }
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string' || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
    refuse(400, 'Bad Request')
    return
  }
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
    socket.setNoDelay?.(true)
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
    finish()
  }
  socket.on('close', () => {
    if (tunnel.readyState < 2) tunnel.close(1001, 'browser went away')
    finish()
  })
}
