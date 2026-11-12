/**
 * Loopback listener for the OAuth redirect (RFC 8252 §7.3): `127.0.0.1` and, when available, `::1` on one
 * port, so `http://localhost:<port>/callback` reaches it whichever address the browser picks. No other
 * interface is bound.
 */

import http from 'node:http'

const ATTEMPTS = 5

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve(server.address().port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ host, port, exclusive: true })
  })
}

function close(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close(() => resolve())
    server.closeIdleConnections()
  })
}

/**
 * Open the callback listener.
 * @param {number | undefined} preferredPort - port to try first (the one used last time), else random.
 * @param {(url: URL) => Promise<{ status: number, html: string }>} handle - answers `GET /callback`.
 * @returns {Promise<{ port: number, close(): Promise<void> }>} the listener; `close` is idempotent.
 */
export async function openCallbackListener(preferredPort, handle) {
  const onRequest = (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const send = (status, html) => {
      response.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        connection: 'close',
      })
      response.end(html)
    }
    if (request.method !== 'GET' || url.pathname !== '/callback') {
      send(404, '<!doctype html><title>Not found</title>')
      return
    }
    handle(url).then(
      result => send(result.status, result.html),
      () => send(500, '<!doctype html><title>Error</title>'),
    )
  }
  let port = Number.isInteger(preferredPort) && preferredPort > 0 && preferredPort < 65536 ? preferredPort : 0
  let lastError
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const v4 = http.createServer(onRequest)
    const v6 = http.createServer(onRequest)
    try {
      port = await listen(v4, '127.0.0.1', port)
    } catch (error) {
      lastError = error
      port = 0
      continue
    }
    try {
      await listen(v6, '::1', port)
    } catch (error) {
      if (error?.code === 'EADDRINUSE') {
        // Another program owns [::1]:port; a browser resolving localhost to ::1 would reach it instead.
        await close(v4)
        lastError = error
        port = 0
        continue
      }
      // IPv6 is unavailable on this machine; 127.0.0.1 alone serves localhost.
    }
    let closed
    return {
      port,
      close() {
        closed ??= Promise.all([close(v4), close(v6)]).then(() => {})
        return closed
      },
    }
  }
  throw new Error(`cannot open a local port for the authorization callback: ${lastError?.message ?? 'unknown error'}`)
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

/**
 * Bilingual result page shown in the browser after the redirect. It never contains token values.
 * @param {boolean} success - whether authorization completed.
 * @param {string} [reason] - failure reason (English).
 * @returns {string} HTML document.
 */
export function callbackPage(success, reason = '') {
  const title = success ? '授权完成 · Authorization complete' : '授权失败 · Authorization failed'
  const zh = success ? '授权完成，可以关闭此页面回到 DSH。' : `授权失败：${escapeHtml(reason)}`
  const en = success ? 'Authorization is complete. You can close this page and return to DSH.' : `Authorization failed: ${escapeHtml(reason)}`
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#222}h1{font-size:1.25rem;font-weight:600}p{margin:.5rem 0}@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}}</style>
</head><body><h1>${title}</h1><p>${zh}</p><p>${en}</p></body></html>
`
}
