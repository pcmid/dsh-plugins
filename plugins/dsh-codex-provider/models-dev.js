import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const CATALOG_URL = 'https://models.dev/api.json'
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 15000
const valid = ([, window]) => Number.isInteger(window) && window > 0

/**
 * Context windows of OpenAI models listed by models.dev, kept in one JSON cache file and fetched
 * again once the cache is a day old. A failed fetch is logged and retried after an hour; it never
 * fails a model request.
 */
export class ModelsDev {
  /**
   * @param file - cache file holding `{ fetchedAt, windows: { [model]: contextWindow } }`.
   * @param logger - receives `warn` for unreadable caches and failed fetches.
   * @param request - `fetch`, replaceable in tests.
   */
  constructor(file, logger, request = fetch) {
    this.file = file
    this.logger = logger
    this.request = request
    this.windows = new Map()
    this.nextAttempt = 0
    this.reading = undefined
    this.refreshing = undefined
  }

  /** models.dev's context window for an OpenAI model id, if it lists one. */
  window(model) {
    return this.windows.get(model)
  }

  /** Read the cache once and start a refresh when one is due; waits for the refresh only while nothing is cached. */
  async load() {
    this.reading ??= this.read()
    await this.reading
    if (Date.now() >= this.nextAttempt) this.refreshing ??= this.refresh().finally(() => { this.refreshing = undefined })
    if (!this.windows.size) await this.refreshing
  }

  async read() {
    try {
      const { fetchedAt, windows } = JSON.parse(await readFile(this.file, 'utf8'))
      this.windows = new Map(Object.entries(windows).filter(valid))
      // A missing or future timestamp makes the cache due now or within a day, never later.
      this.nextAttempt = Number.isFinite(fetchedAt) ? Math.min(fetchedAt, Date.now()) + DAY : 0
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.warn(`codex-provider: ignoring models.dev cache ${this.file}: ${error?.message}`)
    }
  }

  async refresh() {
    const now = Date.now()
    try {
      const response = await this.request(CATALOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const catalog = await response.json()
      const windows = Object.fromEntries(Object.entries(catalog?.openai?.models ?? {})
        .map(([id, model]) => [id, model?.limit?.context]).filter(valid))
      if (!Object.keys(windows).length) throw new Error('the catalog lists no OpenAI context windows')
      this.windows = new Map(Object.entries(windows))
      this.nextAttempt = now + DAY
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(this.file, JSON.stringify({ fetchedAt: now, windows }))
    } catch (error) {
      // After a fetched catalog fails to save, the next fetch still waits a day.
      this.nextAttempt = Math.max(this.nextAttempt, now + HOUR)
      this.logger?.warn(`codex-provider: models.dev refresh failed: ${error?.message}`)
    }
  }
}
