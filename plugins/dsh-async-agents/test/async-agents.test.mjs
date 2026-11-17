import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as plugin from '../index.js'

const GLOBAL = Symbol('global layer')

/**
 * Host stand-in with the parts of Cordis, the tool registry, the agent
 * registry, and the prompt assembly this plugin touches:
 *
 * - effects are owned by the context that made them and run their disposers
 *   when that owner unloads; an unloaded context refuses new effects;
 * - tools and restrictions live in layers (global, preset, agent), an agent
 *   sees its own layer first and then what its scope chain inherits,
 *   `restrict` throws on a name the agent does not inherit, and `register`
 *   throws on a name its layer already holds;
 * - a listener registered through a scoped context receives only the events of
 *   that scope and of the scopes below it.
 */
function host() {
  const layers = new Map()
  const parents = new Map()
  const hooks = new Map()
  const agents = new Map()
  const fibers = new Map()
  const warnings = []

  const layer = (scope) => {
    if (!layers.has(scope)) layers.set(scope, { tools: new Map(), denies: new Set() })
    return layers.get(scope)
  }
  /** Scope keys from the farthest ancestor down to `scope` itself. */
  const chain = (scope) => {
    const keys = []
    for (let key = scope; key !== undefined; key = parents.get(key)) keys.unshift(key)
    return keys
  }
  const inherited = (scope) => {
    const tools = new Map(layer(GLOBAL).tools)
    for (const key of chain(scope)) {
      if (key !== scope) for (const [name, definition] of layer(key).tools) tools.set(name, definition)
    }
    return tools
  }
  const denied = (name, scope) => chain(scope).some(key => [...layer(key).denies].some(deny => deny.includes(name)))
  const get = (name, scope) => {
    const own = scope === undefined ? undefined : layer(scope).tools.get(name)
    if (own !== undefined) return own
    return denied(name, scope) ? undefined : inherited(scope).get(name)
  }
  const admits = (entry, scope) => entry.scope === undefined || chain(scope).includes(entry.scope)

  /** A fiber and the context it owns; `scope` tags what is registered through that context. */
  function fiber(scope) {
    const live = new Set()
    let active = true
    const effect = (execute) => {
      if (!active) throw Object.assign(new Error('cannot create effect on inactive context'), { code: 'INACTIVE_EFFECT' })
      const collected = []
      let disposed = false
      const dispose = () => {
        if (disposed) return
        disposed = true
        live.delete(dispose)
        for (const undo of collected.splice(0).reverse()) undo()
      }
      // A disposer handed to an outer effect belongs to that effect from then on.
      const collect = (undo) => {
        collected.push(undo)
        live.delete(undo)
      }
      live.add(dispose)
      try {
        const result = execute()
        if (typeof result === 'function') collect(result)
        else if (result != null) for (const undo of result) collect(undo)
      } catch (error) {
        dispose()
        throw error
      }
      return dispose
    }
    const ctx = {
      effect,
      on: (name, listener) => effect(() => {
        const entry = { scope, listener }
        hooks.set(name, [...hooks.get(name) ?? [], entry])
        return () => hooks.set(name, hooks.get(name).filter(other => other !== entry))
      }),
      tools: {
        get,
        register: definition => effect(() => {
          const { tools } = layer(scope ?? GLOBAL)
          if (tools.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered in this scope`)
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        }),
        restrict: ({ deny }) => effect(() => {
          const unknown = deny.filter(name => !inherited(scope).has(name))
          if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tool "${unknown[0]}"`)
          layer(scope).denies.add(deny)
          return () => layer(scope).denies.delete(deny)
        }),
      },
      agents: { list: () => [...agents.values()], get: id => agents.get(id) },
      logger: { warn: line => warnings.push(line) },
    }
    return {
      ctx,
      live,
      unload() {
        active = false
        for (const dispose of [...live]) dispose()
      },
    }
  }

  return {
    warnings,
    /** A context that registers into the global layer. */
    root: fiber(undefined).ctx,
    /** A preset: a context that registers into a layer agents can be composed under. */
    preset(...definitions) {
      const key = {}
      const { ctx } = fiber(key)
      for (const definition of definitions) ctx.tools.register(definition)
      return { key, ctx }
    },
    /** Create and announce an agent, as the agent registry does. */
    agent(id, { origin, preset } = {}) {
      const agent = { id, session: { id, header: origin === undefined ? {} : { origin } } }
      if (preset !== undefined) parents.set(agent, preset.key)
      const owner = fiber(agent)
      agent.ctx = owner.ctx
      agents.set(id, agent)
      fibers.set(agent, owner)
      for (const entry of [...hooks.get('agent/created') ?? []]) {
        if (!admits(entry, agent)) continue
        // A serial listener that returns a value ends the dispatch for the listeners after it.
        assert.equal(entry.listener({ agent, source: 'startup' }), undefined)
      }
      return agent
    },
    /** The first half of an agent's disposal: its scope is gone, the registry still lists it. */
    unwind(agent) {
      fibers.get(agent).unload()
    },
    dispose(agent) {
      fibers.get(agent).unload()
      agents.delete(agent.id)
    },
    /** What `AgentPresetRegistry.select` does to a blank session: re-parent, then announce. */
    select(agent, preset) {
      parents.set(agent, preset.key)
      for (const entry of [...hooks.get('agent-preset/selected') ?? []]) entry.listener(agent.id, 'selected')
    },
    emit(name, ...args) {
      for (const entry of [...hooks.get(name) ?? []]) entry.listener(...args)
    },
    load() {
      const owner = fiber(undefined)
      plugin.apply(owner.ctx)
      return owner
    },
    get,
    /** Names of the tools one agent sees. */
    visible(agent) {
      const names = [...inherited(agent).keys()].filter(name => !denied(name, agent))
      return [...new Set([...names, ...layer(agent).tools.keys()])].sort()
    },
    /** Everything registered in one agent's own scope. */
    registered(agent) {
      return {
        tools: [...layer(agent).tools.keys()],
        restrictions: [...layer(agent).denies].map(deny => [...deny]),
        listeners: [...hooks.entries()].flatMap(([name, entries]) => entries.filter(entry => entry.scope === agent).map(() => name)),
        effects: fibers.get(agent).live.size,
      }
    },
    /** Run the prompt assembly waterfall for one agent over the given sections. */
    assemble(agent, sections) {
      const assembly = { sections, contexts: [{ name: 'cwd', text: '/work' }], variables: { model: 'mock' } }
      const listeners = (hooks.get('system-prompt/assemble') ?? []).filter(entry => admits(entry, agent)).map(entry => entry.listener)
      const next = () => {
        const listener = listeners.shift()
        return listener === undefined ? Promise.resolve(assembly) : listener(assembly, { agent, scope: agent }, next)
      }
      return next()
    },
  }
}

const NOTHING = { tools: [], restrictions: [], listeners: [], effects: 0 }
const EVERYTHING = { tools: ['job_output', 'bash'], restrictions: [['wait_agent']], listeners: ['system-prompt/assemble'], effects: 1 }

/** A host tool as `defineTool` compiles it, recording its calls. */
function hostTool(name, properties, required, result) {
  const calls = []
  const definition = {
    name,
    description: `host ${name}`,
    parameters: { type: 'object', properties, required },
    output: { schema: { type: 'object' }, render: () => [], presentationMeta: () => ({}) },
    finalizeContent: () => undefined,
    presentCall: () => undefined,
    presentResult: () => undefined,
    execute(args, exec) {
      calls.push({ args, exec })
      return Promise.resolve(result)
    },
  }
  return { definition, calls }
}

const jobOutput = (label = 'host') => hostTool('job_output', {
  job_id: { type: 'string', description: 'Job id returned by the tool that started the background work.' },
  wait: { type: 'boolean', description: 'Block until the job finishes or the timeout expires; a timed-out wait leaves the job running. Defaults to false.' },
  timeout_ms: { type: 'number', description: 'Max wait in milliseconds with wait: true. Defaults to and is capped by configuration.' },
}, ['job_id'], { text: `read by ${label}` })

const HOST_TIMEOUT = { type: 'number', description: 'Timeout in milliseconds. The executor applies its configured default and cap; on expiry the command moves to the background as a job instead of being killed.' }
const RUN_IN_BACKGROUND = { type: 'boolean', description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.' }

/** The host `bash`; `omit` leaves out a parameter, as its foreground-only and persistent variants do. */
const bash = (label = 'host', omit) => hostTool('bash', Object.fromEntries(Object.entries({
  description: { type: 'string', description: 'Clear, concise description of what this command does.' },
  command: { type: 'string', description: 'The bash command to execute.' },
  timeoutMs: HOST_TIMEOUT,
  workdir: { type: 'string', description: 'Working directory for this command.' },
  run_in_background: RUN_IN_BACKGROUND,
  sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'], description: 'The narrowest wider sandbox mode.' },
  justification: { type: 'string', description: 'Required with sandbox_permissions.' },
}).filter(([parameter]) => parameter !== omit)), ['description', 'command'], { kind: 'foreground', ranBy: label })

const tool = name => hostTool(name, {}, [], name).definition

/** A preset holding the tools a Desktop or Web preset mounts. */
function fullPreset(h, label) {
  const jobs = jobOutput(label)
  const shell = bash(label)
  return { preset: h.preset(jobs.definition, tool('wait_agent'), tool('job_list'), shell.definition), jobs, shell }
}

const HOST_VIEW = ['bash', 'job_list', 'job_output', 'wait_agent']
const PLUGIN_VIEW = ['bash', 'job_list', 'job_output']
const WAIT_DESCRIPTION = 'Foreground wait in milliseconds: defaults to 10000, capped at 60000. On expiry the command moves to the background as a job instead of being killed.'

// The host's own section texts, from tool-jobs and tool-agent-team.
const JOBS_HEAD = 'Track every background job id you start. You are notified in-session when a job finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running job\'s work. '
const JOBS_SENTENCE = 'Before giving a final answer, collect every still-relevant job with job_output (set wait: true only when you are genuinely blocked on it), and job_kill jobs that stopped mattering.'
const JOBS_REWRITTEN = 'When only waiting for a job remains, end your turn instead of sleeping or polling; its completion notice starts a new turn. Before giving a final answer, read every still-relevant job with job_output, and job_kill jobs that stopped mattering.'
const TEAM_HEAD = `Agent Teams is available in this session.

The Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member. Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock.

Use the names returned by subagent, subagent_fork, or list_agents as owner when assigning or filtering shared tasks. The root can reassign tasks to itself or any continuable descendant; other agents claim ready tasks themselves. Shared-task workflow is list, get, claim with the current revision, perform the work, then complete. Task readiness never starts an owner. `
const TEAM_SENTENCE = 'The root agent must wait for required teammates before giving the final answer.'
const TEAM_REWRITTEN = 'The root agent gives the final answer only after the required teammates have reported; when only waiting for them remains, it ends its turn, and their reports start a new turn.'
const TEAM_TAIL = `

Task changes do not end wait_agent calls, add inbox messages, or start idle agents. Use send_message when another agent needs to act on a task.`

const hostSections = () => [
  { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
  { name: 'team:policy', text: `${TEAM_HEAD}${TEAM_SENTENCE}${TEAM_TAIL}` },
  { name: 'tool:bash', text: 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.' },
  { name: 'tool:jobs', text: `${JOBS_HEAD}${JOBS_SENTENCE}` },
]
const textOf = (assembly, name) => assembly.sections.find(section => section.name === name)?.text

describe('top-level agents', () => {
  it('hides wait_agent and shadows job_output and bash, for a live agent and for a later one', () => {
    const h = host()
    const { preset, jobs, shell } = fullPreset(h)
    const live = h.agent('live', { preset })
    assert.deepEqual(h.visible(live), HOST_VIEW)

    h.load()
    const later = h.agent('later', { preset })
    for (const agent of [live, later]) {
      assert.deepEqual(h.visible(agent), PLUGIN_VIEW)
      assert.deepEqual(h.registered(agent), EVERYTHING)
      assert.notEqual(h.get('job_output', agent), jobs.definition)
      assert.deepEqual(Object.keys(h.get('job_output', agent).parameters.properties), ['job_id'])
      assert.notEqual(h.get('bash', agent), shell.definition)
      assert.equal(h.get('bash', agent).parameters.properties.timeoutMs.description, WAIT_DESCRIPTION)
    }
  })

  it('leaves subagents alone', async () => {
    const h = host()
    const { preset, jobs, shell } = fullPreset(h)
    const before = h.agent('child-before', { origin: 'subagent', preset })
    h.load()
    const after = h.agent('child-after', { origin: 'subagent', preset })
    for (const child of [before, after]) {
      assert.deepEqual(h.visible(child), HOST_VIEW)
      assert.equal(h.get('job_output', child), jobs.definition)
      assert.equal(h.get('bash', child), shell.definition)
      assert.deepEqual(h.registered(child), NOTHING)
      const sections = hostSections()
      assert.equal((await h.assemble(child, sections)).sections, sections)
    }
    assert.deepEqual(h.warnings, [])
  })

  it('finds tools that are registered globally, as the TUI does', () => {
    const h = host()
    const jobs = jobOutput()
    const shell = bash()
    for (const definition of [jobs.definition, tool('wait_agent'), shell.definition]) h.root.tools.register(definition)
    h.load()
    const agent = h.agent('lead')
    assert.deepEqual(h.visible(agent), ['bash', 'job_output'])
    assert.deepEqual(h.registered(agent), EVERYTHING)
    assert.equal(h.get('job_output'), jobs.definition, 'the global definition stays as it is')
    assert.equal(h.get('bash'), shell.definition)
  })
})

describe('missing host tools', () => {
  const LISTENER_ONLY = { tools: [], restrictions: [], listeners: ['system-prompt/assemble'], effects: 1 }

  it('registers only what the agent can see', () => {
    const h = host()
    h.load()
    const onlyJobs = h.agent('jobs', { preset: h.preset(jobOutput().definition) })
    assert.deepEqual(h.registered(onlyJobs), { ...LISTENER_ONLY, tools: ['job_output'] })
    const onlyWait = h.agent('wait', { preset: h.preset(tool('wait_agent')) })
    assert.deepEqual(h.registered(onlyWait), { ...LISTENER_ONLY, restrictions: [['wait_agent']] })
    assert.deepEqual(h.visible(onlyWait), [])
    const neither = h.agent('neither', { preset: h.preset(tool('read')) })
    assert.deepEqual(h.registered(neither), LISTENER_ONLY)
    assert.deepEqual(h.visible(neither), ['read'])
    assert.deepEqual(h.registered(h.agent('unbound')), LISTENER_ONLY)
  })

  it('leaves bash alone when the agent has no job_output to read the job with', () => {
    const h = host()
    const shell = bash()
    h.load()
    const agent = h.agent('lead', { preset: h.preset(shell.definition, tool('wait_agent')) })
    assert.deepEqual(h.registered(agent).tools, [])
    assert.equal(h.get('bash', agent), shell.definition)
  })

  for (const [parameter, variant] of [['timeoutMs', 'the persistent bash'], ['run_in_background', 'a bash without the background surface']]) {
    it(`leaves bash alone when it declares no ${parameter}: ${variant}`, () => {
      const h = host()
      const shell = bash('host', parameter)
      h.load()
      const agent = h.agent('lead', { preset: h.preset(shell.definition, jobOutput().definition) })
      assert.deepEqual(h.registered(agent).tools, ['job_output'])
      assert.equal(h.get('bash', agent), shell.definition)
    })
  }
})

describe('job_output without the blocking parameters', () => {
  it('is the host definition except for its parameters and execute', () => {
    const h = host()
    const { preset, jobs } = fullPreset(h)
    h.load()
    const shadow = h.get('job_output', h.agent('lead', { preset }))
    const { parameters, execute, ...rest } = shadow
    const { parameters: hostParameters, execute: hostExecute, ...hostRest } = jobs.definition
    assert.deepEqual(Object.keys(rest), Object.keys(hostRest))
    for (const key of Object.keys(hostRest)) assert.equal(rest[key], hostRest[key], key)
    assert.notEqual(execute, hostExecute)
    assert.deepEqual(parameters, {
      type: 'object',
      properties: { job_id: hostParameters.properties.job_id },
      required: ['job_id'],
    })
    assert.deepEqual(Object.keys(hostParameters.properties), ['job_id', 'wait', 'timeout_ms'], 'the host schema is not edited')
  })

  it('drops wait and timeout_ms from a call before the host runs it', async () => {
    const h = host()
    const { preset, jobs } = fullPreset(h)
    h.load()
    const shadow = h.get('job_output', h.agent('lead', { preset }))
    const exec = { callId: 'c1' }
    const args = Object.freeze({ job_id: 'job-1', wait: true, timeout_ms: 60_000 })
    assert.deepEqual(await shadow.execute(args, exec), { text: 'read by host' })
    await shadow.execute({ job_id: 'job-2' }, exec)
    assert.deepEqual(jobs.calls.map(call => call.args), [{ job_id: 'job-1' }, { job_id: 'job-2' }])
    assert.equal(jobs.calls[0].exec, exec)
    assert.deepEqual(args, { job_id: 'job-1', wait: true, timeout_ms: 60_000 })
  })

  it('hands arguments that are not an object to the host as they are', async () => {
    const h = host()
    const { preset, jobs } = fullPreset(h)
    h.load()
    const shadow = h.get('job_output', h.agent('lead', { preset }))
    const malformed = ['{"job_id": "job-1", "wait": tr', null, ['job-1']]
    for (const args of malformed) await shadow.execute(args, {})
    assert.deepEqual(jobs.calls.map(call => call.args), malformed)
  })
})

describe('bash with a short foreground wait', () => {
  function shadowed() {
    const h = host()
    const { preset, shell } = fullPreset(h)
    h.load()
    return { shadow: h.get('bash', h.agent('lead', { preset })), shell }
  }
  const COMMAND = { command: 'npm test', description: 'Run the tests' }

  it('is the host definition except for the timeoutMs description and execute', () => {
    const { shadow, shell } = shadowed()
    const { parameters, execute, ...rest } = shadow
    const { parameters: hostParameters, execute: hostExecute, ...hostRest } = shell.definition
    assert.deepEqual(Object.keys(rest), Object.keys(hostRest))
    for (const key of Object.keys(hostRest)) assert.equal(rest[key], hostRest[key], key)
    assert.notEqual(execute, hostExecute)

    const { properties, ...schema } = parameters
    const { properties: hostProperties, ...hostSchema } = hostParameters
    assert.deepEqual(schema, hostSchema)
    assert.equal(schema.required, hostSchema.required)
    assert.deepEqual(Object.keys(properties), Object.keys(hostProperties))
    for (const key of Object.keys(hostProperties)) {
      if (key !== 'timeoutMs') assert.equal(properties[key], hostProperties[key], key)
    }
    assert.deepEqual(properties.timeoutMs, { type: 'number', description: WAIT_DESCRIPTION })
    assert.equal(hostProperties.timeoutMs, HOST_TIMEOUT, 'the host schema is not edited')
    assert.notEqual(HOST_TIMEOUT.description, WAIT_DESCRIPTION)
  })

  for (const [what, given, passed] of [
    ['applies the default when the call names no wait', {}, { timeoutMs: 10_000 }],
    ['applies the default to an explicit foreground call', { run_in_background: false }, { run_in_background: false, timeoutMs: 10_000 }],
    ['caps a longer wait', { timeoutMs: 600_000 }, { timeoutMs: 60_000 }],
    ['caps a wait just above the limit', { timeoutMs: 60_001 }, { timeoutMs: 60_000 }],
    ['keeps the limit itself', { timeoutMs: 60_000 }, { timeoutMs: 60_000 }],
    ['keeps a shorter wait', { timeoutMs: 3_000 }, { timeoutMs: 3_000 }],
    ['has no lower bound', { timeoutMs: 0.5 }, { timeoutMs: 0.5 }],
  ]) {
    it(what, async () => {
      const { shadow, shell } = shadowed()
      const exec = { callId: 'c1' }
      const args = Object.freeze({ ...COMMAND, ...given })
      assert.deepEqual(await shadow.execute(args, exec), { kind: 'foreground', ranBy: 'host' })
      assert.deepEqual(shell.calls, [{ args: { ...COMMAND, ...passed }, exec }])
      assert.equal(shell.calls[0].exec, exec)
      assert.deepEqual(args, { ...COMMAND, ...given })
    })
  }

  it('leaves a background start untouched', async () => {
    const { shadow, shell } = shadowed()
    const starts = [{ ...COMMAND, run_in_background: true }, { ...COMMAND, run_in_background: true, timeoutMs: 600_000 }]
    for (const args of starts) await shadow.execute(args, {})
    assert.deepEqual(shell.calls.map(call => call.args), starts)
    for (const [index, args] of starts.entries()) assert.equal(shell.calls[index].args, args)
  })

  it('passes a wait that is not a positive number through, for the host to reject', async () => {
    const { shadow, shell } = shadowed()
    const invalid = [0, -5, '5000', null, true, Number.NaN, Number.POSITIVE_INFINITY, { ms: 5 }]
    for (const timeoutMs of invalid) await shadow.execute({ ...COMMAND, timeoutMs }, {})
    assert.deepEqual(shell.calls.map(call => call.args), invalid.map(timeoutMs => ({ ...COMMAND, timeoutMs })))
  })

  it('hands arguments that are not an object to the host as they are', async () => {
    const { shadow, shell } = shadowed()
    const malformed = ['{"command": "npm test", "descr', null, [COMMAND]]
    for (const args of malformed) await shadow.execute(args, {})
    assert.deepEqual(shell.calls.map(call => call.args), malformed)
  })
})

describe('prompt rewrite', () => {
  it('replaces both sentences and nothing else', async () => {
    const h = host()
    const { preset } = fullPreset(h)
    h.load()
    const agent = h.agent('lead', { preset })
    const sections = hostSections()
    const assembly = await h.assemble(agent, sections)
    assert.equal(textOf(assembly, 'tool:jobs'), `${JOBS_HEAD}${JOBS_REWRITTEN}`)
    assert.equal(textOf(assembly, 'team:policy'), `${TEAM_HEAD}${TEAM_REWRITTEN}${TEAM_TAIL}`)
    assert.equal(assembly.sections[0], sections[0])
    assert.equal(assembly.sections[2], sections[2])
    assert.deepEqual(assembly.sections.map(section => section.name), sections.map(section => section.name))
    assert.deepEqual(assembly.contexts, [{ name: 'cwd', text: '/work' }])
    assert.deepEqual(assembly.variables, { model: 'mock' })
    assert.equal(sections[3].text, `${JOBS_HEAD}${JOBS_SENTENCE}`, 'the assembled input is not edited')
    assert.deepEqual(h.warnings, [])
  })

  it('warns once and leaves the section alone when a sentence is not found', async () => {
    const h = host()
    const { preset } = fullPreset(h)
    h.load()
    const first = h.agent('first', { preset })
    const second = h.agent('second', { preset })
    const reworded = () => hostSections().map(section => section.name === 'tool:jobs'
      ? { ...section, text: `${JOBS_HEAD}Collect every job before you answer.` }
      : section)
    for (const agent of [first, second, first]) {
      const sections = reworded()
      const assembly = await h.assemble(agent, sections)
      assert.equal(assembly.sections[3], sections[3])
      assert.equal(textOf(assembly, 'team:policy'), `${TEAM_HEAD}${TEAM_REWRITTEN}${TEAM_TAIL}`, 'the other sentence is still replaced')
    }
    assert.equal(h.warnings.length, 1)
    assert.match(h.warnings[0], /prompt section "tool:jobs" no longer contains the sentence/)

    const policy = hostSections().map(section => section.name === 'team:policy' ? { ...section, text: 'Agent Teams is on.' } : section)
    await h.assemble(first, policy)
    await h.assemble(second, policy)
    assert.equal(h.warnings.length, 2)
    assert.match(h.warnings[1], /prompt section "team:policy"/)
  })

  it('says nothing when the host gave the agent no such guidance', async () => {
    const h = host()
    const { preset } = fullPreset(h)
    h.load()
    const agent = h.agent('lead', { preset })
    // Agent Teams is off: the host renders its section empty. A preset without job tools has no jobs section.
    const sections = [hostSections()[0], { name: 'team:policy', text: '' }]
    assert.deepEqual((await h.assemble(agent, sections)).sections, sections)
    assert.deepEqual(h.warnings, [])
  })
})

describe('lifetime', () => {
  it('lets a disposed agent take its registrations with it', () => {
    const h = host()
    const { preset } = fullPreset(h)
    const loaded = h.load()
    const gone = h.agent('gone', { preset })
    const kept = h.agent('kept', { preset })
    h.dispose(gone)
    assert.deepEqual(h.registered(gone), NOTHING)
    assert.deepEqual(h.registered(kept), EVERYTHING)
    loaded.unload()
    assert.deepEqual(h.registered(kept), NOTHING)
  })

  it('restores the tools and the prompt of live agents when it unloads', async () => {
    const h = host()
    const { preset, jobs, shell } = fullPreset(h)
    const loaded = h.load()
    const agent = h.agent('lead', { preset })
    assert.deepEqual(h.visible(agent), PLUGIN_VIEW)

    loaded.unload()
    assert.deepEqual(h.registered(agent), NOTHING)
    assert.deepEqual(h.visible(agent), HOST_VIEW)
    assert.equal(h.get('job_output', agent), jobs.definition)
    assert.equal(h.get('bash', agent), shell.definition)
    const sections = hostSections()
    assert.equal((await h.assemble(agent, sections)).sections, sections)
    assert.deepEqual(h.registered(h.agent('after', { preset })), NOTHING, 'no listener is left')
    assert.equal(loaded.live.size, 0)

    const again = h.load()
    assert.deepEqual(h.visible(agent), PLUGIN_VIEW)
    again.unload()
    assert.deepEqual(h.visible(agent), HOST_VIEW)
  })

  it('skips an agent that is being disposed while it loads', () => {
    const h = host()
    const { preset } = fullPreset(h)
    const dying = h.agent('dying', { preset })
    const live = h.agent('live', { preset })
    h.unwind(dying)
    h.load()
    assert.deepEqual(h.registered(dying), NOTHING)
    assert.deepEqual(h.registered(live), EVERYTHING)
  })

  it('still fails to load on any other error, and leaves nothing behind', () => {
    const h = host()
    const { preset } = fullPreset(h)
    const live = h.agent('live', { preset })
    const broken = h.agent('broken', { preset })
    broken.ctx.effect = () => { throw new Error('scope is broken') }
    assert.throws(() => h.load(), /scope is broken/)
    assert.deepEqual(h.registered(live), NOTHING)
    assert.deepEqual(h.registered(h.agent('later', { preset })), NOTHING)
  })
})

describe('preset change of a blank session', () => {
  it('applies again against the preset the session switched to', async () => {
    const h = host()
    const first = fullPreset(h, 'first preset')
    const second = fullPreset(h, 'second preset')
    h.load()
    const agent = h.agent('lead', { preset: first.preset })
    const child = h.agent('child', { origin: 'subagent', preset: first.preset })

    h.select(agent, second.preset)
    assert.deepEqual(h.registered(agent), EVERYTHING)
    assert.deepEqual(await h.get('job_output', agent).execute({ job_id: 'job-1', wait: true }, {}), { text: 'read by second preset' })
    assert.deepEqual(await h.get('bash', agent).execute({ command: 'ls', description: 'List files' }, {}), { kind: 'foreground', ranBy: 'second preset' })
    assert.deepEqual([first.jobs.calls, first.shell.calls], [[], []])
    assert.deepEqual(second.jobs.calls.map(call => call.args), [{ job_id: 'job-1' }])
    assert.deepEqual(second.shell.calls.map(call => call.args), [{ command: 'ls', description: 'List files', timeoutMs: 10_000 }])

    h.select(child, second.preset)
    assert.deepEqual(h.registered(child), NOTHING)
    h.emit('agent-preset/selected', 'no-such-session', 'second')
  })

  it('follows a preset without the tools, and one that brings them', () => {
    const h = host()
    const full = fullPreset(h)
    const bare = h.preset(tool('read'))
    h.load()
    const agent = h.agent('lead', { preset: full.preset })

    h.select(agent, bare)
    assert.deepEqual(h.visible(agent), ['read'])
    assert.deepEqual(h.registered(agent), { tools: [], restrictions: [], listeners: ['system-prompt/assemble'], effects: 1 })

    h.select(agent, full.preset)
    assert.deepEqual(h.visible(agent), PLUGIN_VIEW)
    assert.deepEqual(h.registered(agent), EVERYTHING)
  })
})
