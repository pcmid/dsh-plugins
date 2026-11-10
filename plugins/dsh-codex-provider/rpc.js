import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

// One process per model step: no pending turn can outlive or contaminate a DSH request.
export class AppServer {
  constructor(command, args, { cwd, env, signal, timeoutMs = 600000 }, spawnProcess = spawn) {
    this.pending = new Map()
    this.events = []
    this.sequence = 0
    this.child = spawnProcess(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.closed = new Promise(resolve => this.child.once('close', resolve))
    this.child.once('error', error => this.fail(error))
    this.child.once('close', (code, signal) => this.fail(new Error(`Codex app-server exited (${signal ?? code}). Check the CLI path, Codex configuration and codex login.`)))
    this.child.stdin.on('error', error => this.fail(error))
    // Do not relay stderr: third-party configuration may put credentials or prompt text there.
    this.child.stderr.resume()
    this.lines = createInterface({ input: this.child.stdout })
    this.lines.on('line', line => {
      try {
        const message = JSON.parse(line)
        if (message.method) {
          this.events.push(message)
          this.wake?.()
        } else {
          const request = this.pending.get(message.id)
          if (!request) return
          this.pending.delete(message.id)
          if (message.error) request.reject(new Error(`Codex ${request.method}: ${message.error.message}`))
          else request.resolve(message.result)
        }
      } catch {
        this.fail(new Error('Invalid JSON from Codex app-server stdout'))
      }
    })
    this.abort = () => {
      this.fail(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      this.child.kill()
    }
    this.signal = signal
    signal?.addEventListener('abort', this.abort, { once: true })
    if (signal?.aborted) this.abort()
    this.timer = setTimeout(() => {
      this.fail(new Error(`Codex app-server timed out after ${timeoutMs} ms`))
      this.child.kill()
    }, timeoutMs)
    this.timer.unref()
  }

  fail(error) {
    if (this.failure) return
    this.failure = error
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
    this.wake?.()
  }

  write(message) {
    if (this.failure) throw this.failure
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  request(method, params) {
    if (this.failure) return Promise.reject(this.failure)
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject })
      try { this.write({ id, method, params }) } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  async next() {
    while (!this.events.length) {
      if (this.failure) throw this.failure
      await new Promise(resolve => { this.wake = resolve })
      this.wake = undefined
    }
    if (this.failure) throw this.failure
    return this.events.shift()
  }

  async close() {
    clearTimeout(this.timer)
    this.signal?.removeEventListener('abort', this.abort)
    this.fail(new Error('Codex app-server closed'))
    this.child.kill()
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 1000)
    await this.closed
    clearTimeout(kill)
    this.lines.close()
  }
}
