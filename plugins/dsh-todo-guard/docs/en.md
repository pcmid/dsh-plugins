The agent's `todo_write` task list changes only when the agent calls that tool again. During a long run of tool calls it often forgets, and the task panel stays on the first item.

While the list has unfinished items and the agent has gone several steps without updating it, this plugin sends the agent a reminder that repeats the whole current list. When the list is still accurate, the agent can ignore the reminder and keep working.

## Settings

Change them below. A saved change applies at once, without a restart.

- **Steps before a reminder** (default 5) and **Tool calls before a reminder** (default 10): whichever is reached first triggers a reminder. At most one reminder per step; both counts restart after it.
- **Complete leftover tasks at turn end** (default off): when a turn ends normally, mark the remaining tasks completed. If the agent stops to report a failure or ask a question, its unfinished tasks are marked completed too, which is why it is off by default.

## When it does not remind

- The current turn has no task list yet, or every item is completed. A new turn starts without a list.
- The step just updated the list, or called a tool that asks the user.
- The plugin loaded while a turn was running: counting starts after the agent's next list update.

The reminder is written in English for the model. The conversation shows it as a collapsed notice whose summary reads like "Todo list 1/3 completed · current task".

This plugin is derived from [dsh-todo-progress-guard](https://github.com/LaochenFEIZHAI/dsh-todo-progress-guard) (MIT).
