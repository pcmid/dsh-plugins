import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { AppServer } from '../rpc.js'
function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
  const lines = createInterface({ input: child.stdin })
  child.kill = () => {
    if (child.exited) return
    child.exited = true
    lines.close()
    child.stdout.end()
    queueMicrotask(() => child.emit('close', 0))
  }
  lines.on('line', line => {
    const message = JSON.parse(line)
    const send = value => child.stdout.write(`${JSON.stringify(value)}\n`)
    if (message.method === 'echo') {
      // Exercise split transport frames as well as queued notifications.
      const response = JSON.stringify({ id: message.id, result: message.params })
      child.stdout.write(response.slice(0, 5))
      child.stdout.write(`${response.slice(5)}\n`)
      send({ method: 'event', params: message.params })
    } else if (message.method === 'error') send({ id: message.id, error: { message: 'Fixture error' } })
    else if (message.method === 'crash') child.kill()
    else if (message.method === 'invalid') child.stdout.write('broken JSON\n')
  })
  return child
}
const client = options => new AppServer('fixture', [], { timeoutMs: 2000, ...options }, fixture)

test('stdio request correlation, queued notifications and server errors', async () => {
  const rpc = client()
  try {
    const results = await Promise.all([rpc.request('echo', { n: 1 }), rpc.request('echo', { n: 2 })])
    assert.deepEqual(results, [{ n: 1 }, { n: 2 }])
    assert.equal((await rpc.next()).params.n, 1)
    assert.equal((await rpc.next()).params.n, 2)
    await assert.rejects(rpc.request('error', {}), /Fixture error/)
  } finally { await rpc.close() }
})

test('crash and malformed protocol reject waiting readers and RPCs', async () => {
  for (const method of ['crash', 'invalid']) {
    const rpc = client()
    try {
      const results = await Promise.allSettled([rpc.request(method, {}), rpc.next()])
      assert.ok(results.every(result => result.status === 'rejected'))
    } finally { await rpc.close() }
  }
})

test('abort, timeout and missing executable settle instead of hanging', async () => {
  const controller = new AbortController()
  const rpc = client({ signal: controller.signal })
  const waiting = rpc.request('hold', {})
  controller.abort()
  await assert.rejects(waiting, { name: 'AbortError' })
  await rpc.close()
  const timed = client({ timeoutMs: 50 })
  const keepAlive = setInterval(() => {}, 1000)
  await assert.rejects(timed.request('hold', {}), /timed out/)
  await timed.close()
  clearInterval(keepAlive)
  const missing = new AppServer('/no-such-codex-executable', [], {})
  await assert.rejects(missing.request('initialize', {}), /ENOENT/)
  await missing.close()
})
