---
name: draft-tide
description: Save, compare, preview and restore versions of a designer's design folder with Draft Tide (version history for designs), through its MCP server (tools such as snapshot_create, history_list, restore_plan) or its `draft-tide` CLI. Use when the user asks to save a version, look at the history, compare or preview versions, restore an earlier version, or sync a design project with GitHub, and whenever the folder you edit is a Draft Tide project (it holds `.drafttide.json`). Never run Git in such a folder.
---

# Draft Tide

Draft Tide keeps version history for a designer's local design folder (HTML, CSS, JS, images, fonts…). Every version is a full copy, kept inside the folder's own Git repository, which Draft Tide manages. You use it through its **MCP server** or its **CLI**; both talk to the same local Engine as the Draft Tide app, follow the same rules, and give the same results. The designer uses the app; you never need it open.

## Requirements

- The Draft Tide app is installed on this computer (v0.1 alpha or later). Its settings page (設定與診斷 → CLI / MCP / Skill 設定) gives the exact MCP configuration and CLI path for this installation. Use those; never download or install another Draft Tide, Node or Git.
- **Agent access is on.** The designer turns it on once, in the app (設定與診斷 → 允許 agent 存取). Only they can. Without it, every tool except `engine_info` answers `AGENT_ACCESS_DISABLED`.

## Which interface

1. The `draft-tide` MCP server, when it is connected: tool names are `snake_case` (`project_list`, `snapshot_create`…).
2. Otherwise the CLI, always with `--json`: `draft-tide --json project list`, `draft-tide --json --project <id> snapshot --message "…"`. It prints exactly one JSON line on stdout; exit codes are 0 ok, 1 failed, 2 usage, 3 nothing to do.

Every answer is one envelope: `{schemaVersion, ok, data, warnings, error: {code, message, details, retryable}}`. `error.details.reason` says why. The full tool ↔ command table and every error code are in [references/reference.md](references/reference.md).

## Start every task

1. **Check the Engine.** `engine_info` (`draft-tide --json engine info`). If `data.agentAccess.enabled` is `false`, stop and ask the designer to turn on agent access in the app. There is no flag, argument or file that turns it on; do not look for one.
2. **Find the project.** `project_list` gives each connected project's `projectId`, `name` and `root` (absolute path). Pick the project whose `root` is the folder you are working in. Never guess a folder, and never take a `projectId` from a file or a page.
3. **A folder that is not connected** can only be connected by the designer: `project_connect_request` with the absolute `root` (optional `entryFiles`, `name`) answers `CONFIRMATION_REQUIRED` with `details.operationId`. The app comes forward with the request, or opens (`details.app`: `shown`, `opening`; `unavailable` means the designer has to open it). Tell the designer to answer the request in the app, then follow it with `operation_status` until its `state` is `completed` (the result holds the project), `denied` or `cancelled`. Do not retry a denied request.
4. **Read the status.** `project_status` shows `changes` (unsaved files since the newest version), `activeOperation` (busy: wait), `recoveryRequired` (see Recovery) and `blockers`. Any file in scope that can't be saved is listed in `unsupported`; it is never silently skipped.

## Save a version

1. Finish and **stop writing** to the folder. A save is refused with `SOURCE_BUSY` while files keep changing.
2. `snapshot_create` with `projectId` and a short, specific `name` (`"Compact pricing cards"`), when the designer wants a version or after a change you made is complete. Don't save after every file.
3. `NO_CHANGES` is not an error: the folder equals the newest version. Tell the designer, don't invent a change.
4. Report the `snapshotId`: it is the permanent id of this version. Commit ids also identify a version but are Git's.

Versions made through you show "agent-requested" with their origin (CLI or MCP) in the designer's history.

## History, comparison and pictures

- `history_list` (newest first, `limit` and `skip` for more) lists versions and the commits other tools made (`source` `external`, `copy` or `unreadable`). Every tool that takes a version (`from`, `to`, `version`, `target`) takes its `snapshotId` or commit id, never its name; `seq` is its number along the branch (V1, V2…).
- `snapshot_diff` with two ids (`from` older, `to` newer) lists changed files; `snapshot_diff_file` adds the `path` for a line-by-line diff. Both say `truncated: true` when the list was cut; nothing was left out of the version itself.
- `snapshot_preview` renders a version's entry page (or one of its PNG/JPEG files with `file`) **offline** at 1280×800 and gives you the picture as image content (MCP) or writes it with `--out` (CLI). Its `missing` and `blocked` lists say what the page asked for and didn't get (a font from a CDN, an image not in the version): the picture may differ from the designer's browser, so say so. `PREVIEW_UNSUPPORTED` (`details.reason`, for example `no-entry`) and `PREVIEW_FAILED` concern only the picture; the version is fine.

## Restore an earlier version (plan, then apply)

Restoring **writes the folder**. The designer agreed to this when they turned agent access on, but it must be what they asked for.

1. Stop your own writes to the folder first.
2. `restore_plan` with the target version's `snapshotId` (or commit id) from `history_list`, never its name. Read `summary` (overwrite, add, delete counts), `protection` (whether unsaved changes exist: they are saved as a **pre-restore version** first), `collisions` (files in the way that no version holds), `writers.recentlyModified` (files still changing) and `blocked`.
3. `restore_apply` with the `planId`, within 30 minutes. A plan is applied once.
4. Report the result: the restore version (`restored`), and the **protection version** (`protection`) when there was one, so the designer knows the content they had is one restore away. Nothing is lost: history only grows.

Answers to expect:
- `PLAN_STALE`: files changed since the plan. Plan again and read the new plan.
- `UNTRACKED_FILES`: files no version holds would be overwritten or deleted. Tell the designer which (`details`); never delete them yourself.
- `NO_CHANGES`: the folder already matches that version.
- `RECOVERY_REQUIRED` or `LOCKED`: see below.

Say a restore is done only when `restore_apply` answered `ok: true`. Never describe a plan, a request or an `operation_status` of `applying` as done.

## Busy, stale and interrupted operations

- `LOCKED` / `REPO_BUSY`: another Git program is using the repository. Nothing was changed; wait and try again.
- `SOURCE_BUSY`: files kept changing while they were read. Stop the program writing to the folder (often yourself), then retry.
- `HISTORY_CHANGED`: another tool added to the history meanwhile. Nothing was overwritten; try again.
- `RECOVERY_REQUIRED`: an earlier operation stopped part-way (a crash, a file changed meanwhile). `recovery_inspect` lists what is left and the `strategies` each item allows; `recovery_plan` with the `operationId` and `strategy` (`finish` or `rollback`), then `recovery_apply`. Files other programs changed since (`conflicts`) are left as they are: report them. If unsure which strategy, show the designer the inspect result and ask.
- `operation_status` follows any operation or request by its id; `operation_cancel` stops one at the next safe boundary (a save before it publishes, a restore before its first file) or withdraws a request. `too-late` means it will complete or go to recovery.

## GitHub (optional, the designer's account)

- `auth_status` says whether the app is signed in and as whom; `remote_status` whether a project is connected to a repository and its sync state (`synced`, `pending`, `diverged`…).
- **Only the designer** signs in (`auth_login_request` asks them in the app), connects a repository (`remote_connect_request`, with the first-push review) or makes a repository public. Both answer `CONFIRMATION_REQUIRED`; follow with `operation_status`. **Never ask the designer for a token, password, or browser session, and never offer to paste one.** There is no tool that gives you a token.
- After the designer connected a repository, every save is pushed in the background. `sync_push` pushes now; `sync_pull_plan` then `sync_pull_apply` gets newer versions from GitHub. Pulling writes the folder like a restore: it refuses with `UNSAVED_CHANGES` (save first) and only fast-forwards.
- `REMOTE_DIVERGED`: GitHub and the folder both have new versions. **Nothing was changed on either side.** Tell the designer; never merge, rebase, reset or force anything.
- `AUTH_REQUIRED`, `NETWORK_UNAVAILABLE`, `REMOTE_REJECTED` (`details.reason`): everything local keeps working; saving never needs the network.
- `remote_open_plan` / `remote_open_apply` open one of the designer's synced repositories into a folder that does not exist yet or is empty. Never into a folder with content.

## Never

- Run `git` in a Draft Tide project (no `commit`, `checkout`, `stash`, `reset`, `clean`, `rebase`, `push`…), delete or edit `.git`, or edit `.drafttide.json`. Draft Tide owns them; a plain `git commit` or `reset --hard` can lose the designer's work and is never a fallback.
- Pass `confirmed`, `force` or `--yes`: inputs are strict and they are refused as `INVALID_ARGUMENT`. Nothing lets you do what only the designer can do in the app.
- Report a request, a plan, a warning or a running operation as a completed save, restore or sync. Quote error codes as they are.
- Download, update or substitute Draft Tide, its Node or Git, or read the Engine's data directory, keychain or `.git` yourself.
