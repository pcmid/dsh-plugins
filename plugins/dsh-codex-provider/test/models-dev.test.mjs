import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelsDev } from '../models-dev.js'

const DAY = 24 * 60 * 60 * 1000
const catalog = { openai: { models: {
  'gpt-a': { limit: { context: 400000 } }, 'gpt-b': { limit: { context: 1050000 } },
  zero: { limit: { context: 0 } }, fraction: { limit: { context: 1.5 } }, missing: {},
} }, anthropic: { models: { claude: { limit: { context: 200000 } } } } }

function setup(responses) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-models-dev-'))
  const file = join(dir, 'nested', 'models-dev.json')
  const requests = []
  const warnings = []
  const request = async url => {
    requests.push(url)
    const next = responses.shift()
    if (next instanceof Error) throw next
    return next
  }
  const store = () => new ModelsDev(file, { warn: message => warnings.push(message) }, request)
  return { dir, file, requests, warnings, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('the first load waits for models.dev, keeps valid OpenAI windows and caches them for a day', async () => {
  const t = setup([Response.json(catalog)])
  try {
    const models = t.store()
    await models.load()
    assert.deepEqual(t.requests, ['https://models.dev/api.json'])
    assert.deepEqual([models.window('gpt-a'), models.window('gpt-b'), models.window('zero'), models.window('claude')], [400000, 1050000, undefined, undefined])
    const saved = JSON.parse(readFileSync(t.file, 'utf8'))
    assert.deepEqual(saved.windows, { 'gpt-a': 400000, 'gpt-b': 1050000 })
    assert.ok(Math.abs(saved.fetchedAt - Date.now()) < 5000)
    await models.load()
    const restarted = t.store()
    await restarted.load()
    assert.equal(restarted.window('gpt-a'), 400000)
    assert.equal(t.requests.length, 1, 'A fresh cache is not fetched again, also after a restart')
  } finally { t.cleanup() }
})

test('a day-old cache answers at once and is refreshed in the background', async () => {
  const t = setup([Response.json({ openai: { models: { 'gpt-a': { limit: { context: 500000 } } } } })])
  try {
    mkdirSync(join(t.dir, 'nested'))
    writeFileSync(t.file, JSON.stringify({ fetchedAt: Date.now() - DAY - 1000, windows: { 'gpt-a': 272000 } }))
    const models = t.store()
    await models.load()
    assert.equal(models.window('gpt-a'), 272000, 'The stale value serves the first call')
    await models.refreshing
    assert.equal(models.window('gpt-a'), 500000)
    assert.deepEqual(JSON.parse(readFileSync(t.file, 'utf8')).windows, { 'gpt-a': 500000 })
    assert.equal(t.requests.length, 1)
  } finally { t.cleanup() }
})

test('failures are logged, never thrown, and retried after an hour', async () => {
  const t = setup([new Error('offline'), new Response('nope', { status: 503 })])
  try {
    const models = t.store()
    await models.load()
    await models.load()
    assert.equal(models.window('gpt-a'), undefined)
    assert.equal(t.requests.length, 1, 'No retry within the hour')
    assert.match(t.warnings[0], /models\.dev refresh failed: offline/)
    assert.ok(models.nextAttempt - Date.now() > 59 * 60 * 1000 && models.nextAttempt - Date.now() <= 60 * 60 * 1000)
    models.nextAttempt = 0
    await models.load()
    assert.match(t.warnings[1], /HTTP 503/)
  } finally { t.cleanup() }
})

test('an unreadable cache is ignored and fetched again', async () => {
  const t = setup([Response.json(catalog)])
  try {
    mkdirSync(join(t.dir, 'nested'))
    writeFileSync(t.file, '{"fetchedAt":')
    const models = t.store()
    await models.load()
    assert.equal(models.window('gpt-a'), 400000)
    assert.match(t.warnings[0], /ignoring models\.dev cache/)
  } finally { t.cleanup() }
})
