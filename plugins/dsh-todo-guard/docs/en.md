The agent's `todo_write` task list changes only when the agent calls that tool again. During a long run of tool calls it often forgets, and the task panel stays on the first item.

When the agent finishes one piece of work and moves to the next, it often writes a short note before its tool calls, such as "Now the backend test.". While the list has unfinished items, this plugin then sends the agent a reminder after that step's tool results, repeating the whole current list. When the list is still accurate, the agent can ignore the reminder and keep working. The note and the tool calls are one message, so the step's tool results are the earliest place for the reminder.

## Settings

Change them below. A saved change applies at once, without a restart.

- **Complete leftover tasks at turn end** (default off): when a turn ends normally, mark the remaining tasks completed. If the agent stops to report a failure or ask a question, its unfinished tasks are marked completed too, which is why it is off by default.

## When it does not remind

- The step has tool calls but no note (reasoning does not count as a note). An agent that never writes notes never gets a reminder.
- The current turn has no task list yet, or every item is completed. A new turn starts without a list.
- The step just updated the list, or called a tool that asks the user.
- The plugin loaded while a turn was running: reminders start after the agent's next list update.

The reminder is written in English for the model. The conversation shows it as a collapsed notice whose summary reads like "Todo list 1/3 completed · current task".

This plugin is derived from [dsh-todo-progress-guard](https://github.com/LaochenFEIZHAI/dsh-todo-progress-guard) (MIT).
