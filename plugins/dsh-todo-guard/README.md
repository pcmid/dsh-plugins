# Todo progress guard

`@pcmid/dsh-todo-guard` keeps the agent's `todo_write` task list in step with its work. The list changes only when the model calls `todo_write`, so during a long tool-heavy turn it can keep showing the first item as in progress while the work moves on. This plugin reminds the model to update the list, and can optionally complete leftover items when a turn ends.

It is derived from [dsh-todo-progress-guard](https://github.com/LaochenFEIZHAI/dsh-todo-progress-guard) 1.0.2 by DoubleChess (MIT; see [LICENSE](LICENSE)).

## Behavior

### Mid-turn reminder

The plugin listens on `tools/post-execute`. While the current turn has a task list with unfinished items, it counts model steps and tool calls since the last `todo_write`. When either count reaches its threshold (`stepThreshold`, `callThreshold`), it attaches one notice to the step's tool results. The model reads it at the start of its next step:

```text
Todo list check: 0/3 completed, 3 step(s) and 3 tool call(s) since your last todo_write.
1. [in_progress] Read the notes
2. [pending] Summarize the notes
3. [pending] Report the summary
If this list no longer matches your progress, call todo_write with the complete updated list; the call can run in parallel with your next tool call. If it still matches, continue without calling todo_write. Before your final reply, mark every finished task completed.
```

The list is repeated verbatim because `todo_write` replaces the whole list. The notice is a `user/message` with `source: { kind: 'todo-guard', form: 'notice' }`. The conversation view shows it as a collapsed row whose summary reads like `Todo list 1/3 completed · <current item>`.

- At most one reminder per step; both counts restart after a reminder and after every `todo_write`.
- Calls made in the step that writes the list do not count, including calls made from `run_code` after a nested `todo_write`.
- No reminder when there is no list, when every item is completed, in a step that calls `ask_user_question` or `exit_plan_mode`, for calls made inside `run_code` (the outer call speaks for the step), or when a tool result concludes the turn, since a reminder would keep that turn running for another step.
- A new turn starts without a list, matching the task panel, which also clears at the start of a turn.

### Turn-end completion (off by default)

With `autoCompleteOnTurnEnd: true`, the plugin listens on `agent/turn-stopping`. When a turn is about to end normally, any items still pending or in progress are written back as `completed` in one final `todo/write`, inside the turn. Nothing is written when:

- the turn was aborted, the last reply was interrupted, or steering is already queued for another step;
- the last step with tool calls called `ask_user_question` or `exit_plan_mode`;
- every item is already completed;
- no other tool ran after the list was written and no item was completed: that list is a plan, not a result.

It is off by default because ending a turn does not mean the work is done. An agent that stops to report a failure or to ask a question in plain text would get its unfinished items marked completed.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `stepThreshold` | `5` | Remind after this many steps without a `todo_write` while the list has unfinished items. |
| `callThreshold` | `10` | Remind after this many tool calls without a `todo_write` while the list has unfinished items. |
| `autoCompleteOnTurnEnd` | `false` | Mark leftover items completed when a turn ends normally after real work. |

Thresholds must be integers of at least 1; other values fail when the plugin loads. Override fields in the profile's patch layer:

```yaml
- id: todo-guard
  config:
    stepThreshold: 3
    callThreshold: 8
```

The upstream plugin defaults to 2 steps and 5 calls, with turn-end completion on. These defaults remind less often, so one long task item does not draw a notice every other step.

## Model and cost effects

Each reminder is one user message of about 90 tokens plus one line per item, appended after the step's tool results. It is append-only, so the prompt cache prefix is kept. When the model already keeps its list current, no reminder is sent. Turn-end completion adds a `todo/write` event and no model-visible message.

## Known limitations

- Tracking state lives in memory and starts at the first event the plugin sees for a Session. A turn already running when the plugin loads gets reminders only after its next `todo_write`, and no turn-end completion.
- The plugin cannot tell whether an item is actually done; it only asks the model to check.
- Each agent (including subagents) has its own list and its own counts.

## Tests

`npm test` runs the offline tests. They resolve `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-llm` from `SCHEMASTERY_ENTRY` and `DSH_LLM_ENTRY` when set, otherwise from a built `deepseek-harness` source checkout next to this directory or next to its repository, otherwise from the devDependencies that `npm install` adds.

`npm run test:e2e` boots the installed Desktop runtime (or `DSH_CLI`) in a temporary `DSH_HOME`. A scripted model writes a list and works seven steps without updating it. The check asserts the reminders in the model's requests and the stored Session log, and the turn-end completion. Set `KEEP_E2E=1` to keep the temporary directory.
