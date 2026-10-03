# Draft Tide reference: tools, commands, errors

Every MCP tool and CLI command below calls the same Engine operation; they answer the same envelope and need agent access on (except `engine_info`). Inputs are strict: an unknown field is `INVALID_ARGUMENT`.

## Tools and commands

| MCP tool | CLI (`draft-tide --json …`) | Effect | What it does |
|---|---|---|---|
| `engine_info` | `engine info` | read | Engine version, `agentAccess.enabled`; works without agent access |
| `project_list` | `project list` | read | Connected projects: `projectId`, `name`, `root` |
| `project_status` | `--project <id> status` | read | Folder state, unsaved `changes`, `activeOperation`, `recoveryRequired`, `blockers`, `unsupported` |
| `project_connect_request` | `init request --root <abs> [--entry <file>] [--name <name>]` | request | Asks the designer to connect a folder in the app: `CONFIRMATION_REQUIRED` + `details.operationId` |
| `project_restore_settings` | `--project <id> restore-settings` | write | Puts a deleted `.drafttide.json` back from the newest version |
| `snapshot_create` | `--project <id> snapshot [--message <name>]` | write | Saves a version (`snapshotId`); `NO_CHANGES` when nothing changed |
| `history_list` | `--project <id> history [--limit n] [--skip n]` | read | Versions and other tools' commits, newest first |
| `snapshot_diff` | `--project <id> diff <from> <to>` | read | Changed files between two versions |
| `snapshot_diff_file` | `--project <id> diff <from> <to> --file <path>` | read | Line-by-line diff of one file |
| `snapshot_preview` | `--project <id> preview <version> [--file <png-or-jpeg>] [--out <png> [--thumbnail]]` | read | Offline picture of a version: artifact + image content (MCP: `image` `full` / `thumbnail` / `none`) |
| `preview_read` | (covered by `--out`) | read | The artifact's PNG in base64 chunks (`offset`, until `done`) |
| `restore_plan` | `--project <id> restore plan <version>` | read | What restoring would overwrite, add, delete; `planId` |
| `restore_apply` | `--project <id> restore apply <plan-id>` | destructive | Saves unsaved changes as a pre-restore version, then restores |
| `recovery_inspect` | `--project <id> recover inspect` | read | Operations that stopped part-way and their `strategies` |
| `recovery_plan` | `--project <id> recover plan --strategy finish\|rollback [--operation <id>]` | read | A recovery plan |
| `recovery_apply` | `--project <id> recover apply <plan-id>` | destructive | Finishes or rolls back; conflicts are left as they are |
| `operation_status` | `operation status <id>` | read | State of an operation or request |
| `operation_cancel` | `operation cancel <id>` | write | Cancels at a safe boundary (`cancelled`, `cancelling`, `too-late`, `ended`) or withdraws a request |
| `auth_status` | `auth status` | read | Signed in to GitHub? As whom? Never a token |
| `auth_login_request` | `auth login request` | request | Asks the designer to sign in, in the app |
| `remote_status` | `--project <id> remote status [--refresh]` | read | The project's repository and sync state |
| `remote_connect_request` | `--project <id> remote connect request` | request | Asks the designer to connect a repository, in the app |
| `sync_push` | `--project <id> sync push` | write | Pushes new versions now (fast-forward only) |
| `sync_pull_plan` | `--project <id> sync pull plan` | read | Newer versions on GitHub and what getting them changes |
| `sync_pull_apply` | `--project <id> sync pull apply <plan-id>` | destructive | Fast-forwards the folder to GitHub's versions; refuses unsaved changes |
| `remote_open_plan` | `remote open plan --url <owner/name> --destination <folder>` | read | Checks a synced repository and an empty or absent folder |
| `remote_open_apply` | `remote open apply <plan-id>` | write | Opens the project into that folder with its history |

Not offered to agents, by design: turning agent access on, reviewing and connecting a folder, signing in, connecting a repository and its first push, disconnecting, signing out, reading a token, any Git passthrough or shell.

## Error codes and the next step

| Code | Meaning | Next step |
|---|---|---|
| `AGENT_ACCESS_DISABLED` | Agent access is off | Ask the designer to turn it on in the app; nothing else works |
| `ENGINE_UNAVAILABLE` | The Engine couldn't be started or reached (retryable) | Try again; otherwise ask the designer to open the app |
| `PROTOCOL_MISMATCH` | CLI/MCP and Engine are different versions | Tell the designer to restart or update Draft Tide |
| `INVALID_ARGUMENT` | Input outside the contract (`details.reason`: `unknown-plan`, `plan-of-another-project`, `unknown-operation`, `folder-not-chosen`, `already-signed-in`…) | Fix the call; never add `confirmed`/`force` |
| `PROJECT_NOT_BOUND` | No such project | `project_list`; a new folder needs `project_connect_request` |
| `LOCAL_ROOT_UNAVAILABLE` | The project folder or its `.git` is missing | Tell the designer; the history is inside that folder |
| `NO_CHANGES` | Nothing to do (not an error; MCP `isError` false; CLI exit 3) | Report it as such |
| `SOURCE_BUSY` | Files kept changing during the read | Stop writers, retry |
| `LOCKED` / `REPO_BUSY` | Another Git program holds the repository (retryable) | Wait, retry; nothing changed |
| `HISTORY_CHANGED` | The branch moved meanwhile | Retry; nothing overwritten |
| `UNSUPPORTED_ENTRY` / `SCOPE_CHANGED` / `PATH_OUTSIDE_ROOT` | Something in scope can't be saved as it is | Report the paths and reasons; don't delete anything |
| `INSUFFICIENT_DISK_SPACE` / `STORAGE_IO_FAILED` / `RESOURCE_BUDGET_EXCEEDED` | Local resources | Report; `details` names the budget |
| `CONFIRMATION_REQUIRED` | Only the designer can do this, in the app; `details.app` says whether the app came forward (`shown`), is opening (`opening`) or must be opened by the designer (`unavailable`) | Follow `details.operationId` with `operation_status` |
| `APPROVAL_DENIED` | The designer declined | Say so; don't ask again on your own |
| `CANCELLED` | Stopped at a safe boundary; nothing further changed | Report |
| `PLAN_STALE` | Files changed since the plan | Plan again |
| `UNTRACKED_FILES` | Files no version holds are in the way | Report them; the designer decides |
| `RECOVERY_REQUIRED` | An operation stopped part-way | `recovery_inspect` → `recovery_plan` → `recovery_apply` |
| `SNAPSHOT_NOT_FOUND` | Not a version on this project's branch | Use ids from `history_list` |
| `CONFIG_INVALID` | `.drafttide.json` is invalid or unsafe | Tell the designer; don't edit it |
| `REPO_UNSUPPORTED` | A repository form Draft Tide won't touch (`details.reason`) | Tell the designer |
| `PREVIEW_UNSUPPORTED` / `PREVIEW_FAILED` | Only the picture (`details.reason`) | The version is fine; say what couldn't be shown |
| `UNSAVED_CHANGES` | Pulling with unsaved changes | Save a version first |
| `AUTH_REQUIRED` | Not signed in / expired (`details.reason`) | `auth_login_request`; local work continues |
| `REMOTE_DIVERGED` | Both sides have new versions; nothing changed | Tell the designer; never merge or force |
| `REMOTE_REJECTED` | GitHub refused (`details.reason`: `app-not-installed`, `no-push-access`, `protected-branch`, `file-too-large`…) | Tell the designer |
| `NETWORK_UNAVAILABLE` | GitHub unreachable (retryable) | Later; versions are safe locally |
| `GIT_FAILED` / `INTERNAL_ERROR` | Unexpected | Report the message; don't work around with Git |
