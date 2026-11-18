import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { speedProjection as unit, legacySpeed, parseSpeed, registerSpeed, resolveSpeed, speedReceipt } from '../speed.js'
import { CodexAdapter } from '../index.js'
import { fakes, message } from './fake-codex.mjs'

const event = (type, data, seq) => ({ type, data, seq, time: seq })
const run = (id, args, seq = 0) => event('command/run', { commandId: id, name: 'fast', args, source: { kind: 'user' } }, seq)
const done = (id, selected, seq = 1) => event('command/done', { commandId: id, kind: 'success', text: speedReceipt(selected) + 'Next request: standard.' }, seq)
const fold = events => events.reduce((state, e) => unit.apply(state, e), unit.init())

test('speed capabilities downgrade Ultrafast to Fast, then standard; never upgrade', () => {
  const fast = { serviceTiers: [{ id: 'priority' }] }
  const ultra = { serviceTiers: [{ id: 'priority' }, { id: 'ultrafast' }] }
  assert.equal(resolveSpeed('ultrafast', ultra).serviceTier, 'ultrafast')
  assert.equal(resolveSpeed('ultrafast', fast).serviceTier, 'priority')
  assert.equal(resolveSpeed('ultrafast', {}).actual, 'standard')
  assert.equal(resolveSpeed('fast', ultra).serviceTier, 'priority')
  assert.equal(resolveSpeed('standard', ultra).serviceTier, undefined)
  assert.equal(resolveSpeed('fast', undefined).actual, 'standard')
  assert.equal(legacySpeed('gpt@priority'), 'fast')
  assert.equal(parseSpeed(' ON '), 'fast')
  assert.equal(parseSpeed('off'), 'standard')
  assert.equal(parseSpeed('ultra'), 'ultrafast')
  assert.equal(parseSpeed(''), 'toggle')
  for (const input of ['true', 'fast extra', '__proto__', 'constructor']) assert.equal(parseSpeed(input), undefined)
})

test('only matching successful plugin receipts select speed; pending/error/query logs do not', () => {
  const initial = unit.init()
  assert.equal(unit.apply(initial, event('step/start', {}, 0)), initial)
  assert.equal(fold([run('a', 'ultrafast')]).selected, null)
  assert.equal(fold([run('a', 'ultrafast'), done('a', 'ultrafast')]).selected, 'ultrafast')
  assert.equal(fold([run('a', 'ultrafast'), { ...done('a', 'ultrafast'), data: { ...done('a', 'ultrafast').data, kind: 'error' } }]).selected, null)
  assert.equal(fold([run('a', 'ultrafast'), done('b', 'ultrafast')]).selected, null)
  assert.equal(fold([run('a', 'fast'), done('a', 'ultrafast')]).selected, null)
  assert.equal(fold([run('a', 'status'), done('a', 'fast')]).selected, null)
  assert.equal(fold([run('a', 'fast'), event('command/done', { commandId: 'a', kind: 'success', text: 'Fast enabled' }, 1)]).selected, null)
  assert.equal(fold([run('a', ''), done('a', 'standard')]).selected, 'standard')
})

test('successful invocation order, full replay, fork prefixes and truncated revert derive independently', () => {
  const events = [run('a', 'fast', 0), run('b', 'ultrafast', 1), done('b', 'ultrafast', 2), done('a', 'fast', 3)]
  assert.equal(fold(events).selected, 'ultrafast', 'A slower older command cannot replace a newer successful one')
  assert.equal(fold(events.slice(0, 2)).selected, null, 'Fork before settlement inherits no uncommitted choice')
  assert.equal(fold(events.slice(0, 3)).selected, 'ultrafast')
  const saved = JSON.parse(JSON.stringify(events))
  assert.deepEqual(fold(saved), fold(events), 'Resume needs only the log')
  const parent = fold([...events, run('c', 'off', 4), done('c', 'standard', 5)])
  assert.equal(parent.selected, 'standard')
  assert.equal(fold(saved).selected, 'ultrafast', 'Child and reverted prefix stay independent')
  assert.equal(unit.stateSchema.safeParse(parent).success, true)
})

test('session selection reaches turn/start, isolates sessions, persists into replay metadata and ignores auxiliary calls', async () => {
  const f = fakes([[message('1', 'one')], [message('2', 'two')], [message('3', 'three')]])
  const adapter = new CodexAdapter({}, f.connect)
  adapter.sessionSpeed = id => id === 'fast-session' ? 'ultrafast' : 'standard'
  const options = { provider: 'codex-provider', model: 'gpt-test', tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] }
  try {
    const first = await Array.fromAsync(adapter.stream({ ...options, sessionId: 'fast-session' }))
    assert.deepEqual(first.at(-1).replayState.response.codex.speed, { model: 'gpt-test', selected: 'ultrafast', actual: 'fast' })
    await Array.fromAsync(adapter.stream({ ...options, sessionId: 'standard-session' }))
    await Array.fromAsync(adapter.stream({ ...options, sessionId: 'fast-session', purpose: 'title' }))
    assert.deepEqual(f.instances[0].calls.filter(c => c.method === 'turn/start').map(c => c.params.serviceTier), ['priority', null, null])
    const observed = fold([event('assistant/message', { message: { source: { provider: 'codex-provider', replayState: first.at(-1).replayState } } }, 0)])
    assert.equal(observed.lastUsed.actual, 'fast')
    adapter.config.models = ['gpt-test@priority', 'gpt-test@ultrafast', 'gpt-test']
    assert.deepEqual((await adapter.listModels('codex-provider')).map(m => m.id), ['gpt-test'])
  } finally { await adapter.dispose() }
})

test('command validates route/input, resolves capabilities and waits for done before mutating state', async () => {
  let definition
  const state = unit.init()
  const ctx = {
    sessionProjections: { register: async candidate => { assert.equal(candidate, unit); return { stateOf: () => state } } },
    commands: { register: value => { definition = value } },
  }
  await registerSpeed(ctx, () => ({ loadCatalog: async () => [{ model: 'gpt-test', serviceTiers: [{ id: 'priority' }] }] }))
  const agent = { session: {}, model: { current: () => ({ provider: 'codex-provider', model: 'gpt-test' }) } }
  const invoke = rawInput => definition.handler({ agent, rawInput, signal: new AbortController().signal })
  assert.equal((await invoke('invalid')).kind, 'error')
  const result = await invoke('ultrafast')
  assert.equal(result.kind, 'success')
  assert.ok(result.text.startsWith(speedReceipt('ultrafast')))
  assert.match(result.text, /Next request: fast/)
  assert.equal(state.selected, null, 'Handler does not create a second state authority')
  assert.ok((await invoke('')).text.startsWith(speedReceipt('fast')))
  agent.model.current = () => ({ provider: 'other', model: 'x' })
  assert.equal((await invoke('on')).kind, 'error')
})

test('real Session registry and command executor replay, checkpoint and fork the same single truth', async () => {
  const installed = import.meta.resolve('@deepseek-ai/dsh-llm')
  const { default: Sessions } = await import(new URL('../../dsh-session/lib/index.js', installed))
  const { default: Projections } = await import(new URL('../../dsh-session-projection/lib/index.js', installed))
  const { default: Commands } = await import(new URL('../../dsh-commands/lib/index.js', installed))
  const ctx = new Context()
  const forks = [await ctx.plugin(Sessions), await ctx.plugin(Projections), await ctx.plugin(Commands)]
  try {
    let handle
    forks.push(await ctx.plugin({ inject: ['sessionProjections', 'commands', 'sessions'], async apply(scope) {
      handle = await registerSpeed(scope, () => ({ loadCatalog: async () => [{ model: 'gpt-test', serviceTiers: [{ id: 'priority' }] }] }))
    } }))
    const session = ctx.sessions.create('parent')
    const agent = { id: 'parent', session, model: { current: () => ({ provider: 'codex-provider', model: 'gpt-test@priority' }) } }
    const signal = new AbortController().signal
    const first = await ctx.commands.execute(agent, '/fast ultrafast', [], signal)
    assert.equal(first.result.kind, 'success')
    assert.equal(handle.stateOf(session).selected, 'ultrafast')
    assert.deepEqual(session.snapshotEvents().map(e => e.type), ['command/run', 'command/done'])
    const fork = ctx.sessions.fork(session, 1, 'child')
    assert.equal(handle.stateOf(fork).selected, 'ultrafast')
    const beforeDone = ctx.sessions.fork(session, 0, 'before-done')
    assert.equal(handle.stateOf(beforeDone).selected, null)
    await ctx.commands.execute(agent, '/fast off', [], signal)
    assert.equal(handle.stateOf(session).selected, 'standard')
    assert.equal(handle.stateOf(fork).selected, 'ultrafast')
    const restored = ctx.sessions.create('restored', { seed: session.snapshotEvents() })
    assert.equal(handle.stateOf(restored).selected, 'standard')
    const checkpoint = ctx.sessionProjections.checkpoint(session)
    assert.equal(ctx.sessionProjections.viewCheckpoint(checkpoint).codexSpeed.selected, 'standard')
    assert.equal(ctx.sessionProjections.snapshot(session).values.codexSpeed.selected, 'standard')
  } finally { await Promise.all(forks.reverse().map(fork => fork.dispose())) }
})
