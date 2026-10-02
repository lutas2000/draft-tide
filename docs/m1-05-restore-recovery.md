# M1-05: restore, recovery and agent requests

Date: 2026-10-02 · Machine: macOS 27.0.1, Apple Silicon (arm64), Node 24.18.1, Apple Git 2.54.0 · Work package: M1-05 ([M1 plan §12](../.ref/M1_IMPLEMENTATION_PLAN.md))

M1-05 makes restoring safe and makes every change recoverable. A designer can pick any entry in the history and restore it: the app shows what would be overwritten, added and deleted, saves unsaved changes as a pre-restore version first, writes the files, and records a restore version on top. History only grows. An agent with agent access can do the same through the CLI or MCP, and the app shows its restore as a notice that names the protection version. Every save and restore is journaled in SQLite, so an Engine that is killed mid-way leaves a record that says how far it got: the next Engine completes what needs no decision at start, and the user finishes or rolls back the rest from a recovery card (or `draft-tide recover`). The tool channel can now ask the user to connect a folder; the request waits in the app until the user answers it.

M1-05 depends on M1-04, which is done (`docs/m1-04-manual-flow.md`).

## What was built

| Module | Contents |
|---|---|
| `packages/contracts` | `restore.ts`: `RestorePlan` (changes against the folder as it is, protection, settings, collisions, space, writer hints, `blocked`, `noop`), `RestoreResult`, `RestoreProgress`, recovery reasons and strategies, `RecoveryReport`, `RecoveryPlan`, `RecoveryResult`. `operation.ts`: states (adds `awaiting-user`, `denied`, `rolled-back`), kinds (`save`, `restore`, `connect-request`), `OperationStatus`, cancel outcomes, `OperationList`, the connect request. `journal.ts`: the journal and stored-plan formats (local state, not a public DTO). `CommitRef`. Twelve catalog operations, the new `operations.changed` event and restore progress. Error code `CANCELLED`. `ProjectStatus.saving` became `activeOperation`. 73 JSON Schemas (44 before) |
| `packages/core` | `context.ts`: the shared `ProjectContext` (lookup, caches, guards, the journal, the write runner with cancellation and the active-operation registry). `journal.ts`: the transition table and compare-and-set moves. `restore.ts`: plan and apply. `recovery.ts`: assessment, automatic completion, finish and rollback. `operations.ts`: status, cancel, requests, notices. `save.ts` split into `probeForWrite`, `saveSnapshot` and `recordCapture`, with the publish intent journaled first. Ports: journal, files and plans in `LocalStore`; write-back in `Workspace`; `preparedIndexes` in `GitHistory`; `clearOperationData` in `ProjectHost`; `TestHooks` |
| `packages/local-store` | Migration 2: `operations`, `operation_files`, `plans`. Journal, file and plan methods; strict read-back; pruning |
| `packages/adapter-filesystem` | `writeback.ts`: write and remove one file against an expected content id, occupants, folder listing |
| `packages/git-backend` | `preparedIndexes()` |
| `apps/companion` | Startup recovery in the Engine; test crash points (development builds); `clearOperationData`. CLI: `restore plan/apply`, `recover inspect/plan/apply`, `operation status/cancel`, `restore-settings`, `init request`; operation ids in human error output. MCP tools follow from the catalog; the instructions explain restore, recovery and requests |
| `apps/desktop` | The restore dialog (`restore-dialog.tsx`): the plan's counts and files, protection, settings, collisions, space, writer hints, confirm, progress with cancel before the first file, `PLAN_STALE` with 重新檢查. The recovery card (`recovery-card.tsx`) with finish, rollback or remove-the-lock and a confirmation showing the plan's counts. Banners (`operation-banners.tsx`) for agent requests (選擇資料夾… opens the native picker at the requested folder; 拒絕) and agent restore notices (知道了). 從最新版本放回設定檔 on the settings-missing card. Settings: pending requests and operations needing recovery. Main's `chooseFolder(defaultPath)` (where the dialog opens; still only the picked folder is granted). Copy for the new codes and reasons |

### Operations added to the catalog

| Operation | Desktop | Tool channel (CLI, MCP) | Effect |
|---|---|---|---|
| `restore.plan` | yes | with agent access | read |
| `restore.apply` | yes | with agent access | destructive |
| `recovery.inspect` | yes | with agent access | read |
| `recovery.plan` | yes | with agent access | read |
| `recovery.apply` | yes | with agent access | destructive |
| `operation.status` | yes | with agent access | read |
| `operation.cancel` | yes | with agent access | write |
| `project.restoreSettings` | yes | with agent access | write |
| `project.connectRequest` | no | with agent access | write (answers `CONFIRMATION_REQUIRED`) |
| `operation.list` | yes | not offered | read |
| `request.decline` | yes | not offered | write |
| `operation.dismiss` | yes | not offered | write |

`project.bind` takes an optional `requestId`. Events: `operation.progress` and `operation.settled` also for `restore.apply` and `recovery.apply` (outcomes add `cancelled` and `recovery-required`), `project.changed` adds `restored` and `recovered`, and `operations.changed` says the requests, notices or operations needing recovery changed.

## How a restore works

1. **Plan** (read-only but for the plan's row). The target is a snapshot id or a commit id on the branch's line. Draft Tide reads the folder the way a save does (scope, attributes, every file hashed, the status cache allowed) and the version's tree, then says what applying would do against the folder as it is: overwrite, add, delete, unchanged. It also says whether the folder has unsaved changes (they will be protected), what happens to `.drafttide.json`, what is in the way, the bytes to write and the free space, and hints about writers. The plan is stored with a fingerprint: branch, tip, target, the settings decision, every file in scope with its content and mode, and the collisions.
2. **Apply**, under the project's write guard, after recovery:
   - the plan is consumed and the operation starts in one transaction (`confirmed`);
   - agent access is checked again (tool channel), the repo probed, the branch and tip compared with the plan's, Git's index lock checked;
   - the folder is captured once, with the stable capture a save uses; the fingerprint is recomputed from it (`PLAN_STALE` if anything differs);
   - that same capture becomes the pre-restore version if the folder differs from its newest commit (its publish journaled first);
   - the file list goes into the journal (`staged`); access, the index lock and cancellation are checked a last time;
   - **past the point of no return** (`applying`): deletes first, then writes, each only while the path still holds what the capture saw;
   - every changed file is read back (`verified`); the restore version is built (the target's tree, or the target's tree with the current settings file), journaled and published lock-first (`publishing → committed → completed`).

## Decisions taken here

- **Collisions are only what no version holds.** Unsaved files in scope, including new ones, go into the pre-restore version and may then be overwritten or deleted. What blocks a restore (`UNTRACKED_FILES`) is something outside the scope where the version adds a file: an ignored or excluded file, a folder holding such files, a symlink or special entry, or one of these as a parent. Files the restore deletes first don't count, compared as a case-insensitive filesystem would (`Readme.md` → `README.md` works). Out-of-scope files are never written or deleted.
- **A version must fit in a folder.** Symlinks and submodules other tools committed, names that aren't UTF-8 or aren't safe, and names that collide by case refuse the whole version (`UNSUPPORTED_ENTRY`, `version-not-restorable`), never a partial restore.
- **The settings file stays when the version's can't serve this project.** A version from before Draft Tide (no `.drafttide.json`), one whose settings are broken, or one naming another project (an older version of a copy connected as a new project) would cut the folder off from its project. The current settings file stays, the plan says so (`settings.action: kept`, with the reason), and the restore version's tree is the target's with the current settings blob.
- **A deleted settings file comes back on its own terms.** Without `.drafttide.json` there is no scope, so neither saving nor restoring can run (a restore's protection version is a save). `project.restoreSettings` puts back the newest commit's copy, only while the file is absent (compare-and-swap on "absent", through the same atomic write as connecting) and only if it names this project. A file that is there, even a broken one, is never replaced (`INVALID_ARGUMENT`, `settings-present`).
- **Nothing to restore is `NO_CHANGES`.** When the folder already matches the version, applying adds nothing (no protection, no empty restore commit).
- **Plans last 30 minutes and are used once.** `PLAN_STALE` carries why: `expired`, `used`, `changed`, `history-changed`, `external-change`. An unknown plan or another project's plan is `INVALID_ARGUMENT` (`unknown-plan`, `plan-of-another-project`): a caller mistake, not a changed folder.
- **One capture serves the check and the protection.** The apply doesn't trust the plan's reading: it captures under the guard, recomputes the fingerprint, and records that capture as the pre-restore version. No second reading can slip in between.
- **The point of no return is the first file.** Before it, any failure (including `LOCKED`, a cancel, access turned off, and an expected-content mismatch on the first file) leaves the working files untouched and the operation `failed` or `cancelled`; a pre-restore version already recorded stays (history only grows). After it, an external change, a failed write, a failed read-back or a version that can't be recorded stops the operation in `recovery-required` and the caller gets `RECOVERY_REQUIRED` with the reason. Nothing is rolled back silently over someone's new work.
- **Writing one file.** An exclusive `.restore.dt-tmp-<uuid>` beside it (the default excludes match it, so a leftover is never saved), mode 0644 or 0755, flushed; then the path is checked once more for the expected content (or for nothing; an empty folder in the way is removed) and the file renamed in, and the folder flushed. Parents must be real folders; missing ones are created 0755. Deleting a file removes folders it left empty, as Git's checkout does. The bytes stream from Git: the target is in history and the content before is in the pre-restore version or the tip, so no payload is staged.
- **Names are matched by their exact spelling.** On a case- or normalization-insensitive filesystem (the macOS and Windows defaults), `logo.png` resolves to `Logo.png`. Write-back, removal and read-back check that a file exists spelled exactly as the path, segment by segment; collision detection treats another spelling as the in-scope file the restore deletes first. A case-only rename (`logo.png` → `Logo.png`) therefore works, and recovery never removes a file because another spelling of its name was asked for.
- **The bytes are checked before they replace anything.** The temporary file's content id must be the version's blob id, so a stream cut short can't take a file's place. On Windows, a rename refused because another program has the file open is retried briefly, each time after checking the expected content again.
- **Rollback undoes in reverse.** A file that took a folder's place is removed before the folder's files come back.
- **HEAD is checked under the lock.** Switching branches needs `.git/index.lock`, so publish reads HEAD after taking it: if the folder was switched to another branch during the save or restore, the index is not switched and the publish refuses (`HISTORY_CHANGED`, `branch-changed`). When `update-ref` fails and the branch can't be read back either, the lock stays (`RECOVERY_REQUIRED`) instead of being taken as "the ref didn't move".
- **A finished index switch isn't redone.** If neither the operation's lock nor its prepared index is left, the switch happened and only the journal is behind: recovery completes the journal and leaves the live index (and whatever Git staged since) alone.
- **Failures are recorded under the write guard.** Journal moves after a failure happen inside the guarded call, so the next queued change can't move the same row first.
- **Read-back covers the changed files.** Unchanged files were checked by the stable capture; if another program edits one during the restore, it shows as an unsaved change afterwards.
- **The journal.**
  - **Three tables** in SQLite (migration 2, with the usual backup). `operations` holds one row per operation, its kind-specific details as JSON read back strictly against the contracts' schema (`STORAGE_IO_FAILED`, `corrupt-record` otherwise). `operation_files` holds a restore's files with their content before and after. `plans` holds plans with their fingerprint and who consumed them.
  - **Moves are compare-and-set** on the state the caller last saw, through one transition table in core; terminal states never change, and `failed` is allowed only before a file is written.
  - **Saves are journaled too.** Their publish intent (ref, expected old, commit, tree) is written before the lock is taken, so recovery can tell from the branch tip whether the ref moved. `committed` marks that Git holds the result.
  - **Retention.** Ended operations and plans are kept 30 days for status and notices and pruned at Engine start; unfinished ones never are.
- **Recovery works from evidence.**
  - **Automatic.** At Engine start (projects with an open journal row or Draft Tide's lock in `.git`) and under the guard before every save or restore. An operation that wrote no working file has its own lock, prepared index and staging removed and is `failed`. A publish whose ref moved gets its index switched (the prepared one, or one rebuilt from the commit's tree) and its lock released; one whose ref never moved has its lock released. One someone built on is `superseded`. If HEAD is on another branch now, only the lock is released.
  - **A lock nothing explains.** Draft Tide's lock with no journal row (an earlier Draft Tide, or SQLite was lost) counts as an index switch only when the tip's metadata carries the lock's operation id; otherwise it is an `unknown-lock` item the user may remove (rollback).
  - **The user decides** about a restore that wrote files. Each file is classified by what it holds now: done (as the restore wanted), pending (as before it) or a conflict (neither). `finish` writes the pending ones and records the restore version on the branch's current tip; `rollback` writes the done ones back and records nothing (`rolled-back`). Both leave conflicts as they are and report them.
  - **Plan → apply for recovery too.** `recovery.plan` stores the strategy with a fingerprint of every file's class, the tip and the lock; `recovery.apply` recomputes it under the guard (`PLAN_STALE`).
  - **What blocks.** While an item needs a decision, saving and restoring that project answer `RECOVERY_REQUIRED`; other projects are unaffected. `project.status.recoveryRequired` reports it; operations running in this Engine are never treated as needing recovery.
- **Agent access is checked three times for an apply.** In the policy, under the write guard, and before the first file. Turning it off after that lets the restore finish.
- **Cancelling.** `operation.cancel` aborts at the next safe boundary: a save until it publishes, a restore until its first file, either while it waits for the guard. The caller gets `CANCELLED` (new). Outcomes: `cancelled`, `cancelling`, `too-late`, `ended`.
- **Requests to connect a folder.**
  - **Recorded, never read.** `project.connectRequest` needs agent access, takes an absolute path and an optional name and entry pages, records an `awaiting-user` operation without touching the path, and always answers `CONFIRMATION_REQUIRED` with the operation id. At most 20 wait at once (`RESOURCE_BUDGET_EXCEEDED`).
  - **Answered in the app.** The user picks the folder in the native picker (opened at the requested path; the picked folder is still the only authorization) and connects it through the review screen with `requestId`; or declines it (`denied`, `APPROVAL_DENIED`). The agent may withdraw it (`cancelled`).
  - **No app launch yet.** The Engine doesn't open the app for a request; that needs the packaged app's location (M1-09). The CLI says to open the app.
- **Agent restores are visible.** The app lists restores made through the CLI or MCP as notices, with the protection version, until the user dismisses them; history records the origin.
- **Crash points for tests.** A development or test Engine kills itself (SIGKILL) at `DRAFT_TIDE_TEST_CRASH_AT` (`save:publishing`, `publish:after-ref#2`, `restore:file:2`, …). Release builds never read it.

## How to run

```bash
corepack pnpm run check                                                 # everything
corepack pnpm exec vitest run apps/companion/test/restore.test.ts         # restores on real Git, files and SQLite
corepack pnpm exec vitest run apps/companion/test/crash-recovery.test.ts  # kill the Engine mid-way, recover
corepack pnpm --filter @draft-tide/desktop run test:e2e                 # the app (macOS)
corepack pnpm run desktop                                               # try it: select a version, 回復到此版
```

With agent access on (設定與診斷):

```bash
node apps/companion/dist/cli.mjs --project <id> restore plan <snapshot-id>
node apps/companion/dist/cli.mjs --project <id> restore apply <plan-id>
node apps/companion/dist/cli.mjs --project <id> recover inspect
node apps/companion/dist/cli.mjs --project <id> recover plan --strategy finish
node apps/companion/dist/cli.mjs --project <id> recover apply <plan-id>
node apps/companion/dist/cli.mjs init request --root /path/to/folder
node apps/companion/dist/cli.mjs operation status <operation-id>
```

## Results (this machine)

`corepack pnpm run check`: format, lint, typecheck and build clean; **439 passed, 3 skipped** (the same Linux-only skips). M1-04 had 358. Desktop E2E: **21/21** (5 new).

An independent adversarial review of the restore, recovery and write-back code (a second agent, with scratch tests on real Git, APFS and SQLite) found no path that loses bytes no version holds, and seven problems that are fixed here with a test each: a case-only rename that recovery would then delete, a rollback in the wrong order, an index switched after HEAD moved to another branch, a Windows rename retry without a fresh check, a cancel that could slip past the last check, recovery redoing an index switch that had finished, and journal moves after a failure running outside the write guard. Names Windows can't hold remain a known limit (below).

| Suite | Tests | What they show |
|---|---|---|
| Contracts | 8 new | Restore and recovery need agent access and their applies are marked destructive; plans only read. The tool channel can only ask to connect a folder; the answers stay in the app. Inputs refuse self-asserted flags, revision expressions, unknown strategies and unsafe entry pages. `CANCELLED` is a plain failure, not a no-op. Operation records, journals and plans are strict. Restore progress carries no file names |
| Core | 12 new | The journal never leaves a terminal state and fails only before the first file. What a restore changes (property: an equal folder changes nothing). A version a folder can't hold is refused, naming every item. Collisions: unsaved files, folders with them, parents, but not files the restore deletes first. Requests: recorded and answered with `CONFIRMATION_REQUIRED`, declined, withdrawn, completed by a bind, bounded at 20; unknown ids; notices until dismissed; what needs recovery; a corrupt record is never passed on |
| Local store | 7 new | Compare-and-set moves that survive a reopen; listing by project, kind, state and notice; a restore's files; a plan applied once, its operation started in the same transaction; pruning that keeps unfinished operations; a damaged record reported; migration from version 1 with a backup |
| adapter-filesystem | 10 new | A file created with real-folder parents (0755) and its mode; replaced only with the expected content; an empty folder replaced, a full one never; never through a link or a file parent; paths outside the folder refused; nothing left behind when the stream fails; bytes with the wrong content id never replace a file; another spelling of a name is not the name; removal with the expected content prunes empty folders; occupants and folder listings |
| Companion: restore (real core, Git, files, SQLite) | 25 new | **Plan** writes nothing and says what changes. **Apply** protects unsaved changes, restores V1's bytes (text, a 2 KB and a 3 MB binary), adds exactly two commits, leaves other branches and tags alone, `git status` clean, `git fsck` clean, history shows the pre-restore version and the restore with `restoreOf`; no protection when nothing is unsaved; `NO_CHANGES` when nothing differs. **Refusals** with nothing written: a stale plan (edited, used twice, history moved), expired, unknown and other projects' plans, `confirmed: true`, files no version holds in the way, a version with a symlink, another Git's lock. **What it writes:** the current settings kept for a version from before Draft Tide; modes, folders and a file in a folder's place, both ways; a case-only rename. **During a restore:** a file changed before the first write (PLAN_STALE, protection kept); a file changed while writing (recovery: finish around it, or roll back); a commit made meanwhile (finish builds on it); a file/folder swap rolled back. **Access and cancel:** access off before files are written stops it, after lets it finish; cancel before the first file only; a queued save cancelled; an agent's restore listed as a notice until dismissed. **Settings file:** put back when deleted, never over an existing one. A save never switches the index of a branch HEAD left |
| Companion: crash recovery (real Engine killed with SIGKILL) | 11 new | A save cut between the ref and the index: a plain `git commit` is blocked by the lock, the next Engine finishes the switch, `git status` clean, the version once. Cut after journaling the publish: nothing changed. Cut after the switch but before recording it: the index Git has since is kept. A journal-less lock whose operation the tip names is finished; an unexplained one is the user's to remove; another Git's lock is never touched. A restore cut while publishing its protection, after protecting, part-way through its files (finished through the CLI, or rolled back), with every file written but nothing recorded, and between the restore's ref and index. The journal survives restarts |
| Companion: requests and CLI | 8 new | `init request` needs agent access, never reads the folder, answers `CONFIRMATION_REQUIRED` with the operation id (also in human output); the app lists, declines and completes requests; the agent withdraws one; no flag lets the tool channel connect a folder; at most 20 wait; unknown ids are usage errors. CLI restore plan and apply, a plan used twice refused, the app's notice and events |
| Desktop E2E | 5 new | Restore V1 from the app after seeing its plan: protection version V4, the bytes of V1, plain Git clean, 查看回復前保護版本. A file edited after the plan: 檔案已改變，請重新檢查回復內容, nothing changed, 重新檢查. An agent's request declined (the CLI sees `APPROVAL_DENIED`), another answered through the native picker and the review (completed with the project). An agent's restore shown with its protection version until 知道了. A lock left with the tip's operation id finished from the recovery card |

Timing (one machine, informational; the M1-04 fixture: 1,501 files, 16 MB, 1,400 text files and 100 binary assets; after editing 50 text files and replacing 5 images, then leaving 28 files unsaved; three runs):

| Case | Result |
|---|---|
| Plan a restore to V1 (83 files to overwrite) | 386–397 ms |
| Apply it, with a pre-restore version of 28 unsaved files | 2.02–2.05 s |
| Plan when the folder already matches | 386–400 ms |
| Plan and apply a restore that needs no protection | 1.70–1.74 s |
| Inspect recovery with nothing open | 23–24 ms |

Most of an apply is the stable capture (every file read twice), then one flushed write and folder flush per changed file.

## Known limits and follow-ups

- **The app isn't opened for a request.** It waits until the user opens the app (M1-09 knows where the app is).
- **The last check before a rename is not atomic.** Node has no `openat`/`renameat` with an expected-content check, so a program that writes the file between the last check and the rename loses that write. The per-file check makes the window small; protection versions keep everything that was saved.
- **Writers are only hinted at.** Recently modified files and a running Draft Tide operation are shown; nothing stops another program. The per-file checks stop the restore when one interferes.
- **Read-back is per changed file.** See the decision above.
- **Recovery needs the restore's branch.** If HEAD moved to another branch, finish and rollback ask to switch back first.
- **Names Windows can't hold.** Versions made elsewhere with names like `CON`, `a:b` or a trailing dot are not refused before restoring on Windows; the per-file checks stop such a restore part-way (`recovery-required`) instead of losing anything. Refusing them in the plan on Windows is a follow-up.
- **Two data stores on one folder** (two Engines with different `DRAFT_TIDE_DATA_DIR`) see each other's locks as unknown; the user decides.
- **No `doctor` command yet.** `recover inspect` and `status` cover what it would; the diagnostics export is M1-09.
- **Not exercised here.** Windows and Linux run in CI; the app on Windows is untested, and so is write-back against a file another Windows program holds open. Screen readers and IME input in the new screens.
