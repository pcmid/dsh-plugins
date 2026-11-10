import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { LlmAdapter, attributionHeaders } from '@deepseek-ai/dsh-llm'
import { AppServer } from './rpc.js'
import { projectRequest, readStep } from './protocol.js'

export const name = 'codex-provider'
export const inject = ['llm']
export const Config = z.object({
  command: z.string().default('codex').description('Path to the Codex CLI (tested with 0.167.0).'),
  codexHome: z.string().description('Optional CODEX_HOME; uses the CLI login from this directory.'),
  models: z.array(z.string()).default([]).description('Model IDs to show; empty discovers models through app-server.'),
  contextWindow: z.natural().min(1).default(128000).description('Conservative DSH context budget. Set this to the capacity of the selected model.'),
  timeoutMs: z.natural().min(1000).max(2147483647).default(600000).description('Maximum time for one model step, including startup.'),
})

const disabledFeatures = ['shell_tool', 'apps', 'hooks', 'memories', 'multi_agent', 'multi_agent_v2',
  'code_mode', 'code_mode_only', 'computer_use', 'browser_use', 'image_generation', 'view_image',
  'token_budget', 'goals', 'sleep_tool', 'request_permissions_tool', 'tool_suggest']

export class CodexAdapter extends LlmAdapter {
  constructor(config = {}, clientFactory = (command, args, options) => new AppServer(command, args, options)) {
    super()
    this.config = { command: 'codex', models: [], contextWindow: 128000, timeoutMs: 600000, ...config }
    this.clientFactory = clientFactory
    this.clients = new Set()
    this.disposed = false
  }

  providerInfo(provider) { return { id: provider, name: 'Codex Provider' } }

  modelInfo(provider, model) {
    const metadata = this.catalog?.find(entry => entry.model === model)
    const efforts = metadata?.supportedReasoningEfforts ?? []
    return { provider, id: model, name: metadata?.displayName ?? model, inputModalities: ['text'],
      context: { contextWindow: this.config.contextWindow },
      ...(efforts.length ? { reasoning: {
        efforts: efforts.map(effort => ({ id: effort.reasoningEffort, name: effort.reasoningEffort, description: effort.description })),
        defaultEffort: metadata.defaultReasoningEffort,
      } } : {}) }
  }

  async resolveModel(provider, model, signal) {
    await this.loadCatalog(signal)
    return this.modelInfo(provider, model)
  }

  async open(signal) {
    signal?.throwIfAborted()
    if (this.disposed) throw new Error('Codex provider has been disposed')
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-codex-'))
    let rpc
    try {
      signal?.throwIfAborted()
      if (this.disposed) throw new Error('Codex provider has been disposed')
      const overrides = { sqlite_home: cwd, log_dir: cwd, 'features.apps': false, 'features.hooks': false,
        'features.memories': false, project_doc_max_bytes: 0 }
      const args = ['app-server', '--stdio', ...Object.entries(overrides).flatMap(([k, v]) => ['-c', `${k}=${JSON.stringify(v)}`])]
      rpc = this.clientFactory(this.config.command, args, { cwd, signal, timeoutMs: this.config.timeoutMs,
        env: { ...process.env, ...(this.config.codexHome ? { CODEX_HOME: this.config.codexHome } : {}) } })
      this.clients.add(rpc)
      await rpc.request('initialize', { clientInfo: { name: 'deepseek-harness', title: attributionHeaders()['user-agent'], version: '0.1.0' },
        capabilities: { experimentalApi: true } })
      rpc.write({ method: 'initialized' })
      return { rpc, cwd }
    } catch (error) {
      if (rpc) { await rpc.close(); this.clients.delete(rpc) }
      await rm(cwd, { recursive: true, force: true })
      throw error
    }
  }

  async close({ rpc, cwd }) {
    await rpc.close()
    this.clients.delete(rpc)
    await rm(cwd, { recursive: true, force: true })
  }

  async loadCatalog(signal) {
    signal?.throwIfAborted()
    if (this.catalog) return this.catalog
    const instance = await this.open(signal)
    try {
      const models = []
      let cursor
      do {
        const page = await instance.rpc.request('model/list', { cursor, limit: 100 })
        models.push(...page.data)
        cursor = page.nextCursor
      } while (cursor)
      this.catalog = models
      return this.catalog
    } finally { await this.close(instance) }
  }

  async listModels(provider) {
    const ids = this.config.models.length ? this.config.models : (await this.loadCatalog()).map(model => model.model)
    return ids.map(model => this.modelInfo(provider, model))
  }

  async startStep({ rpc, cwd }, options, projected) {
    const { config } = await rpc.request('config/read', { includeLayers: false })
    const threadConfig = { web_search: 'disabled', project_doc_max_bytes: 0,
      model_auto_compact_token_limit: Number.MAX_SAFE_INTEGER,
      ...Object.fromEntries(disabledFeatures.map(feature => [`features.${feature}`, false])) }
    const provider = config.model_provider ?? 'openai'
    threadConfig[`model_providers.${JSON.stringify(provider)}.name`] = config.model_providers?.[provider]?.name ?? provider
    threadConfig[`model_providers.${JSON.stringify(provider)}.http_headers`] = {
      ...config.model_providers?.[provider]?.http_headers, ...attributionHeaders(),
    }
    for (const key of Object.keys(config.mcp_servers ?? {})) threadConfig[`mcp_servers.${JSON.stringify(key)}.enabled`] = false
    for (const key of Object.keys(config.plugins ?? {})) threadConfig[`plugins.${JSON.stringify(key)}.enabled`] = false
    const started = await rpc.request('thread/start', {
      model: options.model, cwd, ephemeral: true, environments: [], selectedCapabilityRoots: [],
      approvalPolicy: 'never', sandbox: 'read-only', experimentalRawEvents: true,
      baseInstructions: projected.instructions || 'Follow the conversation instructions.',
      developerInstructions: 'DeepSeek Harness owns all tools and scheduling. Call only the supplied dsh_ tools. Do not use native Codex tools. Use workspace paths supplied by Harness, not this provider temporary directory. Tool results arrive through the conversation history.',
      dynamicTools: projected.dynamicTools, config: threadConfig,
    })
    const threadId = started.thread.id
    if (projected.items.length) await rpc.request('thread/inject_items', { threadId, items: projected.items })
    // shortcut: temperature/maxTokens/stop have no app-server equivalents; add them when the protocol supports them.
    const { turn } = await rpc.request('turn/start', { threadId, input: [], ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}) })
    return { threadId, turnId: turn.id }
  }

  async *stream(options) {
    const projected = projectRequest(options)
    const instance = await this.open(options.signal)
    const { rpc } = instance
    try {
      const { threadId, turnId } = await this.startStep(instance, options, projected)
      yield* readStep(rpc, threadId, turnId, projected.names)
    } finally {
      // Closing also cancels unanswered dynamic-tool RPCs; no tool success is fabricated.
      await this.close(instance)
    }
  }

  async dispose() {
    this.disposed = true
    await Promise.all([...this.clients].map(client => client.close()))
  }
}

export function apply(ctx, config) {
  const adapter = new CodexAdapter(config)
  ctx.effect(() => ctx.llm.registerAdapter(['codex-provider'], adapter))
  ctx.on('dispose', () => adapter.dispose())
}
