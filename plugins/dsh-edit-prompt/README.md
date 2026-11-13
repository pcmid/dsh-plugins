# @pcmid/dsh-edit-prompt

Adds an **edit** button beside the copy button of every message you sent in the Chat view. Edit opens an inline editor with **Cancel** and **Send**; sending drops that turn and everything after it, puts back the files those turns changed, and restarts the conversation from the edited prompt.

## Behavior

- Hover a message you sent: the action row shows the time, **Copy**, and **Edit**.
- **Edit** replaces the bubble with an editor holding the original text. `⌘/Ctrl+Enter` sends, `Esc` cancels.
- **Send**:
  1. stops the original conversation (its turn and its running subagents) and rewinds the files its dropped turns changed, as described in [File rewind](#file-rewind);
  2. forks the conversation at the event just before the edited message's turn starts, so the fork contains nothing from that turn on;
  3. removes any input the fork inherited as still queued (for example the edited message itself, when it had been queued behind a running turn);
  4. sends the edited text, plus the images of the original message, to the fork. It goes through the same local echo as the composer, so the message shows in the fork right away, even while the Host is still preparing the turn (for example while a memory plugin looks things up on the fork's first prompt);
  5. opens the fork and, by default, moves the original conversation to the archive.

  The fork keeps the original title, agent preset, and workspace, so the conversation appears to restart in place. The original log is never modified: restore it from the archive if you want it back. When a step after the file rewind fails, the file rewind is undone, so the files match the stopped original again.
- Images are read back and sent again. File attachments cannot be resent and are dropped; the editor says so when the message has any.
- Only turn-opening messages get the button. Messages sent while a turn was running (steering) sit inside a turn, so they keep the built-in renderer without an edit action.
- The button appears only where the Session allows forking (the same permission as the built-in branch action).

## File rewind

Every turn of a top-level conversation that ran tools is recorded, and rewinding is part of every resend; there is no switch to skip it.

- **What is recorded.** When the conversation's working directory lies in a git repository, the working tree is snapshotted at turn start and turn end, so every change inside the repository is caught, including those made by shell commands, scripts, and subagents. Ignored files, files in nested repositories, files outside the repository, and every file when there is no repository or no git are covered by a copy taken just before a file tool (`write`, `edit`, `apply_patch`, `str_replace_editor`) first changes them in the turn; changes there made only by shell commands are not seen. Files under `/tmp` and the system temp directory are left out unless they lie in the workspace. Edits made by subagents count toward the turn of their root conversation.
- **What a resend restores.** Each file a dropped turn changed goes back to its content before the earliest dropped turn that changed it; a file those turns created is deleted. A fork rewinds the turns it inherited as well as its own, never the turns of a branch it does not contain.
- **Confirmation.** A file that changed after the dropped turns last touched it (by you, another conversation, or a program), a file whose earlier content was larger than `maxFileBytes`, and a path that is now a directory are listed in the editor, and nothing is rewound yet. **Send anyway** rewinds everything else and overwrites the changed files; the other listed files stay as they are. The original conversation has already been stopped at that point.
- **Undo.** Everything a rewind overwrites is stored first. The journal of each rewind lives in `restores/` (see below); a failed restart undoes its own rewind through it.

Records live in `<DSH_HOME>/edit-prompt/`: `turns/` holds one JSON record per recorded turn, `blobs/` the earlier file contents named by their SHA-1, and `restores/` one journal per rewind. Records and journals older than `retentionDays` are removed once a day, together with the copies nothing else refers to. Git snapshots are written to a private object directory under the system temp directory with the repository's objects attached read-only, so the repository's index, objects, refs, and work tree are not touched; that directory is removed when the conversation is unloaded.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `archiveSource` | `true` | Archive the original conversation after resending. When `false`, the original stays in the list (stopped) and the fork title gets a number, like the built-in branch action. |
| `maxFileBytes` | `16777216` | Largest file, in bytes, whose earlier content is kept. A larger file changed by a dropped turn cannot be rewound and is listed for confirmation. |
| `retentionDays` | `30` | Days a turn record is kept. Editing a message whose turns are older does not rewind their files. |
| `gitTimeoutMs` | `60000` | Milliseconds one git command may run while a turn is recorded. A slower snapshot loses that turn's shell changes; file-tool edits are still recorded. |

`archiveSource` is volatile: change it on the plugin's page in Settings → Plugins, or override the `edit-prompt` row in the profile's `cordis.patch.yml`:

```yaml
- override:
    - id: edit-prompt
      config:
        archiveSource: false
```

## How it is built

Session logs are append-only, so "dropping" later messages means continuing in a fork.

The Host half (`index.js`, `host/`) keeps one recorder per top-level conversation. `turn/start` queues a snapshot: `git add --all` into a private index seeded from the repository's index, then `write-tree`, with `GIT_OBJECT_DIRECTORY` pointing at the private object directory and `GIT_ALTERNATE_OBJECT_DIRECTORIES` at the repository's objects. `tools/pre-execute` waits for the queue, so no tool runs before its turn's snapshot. Prepended `fs/write-intent`, `fs/edit-intent`, and `fs/delete-intent` listeners delegate the guard decision, then copy the resolved target before the mutation. `turn/end` takes the second snapshot, lists the changed paths with `diff-tree`, checks their earlier contents out of the first snapshot (`checkout-index`, so filters and line endings match a checkout), and writes the turn record. A record is keyed by the time of the conversation's first event and the position and time of the turn's `turn/start`, which a fork copies unchanged; a rewind reads the conversation's own log to find the records it contains.

The Host serves two Connection RPC routes, reachable only by owner Peers:

- `POST /api/pcmid/edit-prompt/rewind` `{ sessionId, fromSeq, force? }`: cancels the conversation's turn and its running subagents, waits until they are idle and the last turn record is written, then restores. Answers `{ status: 'attention', files: [{ path, reason }] }` (nothing written; `reason` is `modified`, `oversized`, or `unsupported`) or `{ status: 'restored', restoreId?, files, skipped }`.
- `POST /api/pcmid/edit-prompt/undo` `{ restoreId }`: puts back what that rewind overwrote, for every path that still holds what the rewind wrote. Answers `{ files, skipped }`.

The Web client registers a renderer for the keyed `conversation.chat.node` cell `user` at priority `-10`, which shadows ui-chat's own user-message renderer (priority `0`). It renders the same bubble through the shared `conversation.chat.user.content` Factory and recreates the time and copy actions, then adds edit. If the renderer throws, the slot retires it and the built-in renderer returns. The resend calls the rewind route, then uses existing Session Remote methods (`fork`, `projections`, `updateQueue`, `attachment`), the client Session's submission echo (`beginSubmission`, `prompt`), and the Workspace service (`openSession`, `archiveSession`).

## Known limitations

- Only turns recorded while this version runs can be rewound; conversations from before it, and turns cut off by a Host crash, rewind nothing.
- Outside snapshot coverage, a file changed only by a shell command is not rewound, and a file a shell command changed earlier in the same turn is rewound to its content at the file tool's first edit.
- Background jobs of the original conversation keep running until it is archived, which happens right after the fork opens; with `archiveSource` off they keep running.
- Changes you make while a turn runs are attributed to that turn, and a turn of another conversation in the same repository at the same time is attributed to both.
- A subagent still running after its root conversation's turn ended belongs to no turn, so its later file-tool edits outside the repository are not recorded; inside the repository they land between turns and are not rewound either.
- Rewinding happens on the Host's own disk: a conversation whose files live on a remote execution backend is not supported.
- The `conversation.chat.user.before` decoration seat belongs to the shadowed built-in renderer, so it is not rendered while this plugin is active. Nothing occupies it in the current release.
- A turn that claimed several queued messages at once is restarted with the edited message only.
- Forked conversations carry the original thinking blocks. Providers that bind thinking to a conversation (Anthropic Messages) may reject them; `@pcmid/dsh-retry-advisor` with `dropInvalidThinking` handles that case.

## Tests

```sh
npm install --no-save --no-package-lock && npm test
```

The Host tests record real turns in temporary git repositories and need `git` on `PATH`. The rendering tests use React from a built deepseek-harness checkout beside this repository (or `REACT_DIR`), and are skipped without one.
