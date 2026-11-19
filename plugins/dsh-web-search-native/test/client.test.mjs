/**
 * The web search page's state machine: what it reads, what it stages, and what
 * one save writes. React rendering is not covered here.
 */
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

/** The module the browser build registers, loaded here through a stand-in loader. */
let handlers

before(async () => {
  const registered = []
  globalThis.window = {
    __ModuleLoader__: {
      load(handler) {
        registered.push(handler)
      },
    },
  }
  await import(new URL('../client.js', import.meta.url).href)
  assert.equal(registered.length, 1, 'the module registers exactly one factory')
  // The page state machine never renders, so a React stub is enough for the module body.
  const React = {
    createElement: () => null,
    Fragment: 'fragment',
    useEffect: () => {},
    useId: () => 'test',
    useRef: () => ({ current: null }),
    useState: value => [value, () => {}],
  }
  handlers = registered[0].factory(name => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${name}) in ${fileURLToPath(import.meta.url)}`)
  })
})

/** A configuration form over one namespace, with the write log its page controls. */
function form(value, { writable = true, base = {} } = {}) {
  const listeners = new Set()
  const writes = []
  let current = { status: 'ready', value, base, user: value, revision: 1, writable }
  return {
    writes,
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async mutate(ops) {
      writes.push(ops)
      const next = structuredClone(current.value)
      for (const op of ops) {
        if (op.op === 'set') next[op.path[0]] = op.value
        else delete next[op.path[0]]
      }
      current = { ...current, value: next, revision: current.revision + 1 }
      for (const listener of [...listeners]) listener()
      return true
    },
  }
}

const GROUPS = [
  { id: 'codex-provider', name: 'Codex Provider', models: [{ id: 'gpt-test', name: 'GPT Test' }] },
  { id: 'pool', name: 'pool', models: [
    { id: 'gpt-6-luna', name: 'GPT-6 Luna', reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }] } },
    { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
  ] },
  { id: 'ccmax', name: 'ccmax', models: [
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', reasoning: { efforts: [{ id: 'low', name: 'low' }] } },
  ] },
]

/** A stubbed remote that answers with `value`, or with what `value()` returns each call. */
const answer = value => async () => typeof value === 'function' ? value() : value

/** The section over stubbed forms and remotes; `channel` seeds this bundle's own entry. */
function page({ channel = {}, writable = true, directory, catalog } = {}) {
  const forms = { 'web-search-native': form({ providerId: 'native-search', ...channel }, { writable }) }
  const ctx = {
    configForms: { get: id => forms[id] },
    remote: {
      session: { modelCatalog: answer(catalog ?? { ok: true, value: { groups: GROUPS, failures: [] } }) },
    },
    connection: {
      rpc: { call: (base, name, payload) => {
        assert.deepEqual([base, name, payload], ['/api', 'pcmid/native-search/channels', {}])
        return answer(directory ?? { ok: true, value: [
          ['pool', 'openai-responses'], ['ccmax', 'anthropic-messages'], ['codex-provider', 'registered'],
        ] })()
      } },
    },
  }
  const controller = handlers.__page.createController(ctx)
  return { controller, forms, face: controller.face }
}

/** The section's hook, whatever name it publishes under. */
const channelHook = face => face.hooks.nativeSearchChannel

/** Let the section's queued reads settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

test('the section reads the protocols of the providers that can search', async () => {
  const { face } = page()
  channelHook(face).subscribe(() => {})
  await settle()
  const snapshot = channelHook(face).getSnapshot()
  assert.deepEqual([...snapshot.apis.keys()].sort(), ['ccmax', 'codex-provider', 'pool'])
  assert.equal(snapshot.apis.get('codex-provider'), 'registered')
  assert.equal(snapshot.apis.get('pool'), 'openai-responses')
  assert.equal(snapshot.apis.get('ccmax'), 'anthropic-messages')
  assert.equal(snapshot.modelsLoading, false)
})

test('a registered channel can be pinned without HTTP transport settings; unregistration removes the offer, not the pin', async () => {
  let rows = [['codex-provider', 'registered']]
  const { forms, face } = page({ directory: () => ({ ok: true, value: rows }) })
  channelHook(face).subscribe(() => {})
  await settle()
  face.pickChannel('codex-provider')
  face.pickModel('gpt-test')
  await settle()
  const saved = forms['web-search-native'].getSnapshot().value
  assert.equal(saved.followSession, false)
  assert.equal(saved.searchProvider, 'codex-provider')
  assert.equal(saved.searchModel, 'gpt-test')
  assert.equal(saved.searchTransport, undefined)
  rows = []
  face.retry()
  await settle()
  const snapshot = channelHook(face).getSnapshot()
  assert.equal(snapshot.apis.has('codex-provider'), false)
  assert.equal(snapshot.channel.provider, 'codex-provider')
})

test('without a local draft the page picks up a pin loaded or changed after mount', async () => {
  const { face, forms } = page()
  channelHook(face).subscribe(() => {})
  const current = () => channelHook(face).getSnapshot().channel
  assert.equal(current().follow, true)
  await forms['web-search-native'].mutate([
    { op: 'set', path: ['followSession'], value: false },
    { op: 'set', path: ['searchProvider'], value: 'codex-provider' },
    { op: 'set', path: ['searchModel'], value: 'gpt-test' },
  ])
  assert.equal(current().provider, 'codex-provider')
  assert.equal(current().follow, false)
  face.pickChannel('pool')
  assert.equal(current().provider, 'pool', 'an unsaved choice is still a local draft')
})

test('following the conversation is the default and pins nothing', async () => {
  const { face } = page()
  channelHook(face).subscribe(() => {})
  await settle()
  const snapshot = channelHook(face).getSnapshot()
  assert.equal(snapshot.channel.follow, true)
  assert.equal(snapshot.dirty, false)
})

test('a channel saves once its model is chosen, and each later choice saves too', async () => {
  const { forms, face } = page()
  channelHook(face).subscribe(() => {})
  await settle()
  const writes = forms['web-search-native'].writes
  assert.deepEqual(channelHook(face).getSnapshot().channel, { follow: true, provider: '', model: '', effort: '', transport: 'auto' })
  face.pickChannel('pool')
  await settle()
  // A channel without a model is not a usable search target, so nothing is stored yet.
  assert.deepEqual(writes, [])
  assert.equal(channelHook(face).getSnapshot().dirty, true)
  face.pickModel('gpt-6-luna')
  // Chosen while the first save runs: queued, then written over it.
  face.pickEffort('high')
  face.pickTransport('alpha-search')
  await settle()
  await settle()
  assert.ok(writes.length >= 2, 'the queued choices were written after the first save')
  assert.deepEqual(writes[0], [
    { op: 'set', path: ['followSession'], value: false },
    { op: 'set', path: ['searchProvider'], value: 'pool' },
    { op: 'set', path: ['searchModel'], value: 'gpt-6-luna' },
    { op: 'unset', path: ['searchReasoningEffort'] },
    { op: 'unset', path: ['searchTransport'] },
  ])
  const stored = forms['web-search-native'].getSnapshot().value
  assert.equal(stored.searchModel, 'gpt-6-luna')
  assert.equal(stored.searchReasoningEffort, 'high')
  assert.equal(stored.searchTransport, 'alpha-search')
  const snapshot = channelHook(face).getSnapshot()
  assert.equal(snapshot.dirty, false)
  assert.equal(snapshot.write.saved, true)
})

test('a pending save cannot commit or discard a newer pin that still needs a model', async () => {
  const { forms, face } = page()
  channelHook(face).subscribe(() => {})
  const form = forms['web-search-native']
  const firstWrite = Promise.withResolvers()
  const mutate = form.mutate
  form.mutate = async ops => { await firstWrite.promise; return mutate(ops) }
  face.pickChannel('pool')
  face.pickModel('gpt-6-astra')
  face.pickEffort('high')
  face.pickChannel('codex-provider')
  firstWrite.resolve()
  await settle()
  assert.equal(form.writes.length, 1)
  const snapshot = channelHook(face).getSnapshot()
  assert.equal(snapshot.channel.provider, 'codex-provider')
  assert.equal(snapshot.channel.model, '')
  assert.equal(snapshot.write.saved, false)
  face.pickModel('gpt-test')
  await settle()
  assert.equal(form.getSnapshot().value.searchModel, 'gpt-test')
})

test('switching back to follow saves at once and clears the pinned channel', async () => {
  const { forms, face } = page({ channel: { followSession: false, searchProvider: 'pool', searchModel: 'gpt-6-luna', searchReasoningEffort: 'high' } })
  channelHook(face).subscribe(() => {})
  await settle()
  assert.equal(channelHook(face).getSnapshot().channel.model, 'gpt-6-luna')
  face.pickChannel('')
  await settle()
  assert.deepEqual(forms['web-search-native'].writes, [[
    { op: 'unset', path: ['followSession'] },
    { op: 'unset', path: ['searchProvider'] },
    { op: 'unset', path: ['searchModel'] },
    { op: 'unset', path: ['searchReasoningEffort'] },
  ]])
})

test('a different channel starts from its own model, not the previous one', async () => {
  const { face } = page({ channel: { followSession: false, searchProvider: 'pool', searchModel: 'gpt-6-luna' } })
  channelHook(face).subscribe(() => {})
  await settle()
  face.pickChannel('ccmax')
  const channel = channelHook(face).getSnapshot().channel
  assert.equal(channel.provider, 'ccmax')
  assert.equal(channel.model, '')
})

test('choosing another model clears the effort that belonged to the old one', async () => {
  const { face } = page()
  channelHook(face).subscribe(() => {})
  await settle()
  face.pickChannel('pool')
  face.pickModel('gpt-6-luna')
  face.pickEffort('high')
  face.pickModel('gpt-6-astra')
  assert.equal(channelHook(face).getSnapshot().channel.effort, '')
})

test('a failed read is reported and keeps what the last good one showed', async () => {
  let fail = false
  const { face } = page({ catalog: () => fail ? { ok: false } : { ok: true, value: { groups: GROUPS, failures: [] } } })
  channelHook(face).subscribe(() => {})
  await settle()
  assert.equal(channelHook(face).getSnapshot().modelsFailed, false)
  fail = true
  face.retry()
  await settle()
  const snapshot = channelHook(face).getSnapshot()
  assert.equal(snapshot.modelsFailed, true)
  assert.deepEqual(snapshot.groups, GROUPS, 'the previous groups stay')
})

test('a registered provider whose model discovery failed can be retried without blocking other channels', async () => {
  let groups = GROUPS.filter(g => g.id !== 'codex-provider')
  const { face } = page({ catalog: () => ({ ok: true, value: { groups, failures: [] } }) })
  channelHook(face).subscribe(() => {})
  await settle()
  face.pickChannel('codex-provider')
  assert.equal(channelHook(face).getSnapshot().noModels, true)
  face.pickChannel('pool')
  assert.equal(channelHook(face).getSnapshot().noModels, false)
  face.pickChannel('codex-provider')
  groups = GROUPS
  face.retry()
  await settle()
  assert.equal(channelHook(face).getSnapshot().noModels, false)
})

test('a rejected write keeps the draft for correction', async () => {
  const { forms, face } = page()
  channelHook(face).subscribe(() => {})
  await settle()
  forms['web-search-native'].mutate = async (ops) => { forms['web-search-native'].writes.push(ops); return false }
  face.pickChannel('pool')
  face.pickModel('gpt-6-luna')
  await settle()
  const snapshot = channelHook(face).getSnapshot()
  assert.equal(snapshot.write.failed, true)
  assert.equal(snapshot.dirty, true, 'the draft survives')
  assert.equal(snapshot.channel.model, 'gpt-6-luna')
})

test('a read-only deployment stages nothing', async () => {
  const { face } = page({ writable: false })
  channelHook(face).subscribe(() => {})
  await settle()
  face.pickChannel('pool')
  const snapshot = channelHook(face).getSnapshot()
  assert.equal(snapshot.readOnly, true)
  assert.equal(snapshot.dirty, false)
  assert.equal(snapshot.channel.follow, true)
})

test('discarding staged edits returns to the stored values', async () => {
  const { face } = page({ channel: { followSession: false, searchProvider: 'ccmax', searchModel: 'claude-haiku-5-5' } })
  channelHook(face).subscribe(() => {})
  await settle()
  face.pickChannel('pool')
  assert.equal(channelHook(face).getSnapshot().dirty, true)
  face.discard()
  const snapshot = channelHook(face).getSnapshot()
  assert.equal(snapshot.dirty, false)
  assert.equal(snapshot.dirty, false)
  assert.deepEqual(snapshot.channel, { follow: false, provider: 'ccmax', model: 'claude-haiku-5-5', effort: '', transport: 'auto' })
})

test('the section state is released with the plugin', () => {
  const { controller, face } = page()
  let notified = 0
  channelHook(face).subscribe(() => { notified += 1 })
  const before = notified
  controller.dispose()
  face.pickChannel('pool')
  assert.equal(notified, before, 'no publication after disposal')
})

test('every menu trigger is the anchor its popover positions against', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  // Without anchor-name the popover has no anchor and lands at the viewport origin.
  const trigger = source.split('\n').find(line => line.startsWith('.${PREFIX}-trigger {'))
  assert.ok(trigger?.includes('anchor-name: var(--${PREFIX}-anchor)'), 'the trigger rule declares the anchor')
  const menu = source.split('\n').find(line => line.startsWith('.${PREFIX}-menu {'))
  assert.ok(menu?.includes('position-anchor: var(--${PREFIX}-anchor)'), 'the menu positions against the same anchor')
})

test('every copy key the page reads exists in both dictionaries', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const block = (from, to) => source.slice(source.indexOf(from), source.indexOf(to))
  const keys = text => new Set([...text.matchAll(/^\s{6}([a-zA-Z]+):/gm)].map(match => match[1]))
  const zh = keys(block('const zh = {', 'const en = {'))
  const en = keys(block('const en = {', 'const CHEVRON'))
  const used = [...new Set([...source.matchAll(/\bt\('([a-zA-Z]+)'/g)].map(match => match[1]))]
  assert.deepEqual(used.filter(key => !zh.has(key)), [], 'zh covers every key')
  assert.deepEqual(used.filter(key => !en.has(key)), [], 'en covers every key')
})
