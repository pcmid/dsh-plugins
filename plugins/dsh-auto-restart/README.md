# Auto restart

`@pcmid/dsh-auto-restart` continues conversations whose agent was cut off because the Harness quit, restarted, or crashed. After the next startup each such conversation receives one notice that wakes it, and the agent picks up the task where it stopped.

## Behavior

**While the Harness runs**, a `session/event` listener keeps a candidate list in `<DSH_HOME>/auto-restart/<profile>.json`:

- A root conversation joins the list when a turn starts and leaves it when a turn ends on its own (completed, failed, stopped by you).
- A subagent's running turn records the subagent under its root conversation, so a lead that ended its own turn and waits for subagent results is covered too.
- A turn cut off by teardown (`aborted` with cause `disposed` or `parent`) keeps its entry; a crash keeps it because nothing runs. Nothing is written at exit.

**After the next successful startup** (plus `startDelaySeconds`), every candidate is judged from its own Session log, which stays authoritative over the list:

1. Archived, deleted, and subagent-owned Sessions are dropped.
2. The last turn must have been cut off (`interrupted` after a crash, or `aborted` by teardown when `afterShutdown` is on) in an earlier process and less than `maxAgeHours` ago. Alternatively, with `includeSubagents`, a recorded subagent must have been cut off after the root's own last turn ended.
3. The automatic continuations since the last message a person sent (a typed prompt or the Continue button) must stay below `maxAttempts`; this bounds restart loops.
4. The conversation is resumed through the Web Session controller, so its preset, model, permissions, and working directory come from its log. If something else already ran a turn in it, it is left alone.
5. One next-turn notice is queued and flushed, which wakes the agent. A notice from an earlier attempt that never started its turn is replaced, not duplicated.
6. With `rearmGoals`, an active goal that the restart disarmed is rearmed, so its rounds continue after the notice turn. A goal whose round budget is spent stays as it is.

Only the list is read at startup; the logs of the listed conversations are read once to judge them, independent of how many conversations are stored.

## What the model sees

One user-role message with source `{ kind: 'auto-restart', attempt, form: 'notice', summary }`. Its text says whether the Harness crashed, was shut down, or stopped subagents, and asks the agent to continue. It also says that background jobs, terminals, and subagents from before the restart no longer run, that tool calls with an unknown outcome need their external state checked before being repeated, and that a finished task only needs a brief reply. From the second consecutive attempt on, it adds that the previous continuation was cut off too. Chat shows it as a notice row with the summary.

The Harness itself closes tool calls left open by a crash with an error result that tells the model not to retry blindly; the notice does not repeat their details.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `afterShutdown` | `true` | Also continue turns cut off by an orderly quit or restart. `false` continues only crashes and forced kills. |
| `includeSubagents` | `true` | Also wake a conversation whose own turn had ended while its subagents still ran. |
| `maxAgeHours` | `24` | Continue only interruptions younger than this at startup. |
| `maxAttempts` | `3` | Automatic continuations per conversation since the last human message. |
| `rearmGoals` | `true` | Rearm an active goal after continuing. |
| `startDelaySeconds` | `5` | Wait after startup before continuing, so late providers and MCP servers can connect. |
| `concurrency` | `2` | Conversations resumed at the same time. |

Override fields in the profile's patch layer, for example to continue only after crashes:

```yaml
- id: auto-restart
  config:
    afterShutdown: false
```

## Model and cost effects

Each continued conversation gets one short notice (about 150–250 tokens) and runs at least one more turn on its own model, which re-sends the conversation and is billed like any turn. That happens without you watching; `maxAgeHours`, `maxAttempts`, and `afterShutdown` bound it. Conversations that are not continued cost nothing.

## Known limitations

- An orderly quit discards messages queued behind the running turn (the log records only how many). They are not restored; after a crash they are still queued and run with the continuation.
- Background jobs, terminals, and subagents are not restarted; the notice asks the agent to check and restart what it still needs.
- Whether a cut-off tool call with side effects ran is unknown; the plugin relies on the model following the Harness's "outcome unknown" guidance.
- A conversation stopped inside one process run (for example by reloading a plugin) is not continued; only interruptions from an earlier process count.
- A subagent that its lead interrupts records the same teardown cause as a shutdown. It is ignored once the lead's turn has ended after it, which is the normal case.
- Two Harness processes using the same profile and `DSH_HOME` at the same time share one candidate file and can overwrite each other's entries.

## Tests

`npm test` runs the offline tests. They resolve `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-llm` from `SCHEMASTERY_ENTRY` and `DSH_LLM_ENTRY` when set, otherwise from a built `deepseek-harness` checkout next to this directory or next to its repository.

`npm run test:e2e` boots the installed Desktop runtime (or `DSH_CLI`) with the `web` profile in a temporary `DSH_HOME`, links this plugin and a scripted-model fixture into it, and checks five cases end to end: an orderly quit, a `SIGKILL`, a restart loop that stops after `maxAttempts`, a lead waiting for a cut-off subagent, and a rearmed goal whose round runs after the notice. It does not touch your own profile.
