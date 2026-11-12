# @pcmid/dsh-edit-prompt

Adds an **edit** button beside the copy button of every message you sent in the Chat view. Edit opens an inline editor with **Cancel** and **Send**; sending drops that turn and everything after it and restarts the conversation from the edited prompt.

## Behavior

- Hover a message you sent: the action row shows the time, **Copy**, and **Edit**.
- **Edit** replaces the bubble with an editor holding the original text. `⌘/Ctrl+Enter` sends, `Esc` cancels.
- **Send**:
  1. forks the conversation at the event just before the edited message's turn starts, so the fork contains nothing from that turn on;
  2. removes any input the fork inherited as still queued (for example the edited message itself, when it had been queued behind a running turn);
  3. sends the edited text, plus the images of the original message, to the fork;
  4. opens the fork and, by default, moves the original conversation to the archive (stopping it first when it is running).

  The fork keeps the original title, agent preset, and workspace, so the conversation appears to restart in place. The original log is never modified: restore it from the archive if you want it back.
- Images are read back and sent again. File attachments cannot be resent and are dropped; the editor says so when the message has any.
- Only turn-opening messages get the button. Messages sent while a turn was running (steering) sit inside a turn, so they keep the built-in renderer without an edit action.
- The button appears only where the Session allows forking (the same permission as the built-in branch action).

## Settings

| Field | Default | Meaning |
|---|---|---|
| `archiveSource` | `true` | Archive the original conversation after resending. When `false`, the original stays in the list and the fork title gets a number, like the built-in branch action. |

The field is volatile: change it on the plugin's page in Settings → Plugins, or override the `edit-prompt` row in the profile's `cordis.patch.yml`:

```yaml
- override:
    - id: edit-prompt
      config:
        archiveSource: false
```

## How it is built

Session logs are append-only, so "dropping" later messages means continuing in a fork. The Host row only serves the setting; everything else runs in the Web client on existing Session Remote methods (`fork`, `projections`, `updateQueue`, `attachment`, `prompt`) and the Workspace service (`openSession`, `archiveSession`).

The client registers a renderer for the keyed `conversation.chat.node` cell `user` at priority `-10`, which shadows ui-chat's own user-message renderer (priority `0`). It renders the same bubble through the shared `conversation.chat.user.content` Factory and recreates the time and copy actions, then adds edit. If the renderer throws, the slot retires it and the built-in renderer returns.

## Known limitations

- The `conversation.chat.user.before` decoration seat belongs to the shadowed built-in renderer, so it is not rendered while this plugin is active. Nothing occupies it in the current release.
- A turn that claimed several queued messages at once is restarted with the edited message only.
- Forked conversations carry the original thinking blocks. Providers that bind thinking to a conversation (Anthropic Messages) may reject them; `@pcmid/dsh-retry-advisor` with `dropInvalidThinking` handles that case.

## Tests

```sh
npm test
```

The rendering tests use React from a built deepseek-harness checkout beside this repository (or `REACT_DIR`), and are skipped without one.
