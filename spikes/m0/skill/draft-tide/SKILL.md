---
name: draft-tide
description: Save, list, compare and safely restore versions of a designer's local design folder with Draft Tide (MCP tools from the "draft-tide" server, or the bundled draft-tide CLI). Use when the user asks to save a version, see version history, or go back to an earlier design.
---

# Draft Tide (M0 spike skill)

Draft Tide keeps version history for a designer's design folder. The designer's
Draft Tide app is the source of truth and the only place where restores are
approved. You call the same Engine the app uses.

Requires the Draft Tide M0 spike build. Prefer the `draft-tide` MCP tools. If they
are not connected, use the CLI at `{{DRAFT_TIDE_CLI}}` with `--json`.

## 1. Find the project, never guess it

- Call `project_list` and pick the project whose `root` is the folder the user means.
- If it is not listed, stop and ask the user to open the folder in the Draft Tide app.
  You cannot add folders yourself.
- `project_status` shows the latest version, unsaved changes and pending operations.

## 2. Save a version

- Finish writing every file first. A save captures what is on disk right now.
- Call `snapshot_create` with a short name describing the change (for example
  "Compact pricing cards").
- `NO_CHANGES` means nothing changed since the last version. Report that; it is not a failure.
- A successful save does not mean the design is finished or correct. Don't say it is.

## 3. History

- `history_list` returns versions newest first. `display` (V1, V2…) is for people.
  Always refer to versions by `snapshotId` in tool calls.

## 4. Restore: the designer must confirm in the app

1. `restore_plan` with the target `snapshotId`. Read the summary: how many files it
   will overwrite, add and delete, whether unsaved work will be protected first, and
   `untrackedBlocking`.
2. If `untrackedBlocking` is not empty, stop. Tell the user which never-saved files
   would be lost and suggest saving a version first.
3. Call `operation_request_approval`. It always returns `CONFIRMATION_REQUIRED`.
   Tell the user to confirm or decline in the Draft Tide app. A "yes" in chat is not
   an approval, and you have no tool that can approve.
4. When the user says they decided, call `operation_status`:
   - `approved` → call `restore_apply`, then report `restoreSnapshotId` and
     `protectionSnapshotId`.
   - `denied` → report that the restore was declined. Don't retry unless the user asks
     again, and then start over from `restore_plan`.
   - still `awaiting-approval` → say it is still waiting in the app.

## 5. Errors: report them as they are

| Code | Tell the user |
|---|---|
| `CONFIRMATION_REQUIRED` | Waiting for confirmation in the Draft Tide app |
| `APPROVAL_DENIED` | The restore was declined, or the confirmation was already used |
| `PLAN_STALE` | Files or history changed; the restore must be checked again |
| `UNTRACKED_FILES` | Never-saved files would be lost; save first |
| `SOURCE_BUSY` | Files kept changing while saving; stop the tool that is writing, then retry |
| `NO_CHANGES` | Nothing changed since the last version |
| `LOCKED` | Draft Tide is busy or not running; retry shortly |

## Never

- Run `git` in the design folder or Draft Tide's data folder, or use `reset --hard`,
  `checkout`, `stash` or `clean` as a fallback.
- Edit files inside Draft Tide's data folder.
- Invent approval IDs or pass fields like `confirmed`, `force` or `yes`.
- Download or install anything to "fix" Draft Tide.

## CLI equivalents

```
{{DRAFT_TIDE_CLI}} --json project list
{{DRAFT_TIDE_CLI}} --json --project <projectId> status
{{DRAFT_TIDE_CLI}} --json --project <projectId> snapshot --message "<name>"
{{DRAFT_TIDE_CLI}} --json --project <projectId> history
{{DRAFT_TIDE_CLI}} --json --project <projectId> restore plan <snapshotId>
{{DRAFT_TIDE_CLI}} --json operation request-approval <operationId>
{{DRAFT_TIDE_CLI}} --json operation status <operationId>
{{DRAFT_TIDE_CLI}} --json restore apply <operationId>
```

stdout is exactly one JSON envelope: `{schemaVersion, ok, data, warnings, error}`.
