// Controller of client/10-mcp.js against fake Settings form, manager, and
// credential Remotes: origins, paste → add, secret ordering and rollback,
// minimal overrides, delete cleanup, enable toggles, batch import, scrubbing.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Like load-part.mjs, plus the timer and abort globals the controller uses.
function loadController() {
  const body = ['00-core.js', '10-mcp.js'].map(name => readFileSync(join(root, 'client', name), 'utf8')).join('\n')
  const source = `(function factory(require) {\n'use strict';\n${body}\nreturn { createMcpController, McpSection, McpSectionIcon, DICT };\n})`
  const stubReact = {
    createElement: () => null, Fragment: 'Fragment', forwardRef: fn => fn,
    useCallback: fn => fn, useEffect: () => {}, useId: () => 'id', useLayoutEffect: () => {}, useMemo: fn => fn(), useRef: v => ({ current: v }), useState: v => [v, () => {}],
  }
  const globals = { window: {}, CSS: { escape: s => s }, console, URL, JSON, Math, Date, Intl, structuredClone, setTimeout, clearTimeout, AbortController }
  return vm.runInNewContext(source, globals)(id => (id === 'react' ? stubReact : {}))
}

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
function merge(a, b) {
  if (!isObject(a) || !isObject(b)) return b === undefined ? a : b
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v)
  return out
}
const DEFAULTS = { command: '', args: [], env: {}, cwd: '', url: '', headers: {}, enabled: true, startupTimeoutMs: 30000, reconnect: {} }

function fakeForm(base, user) {
  const state = { base: structuredClone(base), user: structuredClone(user), revision: 1 }
  const listeners = new Set()
  const log = []
  let refuse = false
  let snapshot
  const compute = () => {
    const names = new Set([...Object.keys(state.base.servers ?? {}), ...Object.keys(state.user.servers ?? {})])
    const servers = {}
    for (const name of names) servers[name] = { ...DEFAULTS, ...merge(state.base.servers?.[name], state.user.servers?.[name]) }
    snapshot = { status: 'ready', value: { servers }, base: structuredClone(state.base), user: structuredClone(state.user), revision: state.revision, writable: true }
  }
  compute()
  return {
    log,
    refuseNext() { refuse = true },
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async mutate(ops) {
      log.push(JSON.parse(JSON.stringify(ops)))
      await Promise.resolve()
      if (refuse) { refuse = false; return false }
      for (const op of ops) {
        let node = state.user
        const path = [...op.path]
        const last = path.pop()
        for (const key of path) node = node[key] = isObject(node[key]) ? node[key] : {}
        if (op.op === 'set') node[last] = structuredClone(op.value)
        else delete node[last]
      }
      state.revision += 1
      compute()
      for (const listener of [...listeners]) listener()
      return true
    },
  }
}

function channel() {
  let current = []
  let wake = null
  return {
    push(list) { current = list; wake?.() },
    open(signal) {
      let sent = null
      return {
        disposed: false,
        dispose() { this.disposed = true; wake?.() },
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted && !this.disposed) {
            if (sent !== current) { sent = current; yield current; continue }
            await new Promise(resolve => { wake = resolve; signal.addEventListener('abort', resolve, { once: true }) })
          }
        },
      }
    },
  }
}

function setup({ base = { servers: {} }, user = { servers: {} }, runtime = [] } = {}) {
  const mod = loadController()
  const form = fakeForm(base, user)
  const stream = channel()
  stream.push(runtime)
  const events = []
  const secrets = new Map()
  const ok = value => ({ ok: true, value })
  const ctx = {
    configForms: { get: ns => { assert.equal(ns, 'mcp-manager'); return form } },
    connection: { rpc: { call: async (_channel, path, payload) => { events.push(['rpc', path, payload]); return ok({ tools: [{ name: 'search', description: 'Search things\nmore' }] }) } } },
    remote: {
      mcpManager: {
        watch: signal => stream.open(signal),
        restart: async name => { events.push(['restart', name]); return ok() },
        probe: async name => { events.push(['probe', name]); return ok({ ok: true, toolNames: ['a', 'b'], truncated: false, durationMs: 12, closeConfirmed: true }) },
      },
      credentials: {
        failSet: false,
        describe: async refs => ok(Object.fromEntries(refs.map(ref => [ref, { configured: secrets.has(ref), writable: true }]))),
        async set(ref, value) { events.push(['set', ref]); if (this.failSet) return { ok: false, error: { code: 'x', message: 'no store' } }; secrets.set(ref, value); return ok() },
        unset: async ref => { events.push(['unset', ref]); secrets.delete(ref); return ok() },
      },
    },
  }
  const t = key => mod.DICT.en[key] ?? key
  const controller = mod.createMcpController(ctx, t)
  const face = controller.face
  const store = face.hooks.mcp
  form.log.length = 0
  return { mod, form, stream, events, secrets, ctx, controller, face, store, state: () => store.getSnapshot() }
}

const flush = async (n = 6) => { for (let i = 0; i < n; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) }
const plain = value => JSON.parse(JSON.stringify(value))

test('rows carry origin, transport, summary, and live status; plugin servers come from the stream', async () => {
  const env = setup({
    base: { servers: { fs: { transport: 'stdio', command: 'npx', args: ['-y', '@x/server-fs', '/My Docs'] }, ov: { transport: 'streamable-http', url: 'https://ov.dev/mcp' } } },
    user: { servers: { gh: { transport: 'stdio', command: 'gh-mcp', enabled: false }, ov: { headers: { A: 'b' } } } },
    runtime: [{ name: 'fs', configured: true, status: { state: 'connected', toolCount: 4, connectedAt: 1 } }, { name: 'plug', configured: false, status: { state: 'connecting', attempt: 1 } }],
  })
  assert.equal(env.state().runtime.status, 'idle')
  const stop = env.face.watch()
  await flush()
  const rows = plain(env.state().servers).map(r => [r.name, r.origin, r.transport, r.summary, r.enabled, r.status?.state ?? null])
  assert.deepEqual(rows, [
    ['fs', 'inherited', 'stdio', "npx -y @x/server-fs '/My Docs'", true, 'connected'],
    ['ov', 'overridden', 'streamable-http', 'https://ov.dev/mcp', true, null],
    ['gh', 'user', 'stdio', 'gh-mcp', false, null],
    ['plug', 'plugin', null, '', true, 'connecting'],
  ])
  env.stream.push([{ name: 'fs', configured: true, status: { state: 'failed', reason: 'gave-up', lastError: 'boom' } }])
  await flush()
  assert.equal(env.state().servers[0].status.state, 'failed')
  stop()
  env.controller.dispose()
})

test('paste → add: secrets are stored before the config write, never in it, and the view opens the new server', async () => {
  const env = setup({ user: { servers: { github: { transport: 'stdio', command: 'x' } } } })
  const stop = env.face.watch()
  await flush()
  env.face.openAdd()
  env.face.setPaste('GITHUB_TOKEN=ghp_secret npx -y @modelcontextprotocol/server-github', true)
  let s = env.state()
  assert.equal(s.view.kind, 'form')
  assert.equal(s.paste, '')
  assert.equal(s.draft.name, 'github-2')
  assert.equal(s.draft.commandLine, 'npx -y @modelcontextprotocol/server-github')
  assert.deepEqual(plain(s.draft.env.map(r => [r.key, r.secret])), [['GITHUB_TOKEN', true]])
  await env.face.submitDraft()
  await flush()
  const setIndex = env.events.findIndex(e => e[0] === 'set')
  assert.equal(env.events[setIndex][1], 'MCP_GITHUB_2_GITHUB_TOKEN')
  assert.deepEqual(env.form.log, [[{ op: 'set', path: ['servers', 'github-2'], value: {
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${credential:MCP_GITHUB_2_GITHUB_TOKEN}' },
  } }]])
  assert.equal(env.secrets.get('MCP_GITHUB_2_GITHUB_TOKEN'), 'ghp_secret')
  s = env.state()
  assert.deepEqual(plain(s.view), { kind: 'detail', name: 'github-2' })
  assert.equal(s.draft.mode, 'edit')
  assert.equal(s.draft.target, 'github-2')
  assert.ok(!JSON.stringify(s).includes('ghp_secret'), 'no secret left in the store')
  assert.equal(s.credInfo.MCP_GITHUB_2_GITHUB_TOKEN.configured, true)
  stop()
})

test('validation stops the save and focuses the first invalid field', async () => {
  const env = setup()
  env.face.openManual()
  env.face.setName('Bad Name!')
  assert.equal(env.state().draft.name, 'bad-name-')
  env.face.setName('')
  env.face.setField('startupSec', 'abc')
  await env.face.submitDraft()
  const s = env.state()
  assert.deepEqual(Object.keys(s.draft.errors), ['name', 'command', 'startup'])
  assert.equal(s.draft.focus, 'name')
  assert.equal(s.draft.advancedOpen, true)
  assert.deepEqual(env.form.log, [])
  env.face.clearFocus()
  assert.equal(env.state().draft.focus, null)
  env.face.setName('ok')
  assert.ok(!('name' in env.state().draft.errors))
})

test('a refused write rolls back the credentials this save created', async () => {
  const env = setup()
  env.face.openManual()
  env.face.setName('svc')
  env.face.setCommandLine('svc-mcp')
  env.face.addKv('env')
  const id = env.state().draft.env[0].id
  env.face.setKv('env', id, { key: 'api key', value: 'k-123' })
  assert.equal(env.state().draft.env[0].key, 'API_KEY')
  env.face.toggleSecret('env', id)
  env.form.refuseNext()
  await env.face.submitDraft()
  const s = env.state()
  assert.deepEqual(plain(env.events.filter(e => e[0] !== 'rpc')), [['set', 'MCP_SVC_API_KEY'], ['unset', 'MCP_SVC_API_KEY']])
  assert.equal(s.draft.saving, false)
  assert.equal(s.draft.saveError.key, 'mcp_errRefused')
  assert.equal(s.draft.env[0].value, 'k-123', 'the typed value stays while the form is open')
  assert.equal(s.view.kind, 'form')
  // A credential-store failure stops before any config write.
  env.events.length = 0
  env.ctx.remote.credentials.failSet = true
  await env.face.submitDraft()
  assert.equal(env.state().draft.saveError.key, 'mcp_errCredential')
  assert.equal(env.form.log.length, 1)
})

test('editing an inherited server writes only changed paths; restore default unsets the override', async () => {
  const env = setup({ base: { servers: { fs: { transport: 'stdio', command: 'npx', args: ['srv'], env: { A: '1' } } } } })
  env.face.openDetail('fs')
  let s = env.state()
  assert.equal(s.draft.origin, 'inherited')
  assert.equal(s.draft.dirty, false)
  env.face.setTransport('streamable-http')
  assert.equal(env.state().draft.transport, 'stdio', 'inherited servers keep their transport')
  env.face.removeKv('env', s.draft.env[0].id)
  assert.equal(env.state().draft.env.length, 1, 'base keys cannot be removed')
  env.face.setKv('env', s.draft.env[0].id, { value: '2' })
  env.face.setField('cwd', '/tmp/w')
  assert.equal(env.state().draft.dirty, true)
  await env.face.submitDraft()
  assert.deepEqual(env.form.log, [[
    { op: 'set', path: ['servers', 'fs', 'cwd'], value: '/tmp/w' },
    { op: 'set', path: ['servers', 'fs', 'env', 'A'], value: '2' },
  ]])
  s = env.state()
  assert.equal(s.servers[0].origin, 'overridden')
  assert.equal(s.draft.dirty, false)
  assert.equal(s.draft.origin, 'overridden')
  await env.face.restoreDefault('fs')
  assert.deepEqual(env.form.log[1], [{ op: 'unset', path: ['servers', 'fs'] }])
  s = env.state()
  assert.equal(s.servers[0].origin, 'inherited')
  assert.equal(s.draft.env[0].value, '1')
  assert.equal(s.notice.key, 'mcp_restored')
})

test('delete removes the entry and its own credentials, then returns to the list', async () => {
  const env = setup({ user: { servers: {
    gh: { transport: 'stdio', command: 'x', env: { T: '${credential:MCP_GH_T}', S: '${credential:SHARED}' } },
    other: { transport: 'stdio', command: 'y', env: { S: '${credential:SHARED}' } },
  } } })
  env.secrets.set('MCP_GH_T', 'v')
  env.face.openDetail('gh')
  env.face.askDelete('gh')
  assert.equal(env.state().confirm.name, 'gh')
  await env.face.confirmDelete()
  await flush()
  assert.deepEqual(env.form.log, [[{ op: 'unset', path: ['servers', 'gh'] }]])
  assert.deepEqual(plain(env.events.filter(e => e[0] === 'unset')), [['unset', 'MCP_GH_T']])
  const s = env.state()
  assert.equal(s.view.kind, 'list')
  assert.equal(s.confirm, null)
  assert.equal(s.notice.key, 'mcp_deleted')
  assert.equal(env.face.takeOpener(), '+add')
})

test('enable toggle is optimistic until the snapshot agrees', async () => {
  const env = setup({ user: { servers: { gh: { transport: 'stdio', command: 'x' } } } })
  const pending = env.face.toggleEnabled('gh', false)
  assert.deepEqual(plain(env.state().servers.map(r => [r.enabled, r.pending])), [[false, true]])
  await pending
  assert.deepEqual(env.form.log, [[{ op: 'set', path: ['servers', 'gh', 'enabled'], value: false }]])
  assert.deepEqual(plain(env.state().servers.map(r => [r.enabled, r.pending])), [[false, false]])
  env.form.refuseNext()
  await env.face.toggleEnabled('gh', true)
  assert.deepEqual(plain(env.state().servers.map(r => [r.enabled, r.pending])), [[false, false]])
  assert.equal(env.state().notice.key, 'mcp_errRefused')
})

test('batch import: existing names skip by default, overwrite on request', async () => {
  const env = setup({ user: { servers: { a: { transport: 'stdio', command: 'old' } } } })
  env.face.openAdd()
  env.face.setPaste(JSON.stringify({ mcpServers: { a: { command: 'new' }, b: { url: 'https://b.dev/mcp', headers: { Authorization: 'Bearer tok' } }, c: { type: 'stdio' } } }), true)
  let s = env.state()
  assert.equal(s.view.kind, 'batch')
  assert.deepEqual(plain(s.batch.items.map(i => [i.server.name, i.exists, i.include, i.mode, i.problem])), [
    ['a', true, true, 'skip', null], ['b', false, true, 'skip', null], ['c', false, false, 'skip', 'mcp_problemCommand'],
  ])
  await env.face.importBatch()
  assert.deepEqual(env.form.log, [[{ op: 'set', path: ['servers', 'b'], value: { transport: 'streamable-http', url: 'https://b.dev/mcp', headers: { Authorization: '${credential:MCP_B_AUTHORIZATION}' } } }]])
  assert.equal(env.secrets.get('MCP_B_AUTHORIZATION'), 'Bearer tok')
  s = env.state()
  assert.equal(s.view.kind, 'list')
  assert.deepEqual(plain(s.notice), { tone: 'success', key: 'mcp_importedSkipped', values: { n: 1, m: 1 } })
  env.face.openAdd()
  env.face.setPaste(JSON.stringify({ mcpServers: { a: { command: 'new' }, d: { command: 'd' } } }), true)
  env.face.setBatchItem('0', { mode: 'overwrite' })
  await env.face.importBatch()
  assert.deepEqual(env.form.log[1].map(op => op.path[1]), ['a', 'd'])
})

test('tools, probe, and restart go to the right Remotes', async () => {
  const env = setup({ user: { servers: { gh: { transport: 'stdio', command: 'x' } } } })
  await env.face.loadTools('gh', '1:1')
  assert.deepEqual(plain(env.state().tools.gh), { status: 'ready', items: [{ name: 'search', description: 'Search things\nmore' }], key: '1:1' })
  await env.face.loadTools('gh', '1:1')
  assert.equal(env.events.filter(e => e[0] === 'rpc').length, 1, 'cached per connection key')
  await env.face.probe('gh')
  assert.deepEqual(plain(env.state().probes.gh.result.toolNames), ['a', 'b'])
  await env.face.restart('gh')
  assert.deepEqual(plain(env.events.map(e => e[0])), ['rpc', 'probe', 'restart'])
})

test('closing the page scrubs pasted text, batches, and typed secrets but keeps other edits', async () => {
  const env = setup()
  const stop = env.face.watch()
  env.face.openManual()
  env.face.setName('keep')
  env.face.addKv('env')
  const id = env.state().draft.env[0].id
  env.face.setKv('env', id, { key: 'TOKEN', value: 'typed' })
  env.face.toggleSecret('env', id)
  stop()
  const s = env.state()
  assert.equal(s.view.kind, 'form')
  assert.equal(s.draft.name, 'keep')
  assert.equal(s.draft.env[0].value, '')
  assert.ok(!JSON.stringify(s).includes('typed'))
  env.face.back()
  assert.equal(env.state().draft, null)
  assert.equal(env.state().view.kind, 'list')
})

test('pasting into the command box switches transport and merges env', async () => {
  const env = setup()
  env.face.openManual()
  assert.equal(env.face.pasteCommand('https://mcp.notion.com/mcp'), true)
  let d = env.state().draft
  assert.deepEqual([d.transport, d.url, d.name, d.focus], ['streamable-http', 'https://mcp.notion.com/mcp', 'notion', 'url'])
  assert.equal(env.face.pasteUrl('https://other.dev/mcp'), false, 'a URL pastes normally')
  assert.equal(env.face.pasteUrl('API_KEY=abc uvx weather-mcp --stdio'), true)
  d = env.state().draft
  assert.deepEqual([d.transport, d.commandLine, d.name], ['stdio', 'uvx weather-mcp --stdio', 'notion'])
  assert.deepEqual(plain(d.env.map(r => [r.key, r.value, r.secret])), [['API_KEY', 'abc', true]])
  assert.equal(env.face.pasteCommand('npx "unterminated'), false)
})

test('an inherited server keeps its transport when a URL is pasted into the command box', async () => {
  const env = setup({ base: { servers: { fs: { transport: 'stdio', command: 'npx', args: ['srv'] } } } })
  env.face.openDetail('fs')
  assert.equal(env.face.pasteCommand('https://x.dev/mcp'), false, 'falls back to a normal paste')
  assert.equal(env.state().draft.transport, 'stdio')
  assert.equal(env.face.pasteCommand('npx other-mcp'), true)
  assert.equal(env.state().draft.commandLine, 'npx other-mcp')
})
