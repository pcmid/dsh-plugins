/**
 * Todo progress guard: keeps the agent's `todo_write` list in step with its work.
 *
 * The task list only changes when the model calls `todo_write` again, so a long
 * tool-heavy turn can leave it showing its first item as in progress while the
 * work moves on. This plugin adds two mechanisms:
 *
 * 1. Mid-turn reminder (`tools/post-execute`): once an unfinished list has gone
 *    `stepThreshold` steps or `callThreshold` tool calls without a `todo_write`,
 *    one notice is attached to that step's results, at most one per step. The
 *    notice repeats the list verbatim, because `todo_write` replaces the whole
 *    list and the model must resend every item.
 * 2. Turn-end completion (`agent/turn-stopping`, off by default): when a turn
 *    ends normally after real work, leftover items are written back as
 *    `completed` in one final `todo/write`.
 *
 * Tracking state is folded in memory from `session/event`, per Session. It
 * starts at the first event the plugin sees: a turn already running when the
 * plugin loads gets reminders only after its next `todo_write`, and no turn-end
 * completion.
 *
 * Derived from dsh-todo-progress-guard 1.0.2 by DoubleChess (MIT, see LICENSE).
 *
 * @module @pcmid/dsh-todo-guard
 */

import z from '@deepseek-ai/schemastery'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'todo-guard'

/** `source.kind` of every reminder this plugin injects. */
export const SOURCE_KIND = 'todo-guard'

/** Tool that writes the task list. */
const TODO_TOOL = 'todo_write'

/**
 * Tools that hand the turn to the human. A step that called one gets no
 * reminder, and a turn whose last tool step called one is not auto-completed.
 */
const INTERACTIVE_TOOLS = new Set(['ask_user_question', 'exit_plan_mode'])

export const Config = z.object({
  stepThreshold: z.natural().min(1).default(5)
    .description('Remind after this many model steps without a todo_write while the list has unfinished items.'),
  callThreshold: z.natural().min(1).default(10)
    .description('Remind after this many tool calls without a todo_write while the list has unfinished items.'),
  autoCompleteOnTurnEnd: z.boolean().default(false)
    .description('When a turn ends normally after real work, mark the remaining items completed.'),
})

/**
 * Whether a list exists and has an item that is not completed.
 * @param todos - the latest `todo/write` list, or null before the first write of the turn.
 * @returns true when at least one item is pending or in progress.
 */
export function hasUnfinished(todos) {
  return Array.isArray(todos) && todos.some(item => item.status !== 'completed')
}

/**
 * Model-facing reminder text.
 * @param todos - the current list; every item is repeated with its exact text.
 * @param steps - steps since the last `todo_write`.
 * @param calls - tool calls since the last `todo_write`.
 * @returns the complete reminder body.
 */
export function reminderText(todos, steps, calls) {
  const done = todos.filter(item => item.status === 'completed').length
  return [
    `Todo list check: ${done}/${todos.length} completed, ${steps} step(s) and ${calls} tool call(s) since your last todo_write.`,
    ...todos.map((item, index) => `${index + 1}. [${item.status}] ${item.content}`),
    'If this list no longer matches your progress, call todo_write with the complete updated list; the call can run in parallel with your next tool call. If it still matches, continue without calling todo_write. Before your final reply, mark every finished task completed.',
  ].join('\n')
}

/**
 * One-line account shown on the collapsed notice row.
 * @param todos - the current list.
 * @returns the bounded summary.
 */
export function reminderSummary(todos) {
  const done = todos.filter(item => item.status === 'completed').length
  const active = todos.find(item => item.status === 'in_progress')
  const head = `Todo list ${done}/${todos.length} completed`
  return boundContextSummary(active === undefined ? head : `${head} · ${active.content}`)
}

/**
 * Fresh tracking state of one Session.
 * @returns state with no open turn and no list.
 */
export function createState() {
  return {
    /** Turn number between `turn/start` and `turn/end`, else null. */
    openTurn: null,
    /** Step number between `step/start` and `step/end`, else null. */
    openStep: null,
    /** The latest `todo/write` list of the open turn, or null. */
    todos: null,
    /** Non-`todo_write` tool calls since the first list of the turn. */
    workCalls: 0,
    stepsSince: 0,
    callsSince: 0,
    /** The open step called `todo_write`. */
    stepWroteTodos: false,
    /** The open step called an interactive tool. */
    stepInteractive: false,
    /** A reminder was attached in the open step. */
    stepReminded: false,
    /** The last step that called tools called an interactive tool. */
    lastToolStepInteractive: false,
    /** The last assistant message was cut off. */
    lastAssistantInterrupted: false,
  }
}

function resetCounters(state) {
  state.stepsSince = 0
  state.callsSince = 0
}

/**
 * Count tool calls of the open step. A `todo_write` resets the counters, and
 * the step's other calls do not count: the list was written in that step.
 * @param state - Session tracking state, mutated.
 * @param names - the called tools, in call order.
 */
function observeCalls(state, names) {
  for (const toolName of names) {
    if (toolName === TODO_TOOL) {
      state.stepWroteTodos = true
      resetCounters(state)
      continue
    }
    if (INTERACTIVE_TOOLS.has(toolName)) {
      state.stepInteractive = true
      state.lastToolStepInteractive = true
    }
    if (state.todos !== null) state.workCalls += 1
    if (!state.stepWroteTodos) state.callsSince += 1
  }
}

/**
 * Fold one committed Session event into the tracking state.
 * @param state - Session tracking state, mutated.
 * @param event - the committed event.
 */
export function observe(state, event) {
  switch (event.type) {
    case 'turn/start':
      Object.assign(state, createState(), { openTurn: event.data.turn })
      break
    case 'turn/end':
      state.openTurn = null
      state.openStep = null
      break
    case 'step/start':
      state.openStep = event.data.step
      state.stepWroteTodos = false
      state.stepInteractive = false
      state.stepReminded = false
      break
    case 'step/end':
      state.openStep = null
      break
    case 'assistant/message': {
      // Committed before the step's tools run, so every reminder decision of
      // the step already knows all of its top-level calls.
      state.lastAssistantInterrupted = event.data.interrupted === true
      const calls = event.data.message.content.filter(block => block.type === 'tool-call')
      if (calls.length === 0) break
      state.lastToolStepInteractive = false
      state.stepsSince += 1
      observeCalls(state, calls.map(call => call.name))
      break
    }
    case 'tool/ptc-dispatch-start':
      // A tool called from inside `run_code`.
      observeCalls(state, [event.data.name])
      break
    case 'todo/write':
      state.todos = event.data.todos
      break
    default:
      break
  }
}

/** Prepend a reminder while keeping every downstream context and the downstream verdict. */
function withReminder(downstream, reminder) {
  const additionalContexts = [reminder, ...downstream.additionalContexts ?? []]
  return downstream.kind === 'block'
    ? { kind: 'block', feedback: downstream.feedback, additionalContexts }
    : { ...downstream, additionalContexts }
}

/**
 * Register the guard's listeners.
 * @param ctx - plugin context; listeners are disposed with it.
 * @param config - validated {@link Config}.
 */
export function apply(ctx, config) {
  const { stepThreshold, callThreshold, autoCompleteOnTurnEnd } = config
  const states = new WeakMap()

  ctx.on('session/event', (session, event) => {
    let state = states.get(session)
    if (state === undefined) {
      state = createState()
      states.set(session, state)
    }
    observe(state, event)
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    // Calls made inside `run_code` report their own post-execute; the outer call
    // speaks for the step.
    if (exec.agent === undefined || exec.parent !== undefined) return downstream
    // A reminder would keep a concluded turn running for one more step.
    if (result.concludesTurn === true) return downstream
    const state = states.get(exec.agent.session)
    if (state === undefined || state.openStep === null) return downstream
    if (state.stepWroteTodos || state.stepInteractive || state.stepReminded) return downstream
    if (!hasUnfinished(state.todos)) return downstream
    const due = state.stepsSince >= stepThreshold || state.callsSince >= callThreshold
    if (!due) return downstream

    const reminder = createUserMessage({
      content: [{ type: 'text', text: reminderText(state.todos, state.stepsSince, state.callsSince) }],
      source: { kind: SOURCE_KIND, form: 'notice', summary: reminderSummary(state.todos) },
    })
    state.stepReminded = true
    resetCounters(state)
    return withReminder(downstream, reminder)
  })

  if (!autoCompleteOnTurnEnd) return

  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    // Queued steering runs another step, so the turn is not over yet.
    if (signal.aborted || agent.inbox.nextStep.length > 0) return
    const session = agent.session
    const state = states.get(session)
    if (state === undefined || state.openTurn !== turn || state.openStep !== null) return
    if (state.lastAssistantInterrupted || state.lastToolStepInteractive) return
    if (!hasUnfinished(state.todos)) return
    // A list nobody worked on yet is a plan, not a result.
    if (state.workCalls === 0 && !state.todos.some(item => item.status === 'completed')) return
    try {
      session.append('todo/write', { todos: state.todos.map(item => ({ content: item.content, status: 'completed' })) })
    } catch (error) {
      ctx.logger.warn(`todo-guard: could not complete the task list at turn end: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
