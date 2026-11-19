/**
 * Async agents: an agent stops blocking on background work.
 *
 * For every top-level agent, and for every local subagent the host starts
 * with its result going to its parent, this plugin
 *
 * 1. hides `wait_agent`,
 * 2. shadows `job_output` with a copy that has no `wait` and `timeout_ms`,
 * 3. shadows `bash` with a copy whose foreground wait defaults to 10 s and is
 *    capped at 60 s, after which the host moves the command to a background
 *    job, and
 * 4. rewrites the two host guidance sentences that tell the model to wait.
 *
 * A subagent qualifies by the `delivery` field of `subagent/start`, which
 * comes with a host that keeps such a subagent loaded while its background
 * job runs. A host without the field may unload an idle subagent and kill its
 * job, so there every subagent keeps the host tools. So does a subagent that
 * was loaded before this plugin.
 *
 * Where the subagent service can close a descendant, an agent that has
 * `list_agents` also gets `close_agent`, and a call of its own that fails at
 * the subagent limit names the idle subagents it can close.
 *
 * Tools are looked up as the agent sees them: Desktop and Web register them in
 * the agent preset's scope, not globally. A shadow captures the host
 * definition when it is registered, and everything is applied again when a
 * blank session switches preset.
 *
 * @module @pcmid/dsh-async-agents
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'async-agents'

export const inject = ['agents', 'tools']

const WAIT_AGENT = 'wait_agent'
const JOB_OUTPUT = 'job_output'
const BASH = 'bash'
const LIST_AGENTS = 'list_agents'

/** Parameters of `job_output` that make it wait for the job. */
const BLOCKING_PARAMETERS = ['wait', 'timeout_ms']

/** Foreground wait of one `bash` call, in milliseconds. */
const DEFAULT_WAIT_MS = 10_000
const MAX_WAIT_MS = 60_000
const WAIT_DESCRIPTION = `Foreground wait in milliseconds: defaults to ${DEFAULT_WAIT_MS}, capped at ${MAX_WAIT_MS}. On expiry the command moves to the background as a job instead of being killed.`

/** Error code of a call that would load more subagents than the host allows. */
const LIMIT_REACHED = 'ACTIVATION_LIMIT_REACHED'
/** Longest job label one result line shows, the bound of the host's own notices. */
const JOB_LABEL_MAX = 120
/** Most subagents one limit hint names. */
const MAX_HINTED = 10

/** Host guidance that tells the model to wait, by prompt section, and its replacement. */
const REWRITES = [
  {
    section: 'tool:jobs',
    from: 'Before giving a final answer, collect every still-relevant job with job_output (set wait: true only when you are genuinely blocked on it), and job_kill jobs that stopped mattering.',
    to: 'When only waiting for a job remains, end your turn instead of sleeping or polling; its completion notice starts a new turn. Before giving a final answer, read every still-relevant job with job_output, and job_kill jobs that stopped mattering.',
  },
  {
    section: 'team:policy',
    from: 'The root agent must wait for required teammates before giving the final answer.',
    to: 'The root agent gives the final answer only after the required teammates have reported; when only waiting for them remains, it ends its turn, and their reports start a new turn.',
  },
]

/** Whether a call's arguments are a JSON object. Malformed model output arrives as text, which the host tool reports. */
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

const without = (object, keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)))

/**
 * The host `job_output` without its blocking parameters.
 * @param host - the definition the agent resolves without this plugin.
 * @returns the same tool, with `wait` and `timeout_ms` removed from its schema and from every call.
 */
function nonBlockingJobOutput(host) {
  return {
    ...host,
    parameters: { ...host.parameters, properties: without(host.parameters.properties, BLOCKING_PARAMETERS) },
    execute: (args, exec) => host.execute(isObject(args) ? without(args, BLOCKING_PARAMETERS) : args, exec),
  }
}

/**
 * The foreground wait one `bash` call gets.
 * @param timeoutMs - the wait the model asked for, if any.
 * @returns the default, the capped request, or the request itself when it is not a positive number, for the host to reject.
 */
function boundedWait(timeoutMs) {
  if (timeoutMs === undefined) return DEFAULT_WAIT_MS
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, MAX_WAIT_MS) : timeoutMs
}

/**
 * The host `bash` with a short foreground wait.
 * @param host - the definition the agent resolves without this plugin.
 * @returns the same tool, with the wait of every foreground call bounded and its parameter described accordingly.
 */
function shortWaitBash(host) {
  const { properties } = host.parameters
  return {
    ...host,
    parameters: { ...host.parameters, properties: { ...properties, timeoutMs: { ...properties.timeoutMs, description: WAIT_DESCRIPTION } } },
    execute: (args, exec) => host.execute(
      !isObject(args) || args.run_in_background === true ? args : { ...args, timeoutMs: boundedWait(args.timeoutMs) },
      exec,
    ),
  }
}

/**
 * Replace the waiting guidance in one assembled system prompt.
 * @param sections - the assembled prompt sections.
 * @param missing - receives each rule whose section has text but not the sentence.
 * @returns the sections, with a rewritten copy wherever a sentence was found.
 */
function rewriteSections(sections, missing) {
  return sections.map((section) => {
    const rule = REWRITES.find(candidate => candidate.section === section.name)
    // An absent or empty section means the host gave this agent no such guidance.
    if (rule === undefined || section.text === '') return section
    if (!section.text.includes(rule.from)) {
      missing(rule)
      return section
    }
    return { ...section, text: section.text.replace(rule.from, () => rule.to) }
  })
}

/**
 * A job label as the host's notices show one.
 * @param label - the label of a job, which for `bash` is the whole command.
 * @returns its first line, marked with `…` when more lines follow, cut to {@link JOB_LABEL_MAX} characters.
 */
function jobLabel(label) {
  const text = label.trim()
  const newline = text.indexOf('\n')
  const line = newline === -1 ? text : `${text.slice(0, newline).trimEnd()}…`
  return line.length <= JOB_LABEL_MAX ? line : `${line.slice(0, JOB_LABEL_MAX - 1)}…`
}

/**
 * One result line of `close_agent`.
 * @param closed - a closed subagent: its model-facing name, the running jobs that were cancelled with it, and the number of queued messages it lost.
 * @returns the name, then each job as its kind and label, then the number of lost messages unless it is zero or unknown.
 */
function closedLine({ name, jobs, discardedMessages }) {
  let line = `closed ${name}`
  if (jobs.length > 0) {
    const listed = jobs.map(({ kind, label }) => `(${kind}: ${jobLabel(label)})`).join(', ')
    line += jobs.length === 1 ? `; cancelled background job ${listed}` : `; cancelled ${jobs.length} background jobs: ${listed}`
  }
  if (discardedMessages > 0) line += `; discarded ${discardedMessages} queued message${discardedMessages === 1 ? '' : 's'}`
  return line
}

/**
 * The `close_agent` tool.
 * @param subagents - the host's subagent service, which resolves the name and closes the subagent.
 * @returns a definition whose result names every closed subagent with the jobs that were cancelled and the messages that were discarded.
 */
function closeAgent(subagents) {
  return {
    name: 'close_agent',
    description: 'Unload an idle subagent created under you, together with every subagent beneath it. This frees their slots toward the subagent limit and cancels the background jobs they started. Messages still queued for a closed subagent are discarded. It never interrupts a turn: when the subagent or one beneath it is working, nothing is closed and the error names it. A closed subagent keeps its conversation, and send_message starts it again.',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'The name of an agent created under you, as list_agents shows it: your direct child or a deeper descendant.' },
      },
      required: ['agent'],
    },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            jobs: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { kind: { type: 'string' }, label: { type: 'string' } },
                required: ['kind', 'label'],
              },
            },
            // Never negative, which the schema keywords the host accepts cannot say.
            discardedMessages: { type: 'integer' },
          },
          required: ['name', 'jobs'],
        },
      },
      render: (args, closed) => [{
        type: 'text',
        text: closed.length === 0 ? `no loaded subagent named ${args.agent}; nothing was closed` : closed.map(closedLine).join('\n'),
      }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('close_agent requires a calling agent (exec.agent was undefined)')
      // The host runs a plain definition without checking the arguments against its schema.
      if (!isObject(args) || typeof args.agent !== 'string') throw new Error('invalid arguments: "agent" must be a string')
      const id = await subagents.resolveName(exec.agent, args.agent, exec.signal)
      const closed = await subagents.closeDescendant(exec.agent, id)
      // Only what the schema declares: the service also reports each session id.
      return closed.map(({ name, jobs, discardedMessages }) => ({
        name,
        jobs: jobs.map(({ kind, label }) => ({ kind, label })),
        ...discardedMessages === undefined ? {} : { discardedMessages },
      }))
    },
  }
}

/**
 * The subagents one agent could close right now, by the names `close_agent` takes.
 * @param ctx - plugin context, for the loaded agents.
 * @param subagents - the host's subagent service, for the names.
 * @param agent - the agent whose descendants are named.
 * @returns up to {@link MAX_HINTED} loaded descendants that run no turn and have no loaded descendant that runs one.
 */
function closableNames(ctx, subagents, agent) {
  const loaded = ctx.agents.list()
  /** Loaded agents created under `ancestor`, directly or through other loaded subagents. */
  const below = ancestor => loaded.filter((candidate) => {
    let current = candidate
    while (current?.session.header.origin === 'subagent') {
      current = ctx.agents.get(current.session.header.parentSession)
      if (current === ancestor) return true
    }
    return false
  })
  const names = []
  for (const candidate of below(agent)) {
    if (names.length === MAX_HINTED) break
    if (candidate.status === 'running' || below(candidate).some(member => member.status === 'running')) continue
    try {
      names.push(subagents.namesOf(candidate).self)
    } catch {
      // An agent the subagent service does not run has no name to pass to `close_agent`.
    }
  }
  return names
}

/**
 * A `tools/post-execute` listener that tells the model what it can close when a call fails at the subagent limit.
 * @param ctx - plugin context, for the loaded agents.
 * @param subagents - the host's subagent service, for the names.
 * @param agent - the agent whose calls the listener sees.
 * @returns the listener; every other outcome keeps the decision of the listeners after it.
 */
function hintAtLimit(ctx, subagents, agent) {
  return async (_exec, result, next) => {
    const decision = await next()
    // Only an accepted decision that carries no `value` can give a failure new content.
    if (result.isError !== true || result.error?.info?.code !== LIMIT_REACHED
      || decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
    const names = closableNames(ctx, subagents, agent)
    if (names.length === 0) return decision
    const text = `\n\nIdle subagents you can close with close_agent to free a slot: ${names.join(', ')}. Closing one cancels the background jobs it started.`
    return { ...decision, content: [...decision.content ?? result.content, { type: 'text', text }] }
  }
}

/**
 * Apply the changes to every top-level agent, live now or created later, and to every subagent the host starts
 * with its result going to its parent.
 * @param ctx - plugin context. Unloading it also removes what was registered through an agent's own context.
 */
export function apply(ctx) {
  /** Agent → disposer of its registrations, which the agent's scope owns as well. */
  const attached = new Map()
  const warned = new Set()

  const missing = (rule) => {
    if (warned.has(rule.section)) return
    warned.add(rule.section)
    ctx.logger.warn(`prompt section "${rule.section}" no longer contains the sentence this plugin rewrites; the section is left unchanged`)
  }

  const attach = (agent) => {
    attached.get(agent)?.()
    attached.set(agent, agent.ctx.effect(function* () {
      yield () => { attached.delete(agent) }
      // `restrict` throws on a name the agent does not inherit.
      if (ctx.tools.get(WAIT_AGENT, agent) !== undefined) yield agent.ctx.tools.restrict({ deny: [WAIT_AGENT] })
      const jobOutput = ctx.tools.get(JOB_OUTPUT, agent)
      const bash = ctx.tools.get(BASH, agent)
      if (jobOutput !== undefined) yield agent.ctx.tools.register(nonBlockingJobOutput(jobOutput))
      // Only a `bash` that can hand a command to a job, for an agent that can read that job.
      const parameters = bash?.parameters.properties
      if (jobOutput !== undefined && parameters?.timeoutMs !== undefined && parameters.run_in_background !== undefined) {
        yield agent.ctx.tools.register(shortWaitBash(bash))
      }
      yield agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const presentation = await next()
        return { ...presentation, sections: rewriteSections(presentation.sections, missing) }
      })
      // The service is optional, and an older host's cannot close a descendant. `list_agents` shows the names to pass.
      const subagents = ctx.get('subagents')
      if (typeof subagents?.closeDescendant === 'function' && ctx.tools.get(LIST_AGENTS, agent) !== undefined) {
        yield agent.ctx.tools.register(closeAgent(subagents))
        yield agent.ctx.on('tools/post-execute', hintAtLimit(ctx, subagents, agent))
      }
    }, 'async-agents'))
  }

  /** A failure to apply is logged, not thrown: a throw from an `agent/created` listener would fail the host's agent creation. */
  const attachContained = (agent) => {
    try {
      attach(agent)
    } catch (error) {
      ctx.logger.warn(`could not apply to agent "${agent.id}", which keeps the host tools: ${error?.message ?? error}`)
    }
  }

  const isTopLevel = agent => agent.session.header.origin !== 'subagent'

  ctx.effect(function* () {
    // The agents' scopes own those registrations; without this they would outlive the plugin.
    yield () => { for (const dispose of [...attached.values()]) dispose() }
    yield ctx.on('agent/created', ({ agent }) => { if (isTopLevel(agent)) attachContained(agent) })
    // A subagent waits for `subagent/start`, which says where its result goes; its agent is registered by then.
    // Only one that reports to its parent stays loaded while its job runs, and only a local one has an agent here.
    yield ctx.on('subagent/start', (info) => {
      if (info.local === true && info.delivery === 'parent') attachContained(ctx.agents.get(info.id))
    })
    // A blank session that switches preset inherits another set of tools.
    yield ctx.on('agent-preset/selected', (sessionId) => {
      const agent = ctx.agents.get(sessionId)
      if (attached.has(agent)) attachContained(agent)
    })
    for (const agent of ctx.agents.list()) {
      // Where the result of a subagent that is already loaded goes is not known here.
      if (!isTopLevel(agent)) continue
      try {
        attach(agent)
      } catch (error) {
        // An agent that is being disposed stays listed until its session is closed, after its scope is gone.
        if (error?.code !== 'INACTIVE_EFFECT') throw error
      }
    }
  }, 'async-agents')
}
