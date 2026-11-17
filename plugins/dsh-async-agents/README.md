# Async agents

`@pcmid/dsh-async-agents` keeps the main agent of a session from blocking on background work. A long shell command continues as a background job, the agent can no longer wait on a job or on a subagent, and it is told to end its turn instead. DSH then starts the agent's next turn when the job or the subagent reports.

This version changes top-level agents only: agents whose session is not a subagent (`session.header.origin !== 'subagent'`). Subagents keep every tool and every instruction exactly as DSH defines them.

## What changes for a top-level agent

### `bash` waits 10 seconds, 60 at most

- A foreground call without `timeoutMs` waits 10 seconds. A call may ask for a longer wait with `timeoutMs`; values above 60000 are cut to 60000. Smaller values are used as given.
- When the wait runs out, DSH moves the command to a background job, as it already does at its own timeout. The tool result names the job, and the command keeps running.
- Calls with `run_in_background: true` are not changed. A `timeoutMs` that is not a positive number is passed on, and DSH rejects it as before.
- The description of the `timeoutMs` parameter becomes: `Foreground wait in milliseconds: defaults to 10000, capped at 60000. On expiry the command moves to the background as a job instead of being killed.`

`bash` is changed only when the agent also has `job_output`, and only when its `bash` declares both `timeoutMs` and `run_in_background`. The `bash` of the Minimal preset (`@deepseek-ai/dsh-tool-bash-persistent`) and a `bash` without background jobs are left alone. DSH's own bash timeout settings are not touched: subagents keep them, and a DSH limit below 60 seconds still applies.

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

## When the changes apply

- When an agent is created, which includes reopening an existing session, and to the agents that are live when the plugin loads.
- Again when a session that has not started yet switches its agent preset, because the preset supplies the tools.

Each changed tool is a copy of the tool DSH gave that agent at that moment. If DSH replaces one of those tools while the session is open, for example when one of its own plugins is reloaded, the agent keeps the copy until its session is opened again or its preset changes.

## Turning it off

Open **Plugins**, find **Async agents** under **Installed**, and switch it off. When DSH applies the change without a restart, open sessions get `wait_agent`, the original `job_output` and `bash`, and the original prompt back from their next step. If DSH asks for a restart, the change applies after it. The plugin has no settings and stores nothing.

## Limits of this version

- **Top-level agents only.** Subagents can still wait for their jobs and for their own subagents.
- **A command can be stopped after 10 to 60 seconds instead of moving to the background.** DSH cannot move a command to the background when the agent already runs as many jobs as DSH allows per agent (10 by default), or when its `bash` is configured with `promoteOnTimeout: false`. DSH then stops the command at its timeout, which for a top-level agent is now 10 to 60 seconds instead of DSH's own setting.
- **The model decides when to end its turn.** The plugin removes the blocking calls and changes the instructions. It does not end a turn itself, so a model can still keep polling.
- **The sentences are matched exactly.** If a DSH release rewords one of them, that prompt section is left as DSH wrote it and the Host log gets one warning: `prompt section "tool:jobs" no longer contains the sentence this plugin rewrites; the section is left unchanged`. The tool changes still apply.

## Tests

```sh
npm test
```

`test/async-agents.test.mjs` runs the plugin against a stand-in for the parts of DSH it uses: scoped tool layers, effects owned by a context, and the prompt assembly. It needs no dependencies. It covers top-level agents and subagents, tools registered globally and in a preset, missing tools and `bash` variants, the argument handling of both tool copies, both prompt replacements and the warning, removal with a disposed agent, restoration when the plugin unloads, and re-application after a preset change.
