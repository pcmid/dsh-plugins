/**
 * Async agents, step 1: the top-level agent of a session stops blocking on
 * background work.
 *
 * For every agent that is not a subagent, this plugin
 *
 * 1. hides `wait_agent`,
 * 2. shadows `job_output` with a copy that has no `wait` and `timeout_ms`,
 * 3. shadows `bash` with a copy whose foreground wait defaults to 10 s and is
 *    capped at 60 s, after which the host moves the command to a background
 *    job, and
 * 4. rewrites the two host guidance sentences that tell the model to wait.
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

/** Parameters of `job_output` that make it wait for the job. */
const BLOCKING_PARAMETERS = ['wait', 'timeout_ms']

/** Foreground wait of one `bash` call, in milliseconds. */
const DEFAULT_WAIT_MS = 10_000
const MAX_WAIT_MS = 60_000
const WAIT_DESCRIPTION = `Foreground wait in milliseconds: defaults to ${DEFAULT_WAIT_MS}, capped at ${MAX_WAIT_MS}. On expiry the command moves to the background as a job instead of being killed.`

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
 * Apply the changes to every top-level agent, live now or created later.
 * @param ctx - plugin context. Unloading it also removes what was registered through an agent's own context.
 */
export function apply(ctx) {
  /** Top-level agent → disposer of its registrations, which the agent's scope owns as well. */
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
    }, 'async-agents'))
  }

  const isTopLevel = agent => agent.session.header.origin !== 'subagent'

  ctx.effect(function* () {
    // The agents' scopes own those registrations; without this they would outlive the plugin.
    yield () => { for (const dispose of [...attached.values()]) dispose() }
    yield ctx.on('agent/created', ({ agent }) => { if (isTopLevel(agent)) attach(agent) })
    // A blank session that switches preset inherits another set of tools.
    yield ctx.on('agent-preset/selected', (sessionId) => {
      const agent = ctx.agents.get(sessionId)
      if (attached.has(agent)) attach(agent)
    })
    for (const agent of ctx.agents.list()) {
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
