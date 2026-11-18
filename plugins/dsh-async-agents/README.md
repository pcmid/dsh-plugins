# Async agents

`@pcmid/dsh-async-agents` keeps an agent from blocking on background work. A long shell command continues as a background job, the agent can no longer wait on a job or on a subagent, and it is told to end its turn instead. DSH then starts the agent's next turn when the job or the subagent reports.

## Which agents are changed

- **Top-level agents**: agents whose session is not a subagent (`session.header.origin !== 'subagent'`).
- **Subagents whose result goes to their parent**, which are the ones an agent starts with a delegation tool. This needs a DSH that keeps such a subagent loaded while a background job it started is running. The plugin recognizes that DSH by the `delivery` field of its `subagent/start` event, which says where the result of a subagent goes, and it changes a subagent that runs inside DSH when the field is `parent`.

Every other subagent keeps every tool and every instruction exactly as DSH defines them:

- Subagents whose result goes to the caller that started them: those of the Workflow tool and of creation recommendations. DSH unloads them as soon as they are idle.
- Subagents that an external backend runs. They have no DSH agent to change.
- Subagents that were already loaded when the plugin was loaded. The plugin cannot tell where their result goes. They are changed the next time DSH loads them.
- All subagents on a DSH that does not send `delivery`. The plugin takes that as a DSH that unloads an idle subagent and stops its jobs, where a subagent has to be able to wait.

`close_agent`, described below, needs a second addition to DSH: a subagent service that can close a subagent.

DSH 0.2.2-rc.3 as released has none of these additions. On a DSH without them the plugin behaves as version 0.1.0 did: it changes top-level agents only, and it adds no tool.

## What changes for these agents

### `bash` waits 10 seconds, 60 at most

- A foreground call without `timeoutMs` waits 10 seconds. A call may ask for a longer wait with `timeoutMs`; values above 60000 are cut to 60000. Smaller values are used as given.
- When the wait runs out, DSH moves the command to a background job, as it already does at its own timeout. The tool result names the job, and the command keeps running.
- Calls with `run_in_background: true` are not changed. A `timeoutMs` that is not a positive number is passed on, and DSH rejects it as before.
- The description of the `timeoutMs` parameter becomes: `Foreground wait in milliseconds: defaults to 10000, capped at 60000. On expiry the command moves to the background as a job instead of being killed.`

`bash` is changed only when the agent also has `job_output`, and only when its `bash` declares both `timeoutMs` and `run_in_background`. The `bash` of the Minimal preset (`@deepseek-ai/dsh-tool-bash-persistent`) and a `bash` without background jobs are left alone. DSH's own bash timeout settings are not touched: the agents the plugin does not change keep them, and a DSH limit below 60 seconds still applies.

### `job_output` cannot wait

The `wait` and `timeout_ms` parameters are removed from the tool. If a call still passes them, they are dropped and the call returns the job's current output at once.

### `wait_agent` is hidden

The agent does not see the tool and cannot call it.

### Two sentences of the system prompt are replaced

| DSH's sentence | Replacement |
| --- | --- |
| Before giving a final answer, collect every still-relevant job with job_output (set wait: true only when you are genuinely blocked on it), and job_kill jobs that stopped mattering. | When only waiting for a job remains, end your turn instead of sleeping or polling; its completion notice starts a new turn. Before giving a final answer, read every still-relevant job with job_output, and job_kill jobs that stopped mattering. |
| The root agent must wait for required teammates before giving the final answer. | The root agent gives the final answer only after the required teammates have reported; when only waiting for them remains, it ends its turn, and their reports start a new turn. |

The first sentence is in the prompt of every agent that has the job tools; the second only while Agent Teams is on. Nothing else in the prompt is changed.

## Closing idle subagents

DSH limits how many subagents can be loaded at a time under one top-level agent (8 by default). On a DSH that keeps a subagent loaded while a job it started is running, such a subagent keeps its slot after its turn has ended. A job that never ends, such as a development server, keeps that slot for good, and when every slot is taken, starting another subagent fails. `close_agent` lets an agent free a slot.

### The `close_agent` tool

The plugin adds the tool to an agent it changes when both are true:

- DSH's subagent service can close a subagent, which is the second addition named above.
- The agent has `list_agents`, which shows the names to pass.

The model sees this description: `Unload an idle subagent created under you, together with every subagent beneath it. This frees their slots toward the subagent limit and cancels the background jobs they started. Messages still queued for a closed subagent are discarded. It never interrupts a turn: when the subagent or one beneath it is working, nothing is closed and the error names it. A closed subagent keeps its conversation, and send_message starts it again.`

It takes one required parameter, `agent`: `The name of an agent created under you, as list_agents shows it: your direct child or a deeper descendant.`

The result has one line for each subagent that was closed:

| The closed subagent | Its line |
| --- | --- |
| had no running job | `closed builder` |
| had one running job | `closed builder; cancelled background job (bash: npm run dev)` |
| had several | `closed builder; cancelled 2 background jobs: (bash: npm run dev), (bash: npm test)` |
| had messages still queued | `closed builder; discarded 1 queued message`, or `discarded 3 queued messages` |

A job is shown by its kind and its label as DSH's own notices show it: the first line, with `…` when more lines follow, cut to 120 characters. The discarded messages come after the jobs when a line has both: `closed builder; cancelled background job (bash: npm run dev); discarded 1 queued message`. When nothing is loaded under the name, the result is `no loaded subagent named builder; nothing was closed`. When DSH refuses, for example because the subagent or one beneath it is working, nothing is closed and the call fails with DSH's message.

DSH also tells the direct parent of each closed subagent that it ended, as it does when a subagent ends on its own. When the close cancelled a job of the subagent, discarded a queued message, or closed a subagent beneath it, that notice reads `Background subagent builder was stopped before it finished.`

### The hint at the subagent limit

An agent that has `close_agent` is told about it when it needs it. When one of its tool calls fails because the subagent limit is reached (DSH's error code `ACTIVATION_LIMIT_REACHED`), the plugin adds a paragraph to the error the model reads: `Idle subagents you can close with close_agent to free a slot: builder, reviewer/checker. Closing one cancels the background jobs it started.`

It names the loaded subagents created under that agent, directly or through other loaded subagents, that are not running a turn and have no loaded subagent beneath them that is. At most 10 are named. When there is none, the error stays as DSH wrote it.

## When the changes apply

- To a top-level agent when it is created, which includes reopening an existing session, and to the top-level agents that are live when the plugin loads.
- To a subagent each time DSH loads it, before its first turn of that load: when it is started, and when a message loads it again after it was unloaded.
- Again when a session that has not started yet switches its agent preset, because the preset supplies the tools.

Each changed tool is a copy of the tool DSH gave that agent at that moment. If DSH replaces one of those tools while the session is open, for example when one of its own plugins is reloaded, the agent keeps the copy until its session is opened again or its preset changes. Whether the agent gets `close_agent` is decided at the same moment.

If the plugin cannot apply to an agent, that agent keeps DSH's tools and prompt, and the Host log gets a warning that starts with `could not apply to agent`.

## Turning it off

Open **Plugins**, find **Async agents** under **Installed**, and switch it off. When DSH applies the change without a restart, the changed agents get `wait_agent`, the original `job_output` and `bash`, and the original prompt back from their next step, and they lose `close_agent`. If DSH asks for a restart, the change applies after it. The plugin has no settings and stores nothing.

## Limits of this version

- **Not every subagent is changed.** On a DSH without the additions, and for the subagents that [Which agents are changed](#which-agents-are-changed) lists as kept, a subagent can still wait for its jobs and for its own subagents.
- **A command can be stopped after 10 to 60 seconds instead of moving to the background.** DSH cannot move a command to the background when the agent already runs as many jobs as DSH allows per agent (10 by default), or when its `bash` is configured with `promoteOnTimeout: false`. DSH then stops the command at its timeout, which for a changed agent is now 10 to 60 seconds instead of DSH's own setting.
- **A tool restriction does not hide what the plugin registered.** A tool that is hidden from an agent when the plugin applies is not copied, which covers a tool filter DSH gave a subagent. If another plugin restricts `bash` or `job_output` later, the agent still sees the copies; nothing in DSH or in the plugins of this repository does that. `close_agent` is the plugin's own tool: an agent that may use `list_agents` gets it even when its tool filter allows only named tools.
- **A mistyped name gets the answer of an unloaded subagent.** DSH takes a name without `/` that it does not find for a session id, so `close_agent` answers `no loaded subagent named …; nothing was closed` for both.
- **The hint can name a subagent that `close_agent` then refuses.** A turn can start between the two, and DSH also refuses a subagent that is still starting or has an external subagent beneath it, which the plugin cannot see. Nothing is closed then, and DSH's error says why.
- **The hint is added to the tool result only.** When DSH runs tools in PTC mode, where the model calls them from a `run_code` program, the program receives just the error message of a failed call, so the model does not see the hint.
- **The model decides when to end its turn.** The plugin removes the blocking calls and changes the instructions. It does not end a turn itself, so a model can still keep polling.
- **The sentences are matched exactly.** If a DSH release rewords one of them, that prompt section is left as DSH wrote it and the Host log gets one warning: `prompt section "tool:jobs" no longer contains the sentence this plugin rewrites; the section is left unchanged`. The tool changes still apply.

## Tests

```sh
npm test
```

`test/async-agents.test.mjs` runs the plugin against a stand-in for the parts of DSH it uses: scoped tool layers, effects owned by a context, the start of a subagent, the result policy of a tool call, and the prompt assembly. It needs no dependencies. It covers top-level agents and each kind of subagent, tools registered globally and in a preset, missing tools and `bash` variants, the argument handling of both tool copies, both prompt replacements and the warning, when `close_agent` is added, what it asks of DSH and every form of its result, the hint at the subagent limit, removal with a disposed agent, restoration when the plugin unloads, an agent the plugin cannot apply to, and re-application after a preset change.

```sh
npm run test:e2e
```

`test/e2e/run.mjs` boots a real DSH with the `web` profile in a temporary `DSH_HOME`, with this plugin and a scripted model linked into it and one subagent allowed at a time. It uses the installed Desktop runtime, the application bundle `DSH_APP` names, or the `dsh` executable `DSH_CLI` names. The scripted conversation delegates a subagent that starts a background command which never ends. The fixture reports whether that DSH can close a subagent, and the check follows from it:

- On a DSH with the additions, the subagent must have the four changes and stay loaded for its command. The next delegation must fail at the limit with the hint, `close_agent` must unload the subagent and stop the command, and the delegation must then succeed.
- On a DSH without them, such as 0.2.2-rc.3, the subagent must be as DSH made it, the top-level agent must have the four changes and no `close_agent`, and it must be told when the subagent has ended.

The check reads what the model was given in each request: its tools, its system prompt, the tool results, and the notices.
