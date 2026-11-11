import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { AppServerConnection } from '../app-server.js'

function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), received: [] })
  const lines = createInterface({ input: child.stdin })
  child.kill = () => {
    if (child.exited) return
    child.exited = true
    lines.close()
    child.stdout.end()
    queueMicrotask(() => child.emit('close', 0))
  }
  const send = value => child.stdout.write(`${JSON.stringify(value)}\n`)
  lines.on('line', line => {
    const message = JSON.parse(line)
    child.received.push(message)
    if (message.method === 'echo') {
      // Exercise split transport frames.
      const response = JSON.stringify({ id: message.id, result: message.params })
      child.stdout.write(response.slice(0, 5))
      child.stdout.write(`${response.slice(5)}\n`)
    } else if (message.method === 'error') send({ id: message.id, error: { code: -32600, message: 'Fixture error' } })
    else if (message.method === 'emit') {
      send({ method: 'item/agentMessage/delta', params: { threadId: 't1', delta: 'hi' } })
      send({ method: 'item/agentMessage/delta', params: { threadId: 'other', delta: 'ignored' } })
      send({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: 'none' } })
      send({ id: 901, method: 'account/chatgptAuthTokens/refresh', params: {} })
      send({ id: message.id, result: {} })
    } else if (message.method === 'crash') child.kill()
    else if (message.method === 'invalid') child.stdout.write('broken JSON\n')
  })
  return child
}
const connect = () => {
  let child
  const connection = new AppServerConnection('fixture', [], {}, (...args) => (child = fixture(...args)))
  return { connection, child: () => child }
}

test('requests correlate across split frames; errors carry the method', async () => {
  const { connection } = connect()
  try {
    assert.deepEqual(await Promise.all([connection.request('echo', { n: 1 }), connection.request('echo', { n: 2 })]), [{ n: 1 }, { n: 2 }])
    await assert.rejects(connection.request('error', {}), { name: 'CodexRpcError', message: /Codex error: Fixture error/ })
  } finally { await connection.close() }
})

test('thread messages reach their listener; other server requests are declined', async () => {
  const { connection, child } = connect()
  try {
    const seen = []
    const unsubscribe = connection.subscribe('t1', message => seen.push(message))
    await connection.request('emit', {})
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(seen.map(m => m.params.delta), ['hi'])
    const answers = child().received.filter(m => m.id >= 900)
    assert.deepEqual(answers, [{ id: 900, result: { decision: 'decline' } },
      { id: 901, error: { code: -32601, message: 'Unsupported client interaction: account/chatgptAuthTokens/refresh' } }])
    unsubscribe()
    assert.equal(connection.threads.size, 0)
  } finally { await connection.close() }
})

test('a crash or malformed output fails requests and thread listeners', async () => {
  for (const method of ['crash', 'invalid']) {
    const { connection } = connect()
    try {
      const failures = []
      connection.subscribe('t1', message => failures.push(message.method))
      await assert.rejects(connection.request(method, {}))
      assert.deepEqual(failures, ['connection/failed'])
      await assert.rejects(connection.request('echo', {}))
    } finally { await connection.close() }
  }
})

test('a missing executable reports the setting to change', async () => {
  const connection = new AppServerConnection('/no-such-codex-executable', [], {})
  await assert.rejects(connection.initialize({ name: 'test', version: '0' }), { code: 'ENOENT', message: /Codex app-server not found.*Codex path/ })
  await connection.close()
})
