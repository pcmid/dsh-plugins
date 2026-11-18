# Todo progress guard

`@pcmid/dsh-todo-guard` keeps the agent's `todo_write` task list in step with its work. The list changes only when the model calls `todo_write`, so during a long tool-heavy turn it can keep showing the first item as in progress while the work moves on. This plugin reminds the model to update the list when it writes a progress note between tool calls, and can optionally complete leftover items when a turn ends.

It is derived from [dsh-todo-progress-guard](https://github.com/LaochenFEIZHAI/dsh-todo-progress-guard) 1.0.2 by DoubleChess (MIT; see [LICENSE](LICENSE)).

## Behavior

### Mid-turn reminder

The plugin listens on `tools/post-execute`. When the model moves from one piece of work to the next, it often writes a short note in the same message as its tool calls, such as "Now the backend test.". When a step's assistant message carries such text (a `text` block with more than whitespace; reasoning does not count) and the current turn has a task list with unfinished items, the plugin attaches one notice to that step's tool results. The text and the calls are one message, so the step's results are the earliest place after the text. The model reads the notice at the start of its next step:

```text
Todo list check: 0/3 completed, 3 step(s) and 3 tool call(s) since your last todo_write.
1. [in_progress] Read the notes
2. [pending] Summarize the notes
3. [pending] Report the summary
If this list no longer matches your progress, call todo_write with the complete updated list; the call can run in parallel with your next tool call. If it still matches, continue without calling todo_write. Before your final reply, mark every finished task completed.
```

The list is repeated verbatim because `todo_write` replaces the whole list. The notice is a `user/message` with `source: { kind: 'todo-guard', form: 'notice' }`. The conversation view shows it as a collapsed row whose summary reads like `Todo list 1/3 completed · <current item>`.

- At most one reminder per step. The counts in the first line are tool steps and tool calls since the last `todo_write`; they only inform the model and do not trigger anything. Calls made in the step that writes the list do not count, including calls made from `run_code` after a nested `todo_write`.
- No reminder in a step without text, so a model that never writes notes between tool calls never gets one.
- No reminder when there is no list, when every item is completed, in a step that writes the list (directly or from `run_code`), in a step that calls `ask_user_question` or `exit_plan_mode`, for calls made inside `run_code` (the outer call speaks for the step), or when a tool result concludes the turn, since a reminder would keep that turn running for another step.
- A new turn starts without a list, matching the task panel, which also clears at the start of a turn.

### Turn-end completion (off by default)

With `autoCompleteOnTurnEnd: true`, the plugin listens on `agent/turn-stopping`. When a turn is about to end normally, any items still pending or in progress are written back as `completed` in one final `todo/write`, inside the turn. Nothing is written when:

- the turn was aborted, the last reply was interrupted, or steering is already queued for another step;
- the last step with tool calls called `ask_user_question` or `exit_plan_mode`;
- every item is already completed;
- no other tool ran after the list was written and no item was completed: that list is a plan, not a result.

It is off by default because ending a turn does not mean the work is done. An agent that stops to report a failure or to ask a question in plain text would get its unfinished items marked completed.

## Configuration

Open **Plugins → Todo progress guard**. The plugin's page shows a settings form below its description, built from the same staged-form components as the official plugin cards: edits stay drafts until **Save**, and a changed field shows an "Overridden" badge with a reset to its default. The form appears only while the Host serves the `todo-guard` entry.

| Field | Default | Meaning |
| --- | --- | --- |
| `autoCompleteOnTurnEnd` | `false` | Mark leftover items completed when a turn ends normally after real work. |

The field is volatile: the form writes it to the profile's patch layer, and the running plugin reads the new value at its next decision, without a reload and without losing a turn's tracking state. Editing the profile's patch layer by hand works as well:

```yaml
- id: todo-guard
  name: '@pcmid/dsh-todo-guard'
  config:
    autoCompleteOnTurnEnd: true
```

A value set in a higher layer (the home patch or a command-line `--patch` overlay) cannot be changed from the form; the form refuses that save.

The plugin's page shows [docs/zh.md](docs/zh.md) or [docs/en.md](docs/en.md) through `meta.detail` in the locale files, so the form is not pushed below this README.

Versions before 0.2.0 reminded after `stepThreshold` steps or `callThreshold` tool calls without a `todo_write`. Those counts fired in the middle of a piece of work; a progress note marks the point where the model moves on, which is when the list most likely needs an update. The two fields are gone, and values left in a patch layer are ignored. The upstream plugin counts steps and calls as well, with turn-end completion on.

## Model and cost effects

Each reminder is one user message of about 90 tokens plus one line per item, appended after the step's tool results. It is append-only, so the prompt cache prefix is kept. How often it fires depends on how often the model writes notes between tool calls; in recent Desktop sessions that was a few percent of tool steps. Turn-end completion adds a `todo/write` event and no model-visible message.

## Known limitations

- Tracking state lives in memory and starts at the first event the plugin sees for a Session. A turn already running when the plugin loads gets reminders only after its next `todo_write`, and no turn-end completion.
- The plugin cannot tell whether an item is actually done; it only asks the model to check.
- Each agent (including subagents) has its own list and its own counts.

## Tests

`npm test` runs the offline tests:

- `test/guard.test.mjs` covers the Host plugin. It resolves `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-llm` from `SCHEMASTERY_ENTRY` and `DSH_LLM_ENTRY` when set, otherwise from a built `deepseek-harness` source checkout next to this directory or next to its repository, otherwise from the devDependencies that `npm install` adds.
- `test/client.test.mjs` renders the settings form of `client.js` with the real React and `@deepseek-ai/dsh-client-ui-primitives` of a built checkout (or `UI_PRIMITIVES_DIR`), and checks the staged edit, the write a save sends, the reset, and the read-only state. Without a checkout it is skipped, as in CI.

`npm run test:e2e` boots the installed Desktop runtime (or `DSH_CLI`) in a temporary `DSH_HOME`. The fixture writes the guard's setting through the Settings service, the path the form takes. A scripted model writes a list and works seven steps without updating it; two of those steps write a progress note before their tool call, one only reasons, and one writes whitespace. The fixture switches `autoCompleteOnTurnEnd` on mid-turn. The check asserts that the model's requests carry reminders after the two noted steps only, then checks the stored Session log, the turn-end completion, and the saved value in the profile patch. Set `KEEP_E2E=1` to keep the temporary directory.
