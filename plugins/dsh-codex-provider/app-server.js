import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/** A JSON-RPC error returned by Codex for one client request. */
export class CodexRpcError extends Error {
  constructor(method, error) {
    super(`Codex ${method}: ${error?.message ?? 'request failed'}`)
    this.name = 'CodexRpcError'
    this.method = method
    this.rpcCode = error?.code
  }
}

/**
 * The answer for a server request this provider has no UI for. Codex reports the refusal to the
 * model, which continues with the DSH tools. Native tools are disabled, so these are rare.
 * @param message - the server request.
 * @returns a JSON-RPC response body (`result` or `error`).
 */
export function declineServerRequest(message) {
  switch (message.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { result: { decision: 'decline' } }
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { result: { decision: { denied: { rejection: 'DeepSeek Harness runs tools itself.' } } } }
    case 'item/permissions/requestApproval':
      return { result: { permissions: {}, scope: 'turn' } }
    case 'item/tool/requestUserInput':
      return { result: { answers: {} } }
    case 'mcpServer/elicitation/request':
      return { result: { action: 'decline', content: null, _meta: null } }
    default:
      return { error: { code: -32601, message: `Unsupported client interaction: ${message.method}` } }
  }
}

/**
 * One long-lived `codex app-server --stdio` process. Thread notifications and thread-scoped server
 * requests go to the listener registered for that thread; other server requests are declined.
 * After the process exits or breaks the protocol, every pending request and thread listener
 * receives the failure, and the connection cannot be reused.
 */
export class AppServerConnection {
  /**
   * @param executable - the Codex CLI that provides `app-server`; not a shell command line.
   * @param args - arguments, starting with `app-server`.
   * @param options - `cwd` and `env` for the child process.
   * @param spawnProcess - `child_process.spawn` replacement for tests.
   */
  constructor(executable, args, { cwd, env }, spawnProcess = spawn) {
    this.executable = executable
    this.pending = new Map()
    this.threads = new Map()
    this.sequence = 0
    this.failure = undefined
    this.child = spawnProcess(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.closed = new Promise(resolve => this.child.once('close', resolve))
    this.child.once('error', error => this.fail(error.code === 'ENOENT'
      ? Object.assign(new Error(`Codex app-server not found: ${executable}. Install the Codex CLI or set the Codex path in the Codex Provider settings.`), { code: 'ENOENT' })
      : error))
    this.child.once('close', (code, signal) => this.fail(new Error(`Codex app-server exited (${signal ?? code}). Check the Codex path, Codex configuration and codex login.`)))
    this.child.stdin.on('error', error => this.fail(error))
    // Do not relay stderr: third-party configuration may put credentials or prompt text there.
    this.child.stderr.resume()
    this.lines = createInterface({ input: this.child.stdout })
    this.lines.on('line', line => this.receive(line))
  }

  /**
   * Start the process and complete the `initialize` handshake.
   * @param clientInfo - Codex client identity (`name`, `title`, `version`).
   */
  async initialize(clientInfo) {
    const result = await this.request('initialize', { clientInfo, capabilities: { experimentalApi: true } })
    this.notify('initialized')
    return result
  }

  receive(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.fail(new Error('Invalid JSON from Codex app-server stdout'))
      this.child.kill()
      return
    }
    if (message.method === undefined) {
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      if (message.error) request.reject(new CodexRpcError(request.method, message.error))
      else request.resolve(message.result)
      return
    }
    const listener = this.threads.get(message.params?.threadId)
    if (listener) {
      listener(message)
    } else if (message.id !== undefined) {
      this.respond(message.id, declineServerRequest(message))
    }
  }

  fail(error) {
    if (this.failure) return
    this.failure = error
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
    const listeners = [...this.threads.values()]
    this.threads.clear()
    for (const listener of listeners) listener({ method: 'connection/failed', params: { error } })
  }

  write(message) {
    if (this.failure) throw this.failure
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  /**
   * Send one request.
   * @param method - app-server method.
   * @param params - request params.
   * @returns the `result` of the response; rejects with {@link CodexRpcError} or the connection failure.
   */
  request(method, params) {
    if (this.failure) return Promise.reject(this.failure)
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject })
      try {
        this.write({ id, method, params })
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  notify(method, params) {
    this.write(params === undefined ? { method } : { method, params })
  }

  /**
   * Answer a server request. A failed connection drops the answer: the request died with it.
   * @param id - server request id.
   * @param body - `{ result }` or `{ error }`.
   */
  respond(id, body) {
    if (!this.failure) this.write({ id, ...body })
  }

  /**
   * Route one thread's notifications and server requests to `listener`. A failed connection
   * delivers `connection/failed` once.
   * @param threadId - Codex thread id.
   * @param listener - receives each raw JSON-RPC message.
   * @returns the disposer.
   */
  subscribe(threadId, listener) {
    if (this.failure) {
      queueMicrotask(() => listener({ method: 'connection/failed', params: { error: this.failure } }))
      return () => {}
    }
    this.threads.set(threadId, listener)
    return () => {
      if (this.threads.get(threadId) === listener) this.threads.delete(threadId)
    }
  }

  /** Stop the process and wait for it to exit. */
  async close() {
    this.fail(new Error('Codex app-server closed'))
    this.child.kill()
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 1000)
    await this.closed
    clearTimeout(kill)
    this.lines.close()
  }
}
