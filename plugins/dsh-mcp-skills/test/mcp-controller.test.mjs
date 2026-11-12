// Controller of client/10-mcp.js against fake Settings form, manager, and
// credential Remotes plus this plugin's Host routes: origins, paste → add,
// secret ordering and rollback, minimal overrides, delete cleanup, enable
// toggles, batch import, scrubbing, the reconnect policy, the `mcp-state`
// long-poll, and the OAuth flow.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Like load-part.mjs, plus the timer and abort globals the controller uses.
function loadController(windowStub = {}) {
  const body = ['00-core.js', '10-mcp.js'].map(name => readFileSync(join(root, 'client', name), 'utf8')).join('\n')
  const source = `(function factory(require) {\n'use strict';\n${body}\nreturn { createMcpController, McpSection, McpSectionIcon, DICT };\n})`
  const stubReact = {
    createElement: () => null, Fragment: 'Fragment', forwardRef: fn => fn,
    useCallback: fn => fn, useEffect: () => {}, useId: () => 'id', useLayoutEffect: () => {}, useMemo: fn => fn(), useRef: v => ({ current: v }), useState: v => [v, () => {}],
  }
  const globals = { window: windowStub, CSS: { escape: s => s }, console, URL, JSON, Math, Date, Intl, structuredClone, setTimeout, clearTimeout, AbortController }
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

/** `mcp-state` long-poll: answers at once when `since` is stale, otherwise when the next push lands. */
function fakeHost() {
  let version = 1
  let servers = {}
  let waiters = []
  return {
    push(next) {
      servers = structuredClone(next)
      version += 1
      for (const wake of waiters) wake()
      waiters = []
    },
    async state(payload) {
      if (payload.since === version) await new Promise(resolve => { waiters.push(resolve) })
      return { version, servers: structuredClone(servers) }
    },
  }
}

class RouteError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

function setup({ base = { servers: {} }, user = { servers: {} }, runtime = [], routes = {} } = {}) {
  const opened = []
  let form = null
  const mod = loadController({ open: (...args) => { opened.push({ args, writesBefore: form.log.length }); return null } })
  form = fakeForm(base, user)
  const host = fakeHost()
  const stream = channel()
  stream.push(runtime)
  const events = []
  const secrets = new Map()
  const ok = value => ({ ok: true, value })
  const defaults = {
    'tools': () => ({ tools: [{ name: 'search', description: 'Search things\nmore' }] }),
    'state': payload => host.state(payload),
    'retry': () => ({ ok: true }),
    'auth-check': () => ({ kind: 'none' }),
    'auth-start': ({ server }) => ({
      flowId: `flow-${server}`, authUrl: `https://auth.example.com/authorize?state=${server}`, redirectUri: 'http://localhost:4567/callback',
      ref: `MCP_${server.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_OAUTH`, header: 'Authorization',
      template: `Bearer \${credential:MCP_${server.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_OAUTH}`,
    }),
    'auth-complete': () => ({ ok: true }),
    'auth-cancel': () => ({ ok: true }),
    'auth-forget': () => ({ ok: true }),
  }
  const ctx = {
    configForms: { get: ns => { assert.equal(ns, 'mcp-manager'); return form } },
    connection: { rpc: { call: async (channel, path, payload) => {
      assert.equal(channel, '/api')
      assert.ok(path.startsWith('mcp-settings/'), `MCP page calls the MCP API: ${path}`)
      const op = path.slice('mcp-settings/'.length)
      events.push(['rpc', op, payload])
      const handler = routes[op] ?? defaults[op]
      try {
        return ok(await handler(payload))
      } catch (error) {
        return { ok: false, error: { code: error.code ?? 'internal', message: error.message } }
      }
    } } },
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
  const rpcCalls = op => events.filter(e => e[0] === 'rpc' && e[1] === op).map(e => e[2])
  return { mod, form, stream, host, events, rpcCalls, opened, secrets, ctx, controller, face, store, state: () => store.getSnapshot() }
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
    reconnect: { enabled: false },
  } }]])
  assert.equal(env.secrets.get('MCP_GITHUB_2_GITHUB_TOKEN'), 'ghp_secret')
  s = env.state()
  assert.deepEqual(plain(s.view), { kind: 'detail', name: 'github-2' })
  assert.equal(s.draft.mode, 'edit')
  assert.equal(s.draft.target, 'github-2')
  assert.ok(!JSON.stringify(s).includes('ghp_secret'), 'no secret left in the store')
  assert.equal(s.credInfo.MCP_GITHUB_2_GITHUB_TOKEN.configured, true)
  stop()
  env.controller.dispose()
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
    { op: 'set', path: ['servers', 'fs', 'reconnect', 'enabled'], value: false },
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
  assert.deepEqual(env.form.log, [[{ op: 'set', path: ['servers', 'b'], value: { transport: 'streamable-http', url: 'https://b.dev/mcp', headers: { Authorization: '${credential:MCP_B_AUTHORIZATION}' }, reconnect: { enabled: false } } }]])
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

test('tools, probe, and retry go to the right routes; retry is the Host route mcp-retry', async () => {
  const env = setup({ user: { servers: { gh: { transport: 'stdio', command: 'x' } } } })
  await env.face.loadTools('gh', '1:1')
  assert.deepEqual(plain(env.state().tools.gh), { status: 'ready', items: [{ name: 'search', description: 'Search things\nmore' }], key: '1:1' })
  await env.face.loadTools('gh', '1:1')
  assert.equal(env.events.filter(e => e[0] === 'rpc').length, 1, 'cached per connection key')
  await env.face.probe('gh')
  assert.deepEqual(plain(env.state().probes.gh.result.toolNames), ['a', 'b'])
  await env.face.restart('gh')
  assert.deepEqual(plain(env.events.map(e => e.slice(0, 2))), [['rpc', 'tools'], ['probe', 'gh'], ['rpc', 'retry']])
  assert.deepEqual(plain(env.rpcCalls('retry')), [{ server: 'gh' }])
  // A failed retry shows why.
  const failing = setup({ user: { servers: { gh: { transport: 'stdio', command: 'x' } } }, routes: { 'retry': () => { throw new RouteError('unavailable', 'no manager') } } })
  await failing.face.restart('gh')
  assert.equal(failing.state().notice.key, 'mcp_errAction')
  assert.equal(failing.state().servers[0].busy, null)
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
  env.controller.dispose()
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

// -- Authorization and the Host supervisor ------------------------------------

const NOTION = { transport: 'streamable-http', url: 'https://mcp.notion.com/mcp' }
const TEMPLATE = 'Bearer ${credential:MCP_NOTION_OAUTH}'
const unauthorized = [{ name: 'notion', configured: true, status: { state: 'failed', reason: 'reconnect-disabled', lastError: 'Streamable HTTP error: 401 Unauthorized' } }]
const notionRow = env => env.state().servers.find(row => row.name === 'notion')

test('mcp-state long-poll: runs while the page is mounted, passes since, feeds rows, stops on unmount', async () => {
  const env = setup({ user: { servers: { gh: { transport: 'stdio', command: 'x' } } }, runtime: [{ name: 'gh', configured: true, status: { state: 'failed', reason: 'reconnect-disabled', lastError: 'socket hang up' } }] })
  await flush()
  assert.equal(env.rpcCalls('state').length, 0, 'nothing before the page opens')
  const stop = env.face.watch()
  await flush()
  assert.deepEqual(plain(env.rpcCalls('state')), [{}, { since: 1 }], 'first call returns at once, the next waits on version 1')
  assert.equal(env.state().hostState.status, 'ready')
  assert.equal(env.state().servers[0].info.kind, 'failed', 'first failure: manual retry only')
  env.host.push({ gh: { armed: true, retry: { attempt: 1, max: 10, nextAt: Date.now() + 4000 } } })
  await flush()
  const calls = plain(env.rpcCalls('state'))
  assert.deepEqual(calls[0], {})
  assert.ok(calls.slice(1).every(call => typeof call.since === 'number'), 'later calls wait on the version')
  assert.deepEqual(plain(env.state().hostState.servers), { gh: { armed: true, retry: { attempt: 1, max: 10, nextAt: env.state().hostState.servers.gh.retry.nextAt } } })
  assert.equal(env.state().servers[0].info.kind, 'retrying')
  stop()
  const before = env.rpcCalls('state').length
  env.host.push({ gh: { armed: false, gaveUp: { attempts: 10, at: 1 } } })
  await flush()
  assert.equal(env.rpcCalls('state').length, before, 'no new poll after unmount')
  assert.equal(env.state().servers[0].info.kind, 'retrying', 'unmounted page ignores late answers')
  env.controller.dispose()
})

test('mcp-state retries two seconds after a failure', async () => {
  let failures = 1
  const host = fakeHost()
  const env = setup({ routes: { 'state': payload => { if (failures-- > 0) throw new RouteError('internal', 'down'); return host.state(payload) } } })
  const stop = env.face.watch()
  await flush()
  assert.equal(env.rpcCalls('state').length, 1)
  await new Promise(resolve => setTimeout(resolve, 2200))
  await flush()
  assert.equal(env.rpcCalls('state').length >= 2, true)
  assert.equal(env.state().hostState.status, 'ready')
  stop()
  env.controller.dispose()
})

test('authorize: start → open the page at once → header + reconnect in one write → done from mcp-state', async () => {
  const env = setup({
    user: { servers: { notion: { ...NOTION, reconnect: { enabled: false }, headers: { 'X-Team': 'a' } } } },
    runtime: unauthorized,
    routes: { 'auth-check': () => ({ kind: 'oauth', issuer: 'https://auth.notion.com', registration: true }) },
  })
  const stop = env.face.watch()
  await flush()
  let row = notionRow(env)
  assert.deepEqual([row.info.kind, row.authMode], ['auth', 'oauth'])
  assert.deepEqual(plain(env.rpcCalls('auth-check')), [{ url: 'https://mcp.notion.com/mcp' }], 'checked once for OAuth')
  env.face.openDetail('notion')
  await env.face.startAuth('notion')
  assert.deepEqual(plain(env.rpcCalls('auth-start')), [{ server: 'notion', url: 'https://mcp.notion.com/mcp' }])
  assert.equal(env.opened.length, 1)
  assert.deepEqual(plain(env.opened[0].args), ['https://auth.example.com/authorize?state=notion', '_blank', 'noopener'])
  assert.equal(env.opened[0].writesBefore, 0, 'the page opens before the config write')
  assert.deepEqual(env.form.log, [[{ op: 'set', path: ['servers', 'notion', 'headers', 'Authorization'], value: TEMPLATE }]], 'reconnect already off: header only')
  let s = env.state()
  assert.deepEqual([s.auth.notion.flow.status, s.auth.notion.busy, notionRow(env).info.kind], ['pending', null, 'auth-flow'])
  assert.equal(notionRow(env).oauth, true)
  assert.deepEqual(plain(s.draft.headers.map(r => [r.key, Boolean(r.oauth)])), [['X-Team', false], ['Authorization', true]])
  // The Host reports the exchange, then success; the status says "connecting" until the runtime moves on.
  const flow = { flowId: 'flow-notion', authUrl: 'https://auth.example.com/authorize?state=notion', redirectUri: 'http://localhost:4567/callback', startedAt: Date.now() }
  env.host.push({ notion: { armed: false, flow: { ...flow, status: 'exchanging' } } })
  await flush()
  assert.equal(env.state().auth.notion.flow.status, 'exchanging')
  env.host.push({ notion: { armed: false, flow: { ...flow, status: 'done' }, auth: { state: 'authorized', issuer: 'auth.notion.com', expiresAt: Date.now() + 3600000, canRefresh: true } } })
  await flush()
  s = env.state()
  assert.equal(s.auth.notion.flow.status, 'done')
  assert.equal(notionRow(env).info.label, 'mcp_stAuthDone')
  env.stream.push([{ name: 'notion', configured: true, status: { state: 'connected', toolCount: 3, connectedAt: Date.now() } }])
  await flush()
  row = notionRow(env)
  assert.equal(row.info.kind, 'connected')
  assert.equal(row.host.auth.state, 'authorized')
  stop()
  env.controller.dispose()
})

test('authorize on an inherited server writes only the header and reconnect paths, in one mutate', async () => {
  const env = setup({ base: { servers: { notion: { ...NOTION } } }, runtime: unauthorized })
  await env.face.startAuth('notion')
  assert.deepEqual(env.form.log, [[
    { op: 'set', path: ['servers', 'notion', 'headers', 'Authorization'], value: TEMPLATE },
    { op: 'set', path: ['servers', 'notion', 'reconnect', 'enabled'], value: false },
  ]])
  assert.equal(notionRow(env).origin, 'overridden')
  assert.equal(notionRow(env).oauth, true)
  // Authorizing again with the header in place writes nothing.
  await env.face.startAuth('notion')
  assert.equal(env.form.log.length, 1)
  assert.equal(env.opened.length, 2)
})

test('authorize needing a client ID asks for it, then sends it', async () => {
  let attempts = 0
  const env = setup({
    user: { servers: { notion: { ...NOTION } } }, runtime: unauthorized,
    routes: { 'auth-start': payload => { attempts += 1; if (!payload.clientId) throw new RouteError('oauth-client-required', 'no registration endpoint'); return { flowId: 'f', authUrl: 'https://a/x', redirectUri: 'http://localhost:1/callback', ref: 'MCP_NOTION_OAUTH', header: 'Authorization', template: TEMPLATE } } },
  })
  env.face.authorizeFromCard('notion')
  await flush()
  let s = env.state()
  assert.equal(s.auth.notion.clientRequired, true)
  assert.deepEqual(plain(s.view), { kind: 'detail', name: 'notion' }, 'the client ID fields are in the detail')
  assert.equal(env.opened.length, 0)
  await env.face.startAuth('notion')
  assert.equal(env.state().auth.notion.error.key, 'mcp_errClientIdRequired')
  assert.equal(attempts, 1)
  env.face.setAuthField('notion', 'clientId', ' my-client ')
  env.face.setAuthField('notion', 'clientSecret', 's3cr3t')
  await env.face.startAuth('notion')
  assert.deepEqual(plain(env.rpcCalls('auth-start')[1]), { server: 'notion', url: 'https://mcp.notion.com/mcp', clientId: 'my-client', clientSecret: 's3cr3t' })
  s = env.state()
  assert.deepEqual([s.auth.notion.clientRequired, s.auth.notion.clientSecret, s.auth.notion.flow.status], [false, '', 'pending'])
  assert.ok(!JSON.stringify(s).includes('s3cr3t'), 'the client secret leaves the store once sent')
})

test('authorize failures: a start error from a card is a notice; a refused header write cancels the flow', async () => {
  const env = setup({
    user: { servers: { notion: { ...NOTION } } }, runtime: unauthorized,
    routes: { 'auth-start': () => { throw new RouteError('internal', 'issuer down') } },
  })
  env.face.authorizeFromCard('notion')
  await flush()
  assert.deepEqual(plain(env.state().notice), { tone: 'error', key: 'mcp_authFlowError', values: { reason: 'issuer down' } })
  assert.equal(env.state().view.kind, 'list')
  assert.equal(env.opened.length, 0)
  const refused = setup({ user: { servers: { notion: { ...NOTION } } }, runtime: unauthorized })
  refused.form.refuseNext()
  await refused.face.startAuth('notion')
  assert.deepEqual(plain(refused.rpcCalls('auth-cancel')), [{ flowId: 'flow-notion' }])
  const s = refused.state()
  assert.deepEqual([s.auth.notion.flow.status, s.auth.notion.error.key], ['cancelled', 'mcp_errRefused'])
})

test('pasting the callback completes the flow; cancel and sign out call their routes', async () => {
  const env = setup({ user: { servers: { notion: { ...NOTION, headers: { Authorization: TEMPLATE } } } }, runtime: [{ name: 'notion', configured: true, status: { state: 'waiting-credentials', lastError: 'credential MCP_NOTION_OAUTH is not set' } }] })
  const stop = env.face.watch()
  await flush()
  assert.deepEqual([notionRow(env).oauth, notionRow(env).info.kind], [true, 'auth'])
  await env.face.startAuth('notion')
  assert.equal(env.form.log.length, 0, 'header already in place')
  await env.face.completeAuth('notion')
  assert.equal(env.state().auth.notion.error.key, 'mcp_errCallbackRequired')
  env.face.setAuthField('notion', 'callbackUrl', 'http://localhost:4567/callback?code=abc&state=s')
  await env.face.completeAuth('notion')
  assert.deepEqual(plain(env.rpcCalls('auth-complete')), [{ flowId: 'flow-notion', callbackUrl: 'http://localhost:4567/callback?code=abc&state=s' }])
  let s = env.state()
  assert.deepEqual([s.auth.notion.flow.status, s.auth.notion.callbackUrl, notionRow(env).info.label], ['done', '', 'mcp_stAuthDone'])
  // Cancel a new flow.
  await env.face.startAuth('notion')
  await env.face.cancelAuth('notion')
  assert.deepEqual(plain(env.rpcCalls('auth-cancel')), [{ flowId: 'flow-notion' }])
  assert.equal(env.state().auth.notion.flow.status, 'cancelled')
  assert.equal(notionRow(env).info.kind, 'auth')
  // Sign out keeps the header.
  await env.face.forgetAuth('notion')
  assert.deepEqual(plain(env.rpcCalls('auth-forget')), [{ server: 'notion' }])
  s = env.state()
  assert.deepEqual(plain(s.notice), { tone: 'success', key: 'mcp_signedOut', values: { name: 'notion' } })
  assert.equal(env.form.log.length, 0)
  assert.equal(env.rpcCalls('auth-check').length, 0, 'an OAuth-managed server needs no check')
  stop()
  env.controller.dispose()
})

test('a 401 without OAuth metadata shows the header hint instead of 授权', async () => {
  const env = setup({ user: { servers: { api: { transport: 'streamable-http', url: 'https://api.dev/mcp' } } }, runtime: [{ name: 'api', configured: true, status: { state: 'failed', reason: 'reconnect-disabled', lastError: 'HTTP 401' } }], routes: { 'auth-check': () => ({ kind: 'token', status: 401 }) } })
  const stop = env.face.watch()
  await flush()
  const row = env.state().servers[0]
  assert.deepEqual([row.info.kind, row.authMode], ['auth', 'token'])
  await flush()
  assert.equal(env.rpcCalls('auth-check').length, 1, 'cached')
  stop()
  env.controller.dispose()
})

test('add form: debounced auth check, then 添加并授权 writes the header with the entry and starts the flow', async () => {
  const env = setup({ routes: { 'auth-check': () => ({ kind: 'oauth', issuer: 'https://auth.linear.app', registration: true }) } })
  const stop = env.face.watch()
  env.face.openManual()
  env.face.setTransport('streamable-http')
  env.face.setName('linear')
  env.face.setUrl('https://mcp.linear.app/m')
  env.face.setUrl('https://mcp.linear.app/mcp')
  assert.equal(env.state().draft.auth.status, 'loading', 'checking shows during the debounce')
  await new Promise(resolve => setTimeout(resolve, 700))
  await flush()
  assert.deepEqual(plain(env.rpcCalls('auth-check')), [{ url: 'https://mcp.linear.app/mcp' }], 'one check for the settled URL')
  const auth = plain(env.state().draft.auth)
  assert.deepEqual([auth.kind, auth.issuer, auth.authorizeOnAdd], ['oauth', 'auth.linear.app', true])
  await env.face.submitDraft()
  await flush()
  assert.deepEqual(env.form.log, [[{ op: 'set', path: ['servers', 'linear'], value: {
    transport: 'streamable-http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer ${credential:MCP_LINEAR_OAUTH}' }, reconnect: { enabled: false },
  } }]])
  assert.deepEqual(plain(env.rpcCalls('auth-start')), [{ server: 'linear', url: 'https://mcp.linear.app/mcp' }])
  assert.equal(env.opened.length, 1)
  assert.deepEqual(plain(env.state().view), { kind: 'detail', name: 'linear' })
  assert.equal(env.state().auth.linear.flow.status, 'pending')
  stop()
  env.controller.dispose()
})

test('a user-entered Authorization header keeps the plain add', async () => {
  const env = setup({ routes: { 'auth-check': () => ({ kind: 'oauth', issuer: 'https://auth.linear.app', registration: true }) } })
  const stop = env.face.watch()
  env.face.openManual()
  env.face.setTransport('streamable-http')
  env.face.setUrl('https://mcp.linear.app/mcp')
  env.face.addKv('headers')
  const id = env.state().draft.headers[0].id
  env.face.setKv('headers', id, { key: 'Authorization', value: 'Bearer mine' })
  await new Promise(resolve => setTimeout(resolve, 700))
  await flush()
  assert.equal(env.state().draft.auth.authorizeOnAdd, false)
  stop()
  env.controller.dispose()
})

test('delete also forgets the OAuth grant and leaves its reference to the Host', async () => {
  const env = setup({ user: { servers: { notion: { ...NOTION, headers: { Authorization: TEMPLATE, 'X-Key': '${credential:MCP_NOTION_X_KEY}' } } } } })
  env.face.openDetail('notion')
  env.face.askDelete('notion')
  await env.face.confirmDelete()
  await flush()
  assert.deepEqual(plain(env.rpcCalls('auth-forget')), [{ server: 'notion' }])
  assert.deepEqual(plain(env.events.filter(e => e[0] === 'unset')), [['unset', 'MCP_NOTION_X_KEY']])
})

test('the OAuth header row is read-only in the editor', async () => {
  const env = setup({ user: { servers: { notion: { ...NOTION, headers: { Authorization: TEMPLATE } } } } })
  env.face.openDetail('notion')
  const id = env.state().draft.headers[0].id
  env.face.setKv('headers', id, { value: 'Bearer x' })
  env.face.toggleSecret('headers', id)
  env.face.removeKv('headers', id)
  const row = plain(env.state().draft.headers)[0]
  assert.deepEqual([row.key, row.value, row.secret, row.oauth], ['Authorization', TEMPLATE, false, true])
  assert.equal(env.state().draft.dirty, false)
})
