import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import {
  APP_IDENTITY, CONTEXT_WINDOW_EXCEEDED_CODE, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import { AppServerConnection, CodexRpcError } from './app-server.js'
import { CodexTurnError, Conversation, planContinuation } from './conversation.js'
import { MessageKeys, splitInstructions, threadSpec, toolNames } from './history.js'
import { ModelsDev } from './models-dev.js'

export const name = 'codex-provider'
export const inject = ['llm']

const Profile = z.object({
  codexPath: z.string().description('Codex CLI executable that runs `app-server`; empty runs codex from PATH.'),
})

export const Config = z.object({
  // Volatile: the Models page reads and writes it, and changes apply without a restart.
  providers: z.dict(Profile).default({}).volatile().description('Enabled from Settings → Models; absent keeps the provider off.'),
  codexHome: z.string().description('Optional CODEX_HOME; uses the CLI login from this directory.'),
  models: z.array(z.string()).default([]).description('Model IDs to show; empty discovers models through app-server.'),
  contextWindow: z.natural().min(1).description('DSH context budget. Empty uses the window Codex reports for the model; before that, the models.dev value, else 128000.'),
  timeoutMs: z.natural().min(1000).max(2147483647).default(600000).description('Maximum time for one model step.'),
  idleTimeoutMs: z.natural().min(1000).max(2147483647).default(1800000).description('Release a session\'s Codex thread after this long without a request; the next request rebuilds it from DSH history.'),
})

const FALLBACK_CONTEXT_WINDOW = 128000

// Keep Codex from adding its own instructions, context, tools and integrations to DSH requests.
// These are process settings: several of them are read when the process or thread is created,
// and thread-level overrides of them do not take effect.
const DISABLED_FEATURES = ['shell_tool', 'unified_exec', 'view_image', 'sleep_tool', 'code_mode', 'code_mode_only',
  'multi_agent', 'multi_agent_v2', 'goals', 'apps', 'plugins', 'memories', 'hooks', 'image_generation',
  'computer_use', 'browser_use', 'in_app_browser', 'tool_suggest', 'request_permissions_tool', 'token_budget']
const PROCESS_CONFIG = Object.freeze({
  include_permissions_instructions: false,
  include_apps_instructions: false,
  include_collaboration_mode_instructions: false,
  include_environment_context: false,
  'skills.include_instructions': false,
  'tools.experimental_request_user_input.enabled': false,
  web_search: 'disabled',
  project_doc_max_bytes: 0,
  // DSH owns compaction.
  model_auto_compact_token_limit: Number.MAX_SAFE_INTEGER,
  // Codex sub-agents (the `collaboration` tools and `<multi_agent_*>` instructions). Model
  // metadata such as `multi_agent_version: "v2"` turns them on regardless of
  // `features.multi_agent`; only this setting overrides the model.
  'agents.enabled': false,
  ...Object.fromEntries(DISABLED_FEATURES.map(feature => [`features.${feature}`, false])),
})

const ERROR_CODES = {
  contextWindowExceeded: CONTEXT_WINDOW_EXCEEDED_CODE,
  usageLimitExceeded: QUOTA_EXCEEDED_CODE,
  sessionBudgetExceeded: QUOTA_EXCEEDED_CODE,
  rateLimitExceeded: 'RATE_LIMIT',
  serverOverloaded: 'SERVER',
  internalServerError: 'SERVER',
  flexUnavailable: 'SERVER',
  policyCapacityUnavailable: 'SERVER',
  unauthorized: 'AUTH',
  badRequest: 'BAD_REQUEST',
  modelNotFound: 'BAD_REQUEST',
  cyberPolicy: 'CONTENT_POLICY',
  misalignmentPolicyViolation: 'CONTENT_POLICY',
  httpConnectionFailed: 'TRANSPORT',
  responseStreamConnectionFailed: 'TRANSPORT',
  responseStreamDisconnected: 'TRANSPORT',
  responseTooManyFailedAttempts: 'TRANSPORT',
}

/**
 * Convert a Codex or transport failure to a DSH `LlmError`; aborts pass through unchanged.
 * @param error - the thrown value.
 * @param signal - the request's own signal, to tell its abort from the step timeout.
 * @param timeoutMs - the step timeout, for the message.
 * @returns the error to throw.
 */
export function toLlmError(error, signal, timeoutMs) {
  if (signal?.aborted) return signal.reason ?? error
  if (error instanceof LlmError) return error
  if (error?.name === 'TimeoutError') return new LlmError(`Codex did not finish within ${timeoutMs} ms`, 'TIMEOUT', { cause: error })
  if (error?.name === 'AbortError') return new LlmError(error.message || 'Codex turn interrupted', 'TRANSPORT', { cause: error })
  if (error instanceof CodexTurnError) {
    const info = error.info
    const kind = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : undefined
    const status = kind && typeof info === 'object' ? info[kind]?.httpStatusCode ?? undefined : undefined
    return new LlmError(error.message, ERROR_CODES[kind] ?? 'PROVIDER', {
      cause: error, ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    })
  }
  if (error?.code === 'ENOENT') return new LlmError(error.message, 'CODEX_CLI_MISSING', { cause: error })
  if (error instanceof CodexRpcError) return new LlmError(error.message, 'PROVIDER', { cause: error })
  return new LlmError(error?.message || 'Codex app-server failed', 'TRANSPORT', { cause: error })
}

/**
 * DSH model provider backed by one long-lived `codex app-server`. Each DSH session keeps one
 * Codex thread whose turn pauses on DSH tool calls; DSH executes the tools and the next step
 * returns their results to the same turn. A request that does not continue the thread exactly
 * starts a new thread from the DSH history.
 */
export class CodexAdapter extends LlmAdapter {
  /**
   * @param config - resolved plugin config plus the selected `codexPath`.
   * @param connect - `(executable, args, options) => connection`, replaceable in tests.
   * @param modelsDev - optional `ModelsDev` cache for context windows before Codex reports one.
   */
  constructor(config = {}, connect = (executable, args, options) => new AppServerConnection(executable, args, options), modelsDev = undefined) {
    super()
    this.modelsDev = modelsDev
    this.config = { models: [], timeoutMs: 600000, idleTimeoutMs: 1800000, ...config }
    // The executable is spawned without a shell, so expand a leading `~` here.
    const codexPath = config.codexPath?.trim() || 'codex'
    this.config.codexPath = codexPath === '~' || codexPath.startsWith('~/') ? join(homedir(), codexPath.slice(2)) : codexPath
    this.connect = connect
    this.connection = undefined
    this.conversations = new Map()
    this.contextWindows = new Map()
    this.keys = new MessageKeys()
    this.active = 0
    this.starting = undefined
    this.disposed = false
  }

  providerInfo(provider) { return { id: provider, name: 'Codex Provider' } }

  modelInfo(provider, model) {
    const metadata = this.catalog?.find(entry => entry.model === model)
    const efforts = metadata?.supportedReasoningEfforts ?? []
    const contextWindow = this.config.contextWindow ?? this.contextWindows.get(model) ?? this.modelsDev?.window(model) ?? FALLBACK_CONTEXT_WINDOW
    return { provider, id: model, name: metadata?.displayName ?? model, inputModalities: ['text'],
      context: { contextWindow },
      ...(efforts.length ? { reasoning: {
        efforts: efforts.map(effort => ({ id: effort.reasoningEffort, name: effort.reasoningEffort, description: effort.description })),
        defaultEffort: metadata.defaultReasoningEffort,
      } } : {}) }
  }

  async resolveModel(provider, model, signal) {
    await this.modelsDev?.load()
    try {
      await this.loadCatalog(signal)
    } catch (error) {
      if (!this.config.models.includes(model)) throw toLlmError(error, signal)
    }
    return this.modelInfo(provider, model)
  }

  async listModels(provider) {
    await this.modelsDev?.load()
    if (this.config.models.length) return this.config.models.map(model => this.modelInfo(provider, model))
    try {
      return (await this.loadCatalog()).map(model => this.modelInfo(provider, model.model))
    } catch (error) {
      throw toLlmError(error)
    }
  }

  async loadCatalog(signal) {
    if (this.catalog) return this.catalog
    this.active++
    try {
      const connection = await this.open(signal)
      const models = []
      let cursor
      do {
        const page = await connection.request('model/list', { cursor, limit: 100 })
        models.push(...page.data)
        cursor = page.nextCursor
      } while (cursor)
      this.catalog = models
      return models
    } finally {
      this.active--
      this.release()
    }
  }

  /** The shared app-server, started on first use and again after it exits. */
  open(signal) {
    signal?.throwIfAborted()
    if (this.disposed) throw new LlmError('Codex provider has been disposed', 'PROVIDER')
    clearTimeout(this.idleTimer)
    if (this.connection && !this.connection.failure) return Promise.resolve(this.connection)
    this.connection = undefined
    this.starting ??= this.start().then(connection => {
      this.starting = undefined
      if (this.disposed) {
        void connection.close()
        throw new LlmError('Codex provider has been disposed', 'PROVIDER')
      }
      this.connection = connection
      return connection
    }, error => {
      this.starting = undefined
      throw error
    })
    if (!signal) return this.starting
    return Promise.race([this.starting, new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })])
  }

  async start() {
    const workdir = mkdtempSync(join(tmpdir(), 'dsh-codex-'))
    const env = { ...process.env, ...(this.config.codexHome ? { CODEX_HOME: this.config.codexHome } : {}) }
    const launch = async servers => {
      // State and logs stay out of the user's CODEX_HOME; authentication still comes from it.
      const overrides = { sqlite_home: workdir, log_dir: workdir, ...PROCESS_CONFIG }
      for (const server of servers) overrides[`mcp_servers.${server}.enabled`] = false
      const args = ['app-server', '--stdio', ...Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])]
      const connection = this.connect(this.config.codexPath, args, { cwd: workdir, env })
      try {
        await connection.initialize({ name: APP_IDENTITY.product, title: 'DeepSeek Harness', version: APP_IDENTITY.version })
        const { config } = await connection.request('config/read', { includeLayers: false })
        return { connection, config }
      } catch (error) {
        await connection.close()
        throw error
      }
    }
    try {
      let { connection, config } = await launch([])
      // MCP servers from the user's Codex config would start for every thread and add their tools.
      // Only the process configuration can disable them, so restart once with each one disabled.
      // A `-c` key cannot quote a dotted server name; such servers stay as configured.
      const servers = Object.entries(config?.mcp_servers ?? {})
        .filter(([server, value]) => value?.enabled !== false && /^[A-Za-z0-9_-]+$/.test(server)).map(([server]) => server)
      if (servers.length) {
        await connection.close()
        ;({ connection } = await launch(servers))
      }
      connection.workdir = workdir
      void connection.closed.then(() => rm(workdir, { recursive: true, force: true }))
      return connection
    } catch (error) {
      await rm(workdir, { recursive: true, force: true })
      throw error
    }
  }

  /** Close the app-server after it has gone unused for the idle timeout. */
  release() {
    if (this.active || this.conversations.size || !this.connection) return
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.active || this.conversations.size || !this.connection) return
      const connection = this.connection
      this.connection = undefined
      void connection.close()
    }, this.config.idleTimeoutMs)
    this.idleTimer.unref?.()
  }

  prepare(options) {
    const { instructions, messages } = splitInstructions(options)
    const names = toolNames(options.tools)
    return {
      provider: options.provider, model: options.model, effort: options.reasoningEffort,
      instructions, names, messages, keys: messages.map(message => this.keys.of(message)),
      spec: threadSpec(options.model, instructions, names.specs),
    }
  }

  async startThread(request, signal) {
    const connection = await this.open(signal)
    const { thread } = await connection.request('thread/start', {
      model: request.model, cwd: connection.workdir, ephemeral: true, environments: [], selectedCapabilityRoots: [],
      approvalPolicy: 'never', sandbox: 'read-only', experimentalRawEvents: true,
      baseInstructions: request.instructions || 'You are a helpful assistant.',
      dynamicTools: request.names.specs,
      // The thread's effort is the request-level baseline. Without it the baseline comes from the
      // user's Codex config, and `turn/start` effort only adds a `configuration_update` item on top,
      // which lowers the effort but raises it only part of the way.
      ...(request.effort ? { config: { model_reasoning_effort: request.effort } } : {}),
    })
    return new Conversation(connection, thread.id, request, (model, window) => this.contextWindows.set(model, window))
  }

  drop(conversation, key) {
    conversation.dispose()
    if (key !== undefined && this.conversations.get(key) === conversation) this.conversations.delete(key)
  }

  async *stream(options) {
    const request = this.prepare(options)
    // Auxiliary calls (titles, summaries) never touch the session's thread.
    const key = options.purpose === undefined ? options.sessionId : undefined
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    this.active++
    let conversation
    let owned = false
    let finished = false
    try {
      const existing = key === undefined ? undefined : this.conversations.get(key)
      let plan
      if (existing && !existing.busy) {
        plan = !existing.broken && existing.connection === this.connection ? planContinuation(existing, request) : undefined
        if (plan) conversation = existing
        else this.drop(existing, key)
      }
      if (!conversation) {
        conversation = await this.startThread(request, signal)
        plan = { kind: 'start' }
        // A concurrent request for a busy session gets its own temporary thread.
        owned = key !== undefined && !this.conversations.get(key)?.busy
        if (owned) this.conversations.set(key, conversation)
      } else {
        owned = true
      }
      conversation.busy = true
      clearTimeout(conversation.idleTimer)
      await conversation.begin(plan, request)
      for await (const chunk of conversation.read(request, signal)) {
        if (chunk.type === 'finish') finished = true
        yield chunk
      }
    } catch (error) {
      throw toLlmError(error, options.signal, this.config.timeoutMs)
    } finally {
      if (conversation) {
        conversation.busy = false
        if (finished && owned && !conversation.broken) {
          conversation.idle(this.config.idleTimeoutMs, () => {
            this.drop(conversation, key)
            this.release()
          })
        } else {
          this.drop(conversation, owned ? key : undefined)
        }
      }
      this.active--
      this.release()
    }
  }

  async dispose() {
    this.disposed = true
    clearTimeout(this.idleTimer)
    for (const [key, conversation] of this.conversations) this.drop(conversation, key)
    const connection = this.connection
    this.connection = undefined
    await connection?.close()
  }
}

export function apply(ctx, config) {
  const settingsNs = ctx.fiber?.entry?.options.id ?? name
  ctx.llm.registerConfigurableProviders([{ provider: name, displayName: 'Codex Provider', settingsNs,
    settingsPath: ['providers', name], nativeAuth: { env: [], oauth: true } }])
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  const { providers, ...options } = config
  const home = ctx.get('profileContext')?.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const modelsDev = new ModelsDev(join(home, 'codex-provider', 'models-dev.json'), ctx.logger)
  // The route exists only while the Models page has enabled the provider; a changed
  // app-server path replaces the adapter and its app-server process.
  let current
  const sync = () => {
    const selected = providers.get()?.[name]
    const codexPath = selected === undefined ? undefined : selected.codexPath?.trim() || 'codex'
    if (codexPath === current?.codexPath) return
    if (current) {
      current.unregister()
      void current.adapter.dispose()
    }
    current = undefined
    if (codexPath === undefined) return
    const adapter = new CodexAdapter({ ...options, codexPath }, undefined, modelsDev)
    current = { codexPath, adapter, unregister: ctx.llm.registerAdapter([name], adapter) }
  }
  sync()
  ctx.on('loader/volatile-update', sync)
  ctx.on('dispose', () => {
    current?.unregister()
    return current?.adapter.dispose()
  })
}
