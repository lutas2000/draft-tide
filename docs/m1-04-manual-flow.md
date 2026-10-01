# M1-04: the first manual flow

Date: 2026-10-02 · Machine: macOS 27.0.1, Apple Silicon (arm64), Node 24.18.1, Apple Git 2.54.0 · Work package: M1-04 ([M1 plan §12](../.ref/M1_IMPLEMENTATION_PLAN.md))

M1-04 connects the scope rules and capture (M1-02) and the Git backend (M1-03) to the Engine, the app and the CLI. A designer can now pick a folder, review what would be saved, connect it and save the first version, see unsaved changes, save named versions and find them in the history. Commits made by other tools appear in that history as external changes, and any two versions can be compared down to the changed lines. None of it needs a terminal. The CLI and MCP get status, saving, history and comparison behind the agent-access switch. Connecting a folder stays in the app.

M1-04 depends on M1-03, which is done (`docs/m1-03-git-backend.md`).

## What was built

| Module | Contents |
|---|---|
| `packages/contracts` | `project.ts`: `FolderReview`, the bind input and result, `ProjectStatus` with its folder states. `history.ts`: `VersionRef` (a snapshot id or a full commit id), `HistoryEntry` with its source, `HistoryPage`, `SavedSnapshot`, `SnapshotDiff`, `FileDiff` with its summary reasons. Seven catalog operations and three events (below). Error codes `PROJECT_ALREADY_BOUND` and `SNAPSHOT_NOT_FOUND`. Six more JSON Schemas (44 files in total, with each operation's input and result) |
| `packages/core` | `createProjectService()`: review, bind, status, save, history, diff and per-file diff, all through ports. `ProjectHost` (the port that opens a folder's repo, workspace and staging) and the binding methods of `LocalStore`. `compare.ts` (tree diff with renames, text diff on jsdiff, hunks, budgets), the branch's line index in `history.ts`, `working.ts` (status against the newest commit, with a hash cache). The scope review now carries a fingerprint. Capture checks the folder's project id |
| `packages/local-store` | Bindings: get, find by root, insert, relink, rename. The existing table's keys refuse a second binding of a root or a project |
| `packages/adapter-filesystem` | `writeProjectConfigFile()`: compare-and-swap on the reviewed bytes, then an atomic replace |
| `apps/companion` | The Engine's `ProjectHost` and its Git runtime. The CLI commands `status`, `snapshot`, `history` and `diff` with `--project`. MCP tools follow from the catalog (`project_status`, `snapshot_create`, `history_list`, `snapshot_diff`, `snapshot_diff_file`). The server no longer lets a too-large result reject unhandled |
| `apps/desktop` | Main's native folder picker. The GUI's scope review, project page (status, save, history, version details) and comparison screen. Copy for every error code and reason |

### Operations added to the catalog

| Operation | Desktop | Tool channel (CLI, MCP) | Effect |
|---|---|---|---|
| `project.review` | yes, for a folder picked in the app | not offered | read |
| `project.bind` | yes, for a folder picked in the app | not offered | write |
| `project.status` | yes | with agent access | read |
| `snapshot.create` | yes | with agent access | write |
| `history.list` | yes | with agent access | read |
| `snapshot.diff` | yes | with agent access | read |
| `snapshot.diffFile` | yes | with agent access | read |

Events, to the app only: `project.changed` (connected or saved, through any channel), `operation.progress` (stage, files and bytes; no file names) and `operation.settled` (completed, no changes, or failed with its code).

### The flow in the app

1. **Pick.** 開啟設計資料夾 opens the native picker.
2. **Review.** The scope review shows the repo (an existing repo and its branch, or a new one), the files to save and the largest of them, tracked files that are gone, unsupported items, the excluded files, and the repo's hooks and settings Draft Tide ignores. It also shows whether the folder already belongs to a project. Reviewing writes nothing. A repo form Draft Tide refuses gets its reason and next step instead of a scope listing (`scopeListed: false`), and nothing to confirm.
3. **Confirm.** 確認並保存第一版 connects the folder: `git init` if needed, then `.drafttide.json`, then the binding. It then saves the first version, showing progress.
4. **The project page.** It shows unsaved changes (added, modified, deleted, renamed) against the newest commit. 保存版本 takes an optional name. Saving with nothing changed says so and adds nothing. 重新檢查 reads the folder again, as does returning to the window. The history shows V-numbered versions with their kind and source, and other tools' commits as 外部變更. Selecting an entry shows its details.
5. **Compare.** Any two entries can be compared: the files that changed, each text file expandable into a read-only line diff. Other files show their sizes and content ids.

## Decisions taken here

- **Connecting a folder is the GUI's alone.**
  - **Picked, not typed.** Main keeps the folders the user picked in the native dialog during the run. `project.review` and `project.bind` with any other path get `INVALID_ARGUMENT` (`folder-not-chosen`) before reaching the Engine, so a path injected into the renderer authorizes nothing.
  - **Not offered to the tool channel** (`UNKNOWN_OPERATION`). The request flow, where an agent asks and the user completes it in the app (`CONFIRMATION_REQUIRED` with an operation id), is M1-05.
- **Bind checks the review again.**
  - **The review token.** It names what the user saw: the repo's branch and tip, every path in scope (not the content), deletions, unsupported entries, blockers, the settings file's bytes and the binding. Bind reviews again and refuses with `SCOPE_CHANGED` when anything differs, with nothing written.
  - **What it refuses first.** Repo blockers, unsupported entries, an unusable `.drafttide.json` and an entry page that isn't saved. Anything that would stop the first save is refused before anything is written.
  - **Then the writes, in order:** `git init` (if needed), `.drafttide.json`, the SQLite binding.
  - **The settings file is written compare-and-swap.** It is replaced only if it still has the reviewed bytes (or is still absent). It goes through a temporary file beside it that the default excludes match (`.*.dt-tmp-*`), fsynced, then renamed. Its mode is 0644, or the existing file's mode (the Engine's umask is 077).
  - **The first save is a separate call.** The GUI saves right after connecting. If that save fails, the folder stays connected and the project page says why and offers to save again. An adopted repo whose newest commit already holds the same folder answers `NO_CHANGES`, which the GUI treats as saved.
- **Existing settings and copies.**
  - **Keep.** A valid `.drafttide.json` keeps its project id.
  - **A copy.** When that id is already connected to another folder that still holds the project, the folder is a copy. Bind refuses with the new code `PROJECT_ALREADY_BOUND` unless the user chooses to connect it as a new project (`asNewProject`: a new id is written into its settings and recorded by the next save).
  - **A moved folder.** When the other folder is gone or no longer holds the project, the binding moves to the new folder.
  - **The same folder again.** Connecting it a second time returns the existing project.
- **Status compares the folder with the newest commit**, not with the index: what the next save would record.
  - **A cache for display only.** File digests are kept in the Engine's memory per project, keyed by the file's full identity (device, inode, size, both timestamps). A file changed within 2 s of being hashed is not remembered (Git's "racily clean" case).
  - **Saving never uses it.** It hashes every file again (M1 plan §7.1).
  - **What else it reports.** Blockers, unsupported entries, a Draft Tide lock left in `.git` (`recoveryRequired`) and a save in progress. The folder's state is one of `available`, `missing`, `repo-missing`, `config-missing`, `config-invalid` and `project-mismatch`.
  - **Saving refuses a mismatch.** A `.drafttide.json` that names another project makes saving refuse with `LOCAL_ROOT_UNAVAILABLE` (`project-mismatch`); capture checks it inside every attempt.
- **Which commit a version id names** (left open by M1-03).
  - **The line.** Versions are numbered and resolved along the first-parent line of the checked-out branch.
  - **Copies.** The oldest commit carrying a snapshot id is the version. A later commit with the same id was copied by another tool (cherry-pick, a rebase of someone's branch), shows as a `copy`, and is referenced by its commit id.
  - **What a reference may be.** A snapshot id, or a full commit id on the line. Short ids, branch names and revision expressions are refused by the schema (`INVALID_ARGUMENT`). A well-formed id that isn't on the line is the new code `SNAPSHOT_NOT_FOUND`.
  - **The index.** The line is indexed in memory and rebuilt whenever the tip moves; it comes from Git alone.
- **Comparison.**
  - **Files.** Which files differ is decided by Git's tree and blob ids. A rename is identical content and mode at a new path, paired one to one, never for empty files. A rename with edits shows as a deletion plus an addition.
  - **Lines.** The line view uses jsdiff's array diff with line breaks kept (a CRLF→LF change is a change). Hunks carry three lines of context.
  - **Synchronous, with a short budget.** jsdiff's callback mode advances one step of edit distance per timer tick. A 600-line rewrite took 0.7 s that way on macOS and over 3 s on Windows CI, against 1 ms synchronously. So the diff runs synchronously, and its 1 s budget bounds how long it keeps the Engine busy (a 1,000-line rewrite takes about 100 ms; 5,000 lines that all differ would take 2.1 s, and become `too-complex`).
  - **What is shown as a summary.** A file with NUL bytes, or that isn't UTF-8, is `binary`. Then `too-large` (over 2 MiB on either side), `too-complex` (over 1 s or 100,000 edits), `not-a-file` (symlinks and gitlinks other tools committed) and `identical`.
  - **Notes.** The response names a change of line endings or of the final line break.
- **Everything fits one control message (1 MiB).**
  - **Lists are cut.** Status changes, diff file lists and line hunks are cut to fit, and say `truncated`; a hunk that doesn't fit is cut after its last whole line. Counts always cover everything.
  - **The server.** It now answers a result that is still too large with `RESOURCE_BUDGET_EXCEEDED`. Before, the failed send rejected unhandled, which would have stopped the Engine (tested both ways).
- **Text from Git is made safe** before it leaves the Engine. Commit titles and other tools' author names have control characters and bidirectional overrides replaced, and are cut to 200 code points. Other tools' emails are not passed on. The CLI applies the same rule to paths it prints.
- **Origin follows the channel.** A save from the app is `manual` (`gui`); one from the CLI or MCP is `agent-requested` with origin `cli` or `mcp`. The app shows it as 由 agent 請求 with the M1 plan's caveat.
- **Git for the Engine.**
  - **Development.** The Engine runs `DRAFT_TIDE_GIT` or the first `git` on its minimal PATH. Launchers in development builds pass `DRAFT_TIDE_GIT` on; on Windows the Engine has no PATH, so it needs it.
  - **Release builds.** They have no Git until M1-09 bundles one. Operations that need it answer `GIT_FAILED` (`git-missing`); listing projects still works.
  - **HOME** is an empty private directory in the data directory (`git-home`).
- **MCP tool names** are snake case: `snapshot.diffFile` becomes `snapshot_diff_file`.
- **The GUI bundle** is 507 KB (451 KB after M1-03). It is read from disk inside the app, so Vite's 500 kB warning limit is raised to 1 MiB.

## How to run

```bash
corepack pnpm run check                                              # everything
corepack pnpm exec vitest run apps/companion/test/manual-flow.test.ts  # the flow on a real Engine, Git and filesystem
corepack pnpm --filter @draft-tide/desktop run test:e2e              # the app (macOS)
corepack pnpm run desktop                                            # try it: 開啟設計資料夾
```

With agent access on (設定與診斷):

```bash
node apps/companion/dist/cli.mjs project list
node apps/companion/dist/cli.mjs --project <id> status
node apps/companion/dist/cli.mjs --project <id> snapshot --message "Compact pricing cards"
node apps/companion/dist/cli.mjs --project <id> history
node apps/companion/dist/cli.mjs --project <id> diff <snapshot-a> <snapshot-b> [--file index.html]
```

## Results (this machine)

`corepack pnpm run check`: format, lint, typecheck and build clean; **358 passed, 3 skipped** (the same Linux-only skips). M1-03 had 293. Desktop E2E: **16/16** (9 new).

| Suite | Tests | What they show |
|---|---|---|
| Contracts | 10 new | Connecting stays off the tool channel; the rest needs agent access; nothing is destructive yet. Strict inputs: self-asserted flags, unsafe entry pages, multi-line names and control characters in paths are refused. Version references accept only snapshot ids and full commit ids (no `HEAD`, branch names or short ids). Events carry no file names |
| Core | 26 new | Tree diff: kinds in Git order, renames paired one to one, never for empty files or across a mode change. Symmetry, checked as a property. Text diff: applying the hunks to the old text gives the new one (property, 200 runs), and the line counts agree. A 1,000-line rewrite is shown line by line within the time budget. Context and hunk splitting; CRLF→LF; a final line break that came or went; added and deleted files; each summary reason; a hunk cut to the budget. Line index: numbering from the oldest, external commits unnumbered, copies, references on the line only, forged and newer metadata, control characters and bidi overrides in titles and names, batched reads. Hash cache: identity, the racy window, retention. Status: renames, edits, deletions, additions; unchanged files hashed once; unsupported entries never counted as deletions |
| Local store | 1 new | Binding, lookup, relink, rename; a second root or project refused; survives a reopen |
| adapter-filesystem | 7 new | `.drafttide.json` created 0644 or replaced keeping its mode, with nothing left behind. `SCOPE_CHANGED` with nothing written when the file appeared, was edited, was removed or became a folder. A symlink in its place is never written through |
| Companion (real Engine, Git, filesystem) | 21 new | **Connecting:** reviewing a plain folder writes nothing; connecting runs `git init` on `main`, writes the settings and saves a baseline. Plain `git status` is clean and the secrets and `node_modules` stay out. An existing repo is adopted on its branch on top of the user's commit, its other branches untouched. **Refused with nothing written:** a detached HEAD, a symlink, a newer-schema settings file (left as it was), files that appeared after the review (`SCOPE_CHANGED`, then a new review works), an entry page that isn't saved. Copies: `PROJECT_ALREADY_BOUND`, then `asNewProject`. A moved folder relinks with its history. Connecting a connected folder returns the project. **Status and saving:** add, delete, rename and edit reported; status writes nothing into `.git`; `NO_CHANGES` adds no commit. **History:** an engineer's commit is external, a cherry-picked Draft Tide commit a copy, and the snapshot id names the original; saving builds on top of both. Paging. Commits off the line and unknown ids are `SNAPSHOT_NOT_FOUND`; `HEAD`, `main` and short ids `INVALID_ARGUMENT`. **Comparison:** an HTML line diff, CRLF→LF, a PNG as binary, a 3 MB file as too large, a missing path, a path escaping the project. **Folder trouble:** settings deleted, broken or naming another project, and `.git` moved away, each reported and refused for saving; all recover. **Events:** every save stage reported, and the outcome. **Tool channel:** no review or bind; agent access needed; CLI status, save (`agent-requested`, origin `cli`), no-op exit code 3, history and a file diff. Usage errors and unknown projects. Terminal escapes in another tool's commit title are not printed. **Server:** a 2 MiB result is `RESOURCE_BUDGET_EXCEEDED` and the session keeps working; the old code fails this test |
| Desktop E2E | 9 new | The renderer can't review a folder it didn't pick. Through the GUI: open a folder (the native picker answered by the test), review (and nothing written), connect and save the first version. The CLI is refused while agent access is off, and plain Git shows a clean, correct tree. Then: an edit is noticed and saved under a name; a save with nothing changed adds nothing; an engineer's commit shows as an external change; two versions compare down to the changed line. With agent access on, the CLI sees the same status, history and diff, and a CLI save appears in the app as 由 agent 請求. A repo in detached HEAD gets its reason and next step, no scope listing and nothing to confirm, and nothing is written |

Timing (one machine, informational; 1,501 files, 16 MB: 1,400 text files and 100 binary assets, three runs):

| Case | Result |
|---|---|
| Review a plain folder | 131–162 ms |
| Connect (`git init`, settings, binding) | 88–92 ms |
| Status, first time (hashes everything) | 241–243 ms |
| Status, files unchanged and remembered | 131–198 ms |
| Status after one edit | 122–136 ms |
| First save | 1.6–1.9 s |
| Save one edit | 0.55–0.61 s |
| History page (32 versions; index built) | 56–58 ms; 35–36 ms when the tip hasn't moved |
| Compare first and newest version (1,501 files) | 106–108 ms |
| Line diff of a 5 KB file | 58–60 ms |

Most of a status is listing the folder (`ls-files` twice, `check-attr`, `ls-tree`, an lstat per file), not hashing.

## Known limits and follow-ups

- **Agents can't ask to connect a folder yet.** The request flow (`CONFIRMATION_REQUIRED`, operation status, the pending request in the app) is M1-05, and so are operation status and cancel for saves. Progress reaches only the app; the CLI waits without progress.
- **Not repairable in the app yet.** A deleted or broken `.drafttide.json` blocks saving, and the app only explains it; restoring it from a version is M1-05. Excludes can't be edited in the app, so unsupported items must be fixed outside it.
- **No previews.** Comparison is by files; side-by-side previews and thumbnails are M1-06. 試用範例 and 從 GitHub 開啟 are still marked as not available.
- **History is the first-parent line.** Commits brought in by a merge's second parent are not listed and can't be referenced. Names in other tools' trees that aren't UTF-8 are left out of comparisons.
- **Rebuildable views live in memory.** The status cache and the line index are per Engine process, lost when it exits. The line index is rebuilt in full whenever the tip moves, which reads every commit object on the line. That is fine at the measured scale; very long histories are not measured.
- **What counts as a moved folder.** A project's old folder counts as gone when it is missing or no longer holds that project's settings. A disk that is only unplugged looks the same, and relinking then moves the binding (no data is touched). Plugging it back shows that folder as a copy.
- **A plan line out of date.** M1 plan §13.2's "root 不可用仍可讀歷史" predates the single-repo design: history lives in the folder, so an unavailable folder has no readable history. The status explains this instead.
- **Not exercised here.** Windows and Linux run in CI. The app on Windows: in development its Engine needs `DRAFT_TIDE_GIT`. Screen readers and IME input in the new screens.
