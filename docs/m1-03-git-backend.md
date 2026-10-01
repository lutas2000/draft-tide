# M1-03: the Git backend of the project's repo

Date: 2026-10-02 · Machine: macOS 27.0.1, Apple Silicon (arm64), Node 24.18.1, Apple Git 2.54.0 · Work package: M1-03 ([M1 plan §12](../.ref/M1_IMPLEMENTATION_PLAN.md))

M1-03 turns a capture into a version in the project's own repo: raw blobs, a tree built in a temporary index, a commit carrying the metadata, and the lock-first publish (`index.lock`, then compare-and-swap of the branch, then the index). It also reads history back: commits, first-parent pages, trees and streamed blobs. All of it runs on the command-line hardening, with plumbing only. It is not wired into the Engine yet: no catalog operation saves, and there is no GUI or CLI path. That is M1-04. Recovery driven by the journal is M1-05.

M1-03 depends on M1-01 and M1-02, both done (`docs/m1-01-skeleton.md`, `docs/m1-02-scope-capture.md`).

## What was built

| Module | Contents |
|---|---|
| `packages/contracts` | `snapshot.ts`: the commit message format (`formatCommitMessage`, `readCommitMetadata`), `CommitIdentity` and the fixed `DRAFT_TIDE_IDENTITY`, and `SaveProgress` (the capture stages plus `write` and `publish`). `isSafeRelativePath` now refuses every name a filesystem would take for `.git`. Two more JSON Schemas (24 in total) |
| `packages/core` | The `GitHistory` port, next to M1-02's `GitRepo`; `ProjectGit` is both. `saveSnapshot()` (§7.1 end to end) and `readHistory()`. Capture now counts a blob as present when any index entry references it, including the entry of a file that was deleted or renamed |
| `packages/git-backend` | `history.ts`: `init`, `writeBlobs`, `prepareIndex`, `prepareIndexFromTree`, `discardPreparedIndex`, `createCommit`, `publish`, `finishPublish`, `indexLock`, `releaseIndexLock`, `readRef`, `readCommits`, `firstParentLine`, `listTree`, `lookupPath`, `streamBlob`, `isAncestor`. The runner gained newline records, raw chunks, an explicit "no timeout" for work that grows with the project, and `streamGit()` for reads with backpressure. `openGitRepo()` returns both halves; a repo opened on a scratch git dir refuses every history operation |

### Saving a version

`saveSnapshot()` runs under the project's write guard:

1. Probe the repo and refuse its blockers. Refuse with `RECOVERY_REQUIRED` while `.git/index.lock` holds a Draft Tide operation: an earlier publish didn't finish.
2. Capture the scope (M1-02, §7.1 steps 3–5).
3. Write only the content Git didn't have, from the staged copies (`hash-object -w --no-filters --stdin-paths`), and check every returned id against the captured one.
4. Build the version's tree in `.git/index.dt-<operationId>` (`update-index --index-info`), check that the index holds exactly those entries, and write the tree. `write-tree` refuses an entry whose object is missing.
5. A tree equal to the tip's is `NO_CHANGES`: nothing is published and the prepared index goes.
6. Commit on the tip the save started from (`commit-tree --no-gpg-sign`), with the metadata in the message.
7. Publish lock-first (§9.3.1).

The staging folder is removed after every save, successful or not. The result names the snapshot, its kind, commit, tree, parent and branch, with counts of files, bytes and new objects.

### Publishing

1. Check that the prepared index describes the commit's tree (one `write-tree` and one commit read), then take `.git/index.lock` exclusively, writing `draft-tide <operationId>` into it and fsyncing it.
2. `update-ref <branch> <new> <expected old>`.
3. Rename the prepared index over `.git/index`.
4. Remove the lock.

| Outcome | What is left |
|---|---|
| Another Git holds `index.lock` past the wait | `LOCKED` (`details.lock: "index"`); nothing changed, prepared index removed |
| The branch moved meanwhile | `HISTORY_CHANGED`; their commit and index untouched, lock released, prepared index removed |
| Another Git is updating the branch (its ref lock) | `LOCKED` (`details.lock: "ref"`); nothing changed |
| Failure after the ref moved | `RECOVERY_REQUIRED`; the version is in history, the lock stays (so no plain `git commit` can record the old index), and so does the prepared index. `finishPublish(operationId)` completes it |

## Decisions taken here

- **Two ports.** `GitRepo` (M1-02, scope listings) and `GitHistory` (objects, the index, the branch, history). One implementation provides both. Capture needs only the first, so its tests stay small. A repo opened on a scratch git dir (scope review of a plain folder) refuses every history operation, so nothing can be written into a git dir that isn't the project's.
- **The commit message.**
  - **Format.** The save name (trimmed), or a fixed title per kind; a blank line; then `Draft-Tide-Snapshot: <canonical JSON metadata>` as the last line. The titles are English, because engineers read them with plain Git and on GitHub; the GUI uses its own wording.
  - **Reading is strict.** Commit messages are untrusted on the way back in. The line must be the last one, after a blank line, at most 4 KiB, canonical JSON (no other spelling, key order or duplicate keys), and the schema exactly.
  - **Three outcomes.** A snapshot. An external commit (no metadata line: another tool made it). Unreadable: `invalid`, or `newer-schema` (a newer Draft Tide wrote it).
  - **Contents.** The metadata carries the operation id, which the lock content also names, so recovery can match a commit to its operation.
- **Kind.** `baseline` is the first version Draft Tide makes in the repo: the one that brings `.drafttide.json` into the branch (the tip is unborn, or its tree has no such file). After that, a save from the GUI is `manual` and one from the CLI or MCP is `agent-requested`.
- **Commit identity and time.**
  - **Exact identity.** `CommitIdentity` refuses what Git would silently rewrite: `<`, `>`, line breaks, and leading or trailing whitespace or punctuation. What is recorded is exactly what was given. M1-07 has to normalize GitHub display names before building one.
  - **Fixed identity.** Before sign-in: `Draft Tide <draft-tide@localhost>`. The repo's `user.*` and the global identity are never read.
  - **Time.** Commit times are whole seconds in UTC (`+0000`), so no local offset ends up in history. The metadata's `createdAt` keeps milliseconds.
- **The prepared index is verified.** `update-index --index-info` skips a path it refuses with only "Ignoring path" on stderr and exit code 0 (measured: `GIT~1/config`, `.GIT/x`, `.git./x`, a `.git` with a zero-width joiner, `a//b`). The prepared index is listed again and must hold exactly the intended entries. A dropped path is `UNSUPPORTED_ENTRY` (`invalid-name`), a mismatch `GIT_FAILED`. A version never silently loses a file.
- **Names Git would take for `.git` are refused in the scope.** `isSafeRelativePath` mirrors Git's `verify_path`:
  - any case;
  - HFS+ ignorable code points inside the name;
  - the NTFS forms: trailing dots or spaces, an alternate data stream, the 8.3 short name `git~1`.
  - The hardening turns `core.protectHFS` and `core.protectNTFS` on everywhere (`protectHFS` is off by default outside macOS), so every platform refuses the same names. This also protects restore (M1-05) from a tree that names `GIT~1/hooks/…`.
- **More hardening** for local operations:
  - `i18n.commitEncoding=UTF-8` and `i18n.logOutputEncoding=UTF-8`: a repo's encoding setting would otherwise add an `encoding` header to Draft Tide's commits (control tested).
  - `core.fsync=objects,reference,index`.
  - `commit-tree --no-gpg-sign`. `commit-tree` doesn't honor `commit.gpgSign`; measured.
  - `GIT_GRAFT_FILE=/dev/null`: `--no-replace-objects` leaves `.git/info/grafts` in force, and grafts rewrite the parents Git reports (control tested). History is read from the objects.
- **`git init`** names its formats (`--object-format=sha1 --ref-format=files`): Git 3 changes the defaults to ones Draft Tide refuses. Empty template, so no hooks and no sample files; branch `main`.
- **Publishing details.**
  - **Wait for the lock.** Git itself never waits for `index.lock`; Draft Tide waits up to 2 s, enough to ride out an editor's background `git status`.
  - **Classify by repo state.** A failed compare-and-swap is classified by reading the branch again and looking for its ref lock, never by Git's wording.
  - **Ref moved despite an error.** If `update-ref` reports a failure after the ref did move, the version is in history, so the switch continues: releasing the lock then would leave exactly the stale index the protocol exists to prevent.
  - **Windows.** The index rename is retried briefly there, where a reader holding the file open blocks it.
- **Renames and copies are free.** M1-02 counted a blob as present only when the entry of a file still on disk referenced it, so a renamed asset was staged and written again. Now any index entry counts, including one whose file is gone: gc keeps what the index references, and after the save the new index and commit reference it.
- **Cancellation** is honored until the commit exists, never after publishing starts.
- **Reading.**
  - Commits are read with `cat-file --batch`. At most 1 MiB of each commit object is kept; a larger one is marked `truncated`, and its metadata isn't read.
  - Other tools' identities are parsed leniently, and their messages decoded as UTF-8 lossily.
  - History is read in pages of the first-parent line (`rev-list --first-parent`, up to 10,000 a page).
  - Trees are streamed (`ls-tree -r -z -l`), with names that aren't UTF-8 reported, not dropped. Blobs are streamed with backpressure; ending the iteration stops Git.
  - None of these reads has a fixed size quota; the signal cancels them.
- **No cache table yet.** History comes from Git alone. A plain `git clone` of the repo reads back as the same history (tested), so any index built on it later can be dropped and rebuilt.

## How to run

```bash
corepack pnpm run check                                        # everything
corepack pnpm exec vitest run packages/git-backend/test/history.test.ts   # the backend on real Git
corepack pnpm exec vitest run apps/companion/test/save.test.ts            # saving end to end
```

## Results (this machine)

`corepack pnpm run check`: format, lint, typecheck and build clean; **293 passed, 3 skipped** (the same Linux-only skips as M1-02). M1-02 had 228.

| Suite | Tests | What they show |
|---|---|---|
| Contracts | 11 new | The message format round-trips (property) and gives each kind its title. A message without the line is external; the key on the title line is user text. Reading refuses a line not separated by a blank line, non-canonical JSON (spaces, key order, a repeated key), anything off-schema, and anything over 4 KiB; a newer schema reads as `newer-schema`. Identities: CJK names and noreply addresses pass; names and addresses Git would rewrite are refused. Thirteen `.git` look-alikes are refused, while `.github`, `.gitignore`, `git~2` and a dotless `ı` are kept |
| Core | 14 new | `saveSnapshot` on an in-memory repo. A first version is a baseline with its metadata and the exact publish request. Existing history stays a baseline until the settings file is in it. Origins map to kinds. Only new content is written, once per distinct content, and progress runs from write to publish. `NO_CHANGES` leaves no prepared index and no commit. A Draft Tide lock refuses before capture. `LOCKED` and `HISTORY_CHANGED` pass through with nothing changed, and a retry builds on the other commit. A wrong blob id stops it. Cancel works up to the commit. Name and repo are checked first. `readHistory` sorts snapshots, external commits and forged metadata, and pages. Capture reuses a renamed file's blob |
| git-backend | 28 new | Real Git: `init` (main, no hooks, sha1). Scratch repos refuse history operations. Raw bytes unfiltered under `core.autocrlf` and `text`, with a control that filters. The tree equals the one plain `git add -A && git write-tree` builds from the same files (CJK, emoji, exec bit). Refusals: missing objects, unsafe or repeated paths, a Git that drops an entry. Exact author, committer, time and message, no signature. **Publishing:** the branch and index move together and `git status` is clean; a new branch is created; `LOCKED` with nothing changed (the foreign lock untouched); a short wait for a lock about to be released; `HISTORY_CHANGED` with the other commit and index untouched, also on an unborn branch; `LOCKED` on a held ref lock. **The window:** a plain `git commit` and `git add` fail with "index.lock" between ref and index. A publish cut short leaves its own lock and prepared index; another operation can't release or finish it; `finishPublish` completes it, also after the lock was deleted by hand. An `update-ref` failure after the ref moved still completes the switch. An index that doesn't match the commit is refused. **Reading:** first-parent pages through a merge, ancestry, grafts ignored (control honors them), a signed Latin-1 commit read lossily, a 1.2 MB commit truncated, missing and non-commit ids refused, trees with every mode and a non-UTF-8 name, 5 MiB streamed exactly, early stop, cancel, missing blob. **Hostile repo:** hooks in `.git/hooks` and `core.hooksPath` (including `reference-transaction` and `post-index-change`), fsmonitor through `include.path`, `commit.gpgSign` with `gpg.program`, `i18n.commitEncoding`, `user.*`, `core.splitIndex`: nothing ran, the commit is unsigned, UTF-8 and has Draft Tide's identity. Controls fire each one. Every call carries the hardening and explicit dirs; only plumbing commands run |
| Companion (real Git + filesystem) | 12 new | **A realistic folder saved as a baseline** on the user's HEAD: every tree entry equals the file's unfiltered blob (CRLF, CJK, emoji, a real NFD name); tracked files clean in `git status`, untracked only the excluded files; `git fsck --strict` clean; name, metadata and identity in the commit. **The user's state untouched:** other branches, both kinds of tags, the stash, `config`, `packed-refs`, `info/exclude` and hooks are byte-identical, and the hook didn't run. Also: an edit writes one blob, a copy and a rename none; `NO_CHANGES` leaves every byte in `.git` as it was; a new folder; an exec-bit-only change; CRLF under `core.autocrlf` and `text=auto`. **Next to other Git users:** external commits are history and get built on; a plain clone reads back the same history; a commit during the save loses cleanly (`HISTORY_CHANGED`) and a retry builds on it; `LOCKED` changes nothing and a save after the release works; a lock Draft Tide left refuses (`RECOVERY_REQUIRED`). **Hostile repo:** a full save runs no hook, fsmonitor or signing program, with a control |

Timing (one machine, informational; 1,501 files, 14.2 MB: 1,400 text files and 100 binary assets, in a repo Draft Tide initialized):

| Case | Result |
|---|---|
| First save (everything new) | 1.8–2.1 s: capture 0.67 s, writing 1,501 objects and the tree 1.06 s, publish 0.08 s |
| Unchanged (`NO_CHANGES`) | 0.53–0.63 s |
| One file edited | 0.57–0.62 s: capture 0.45 s, write 0.08 s |
| 10 assets renamed | 0.56 s, no new objects |
| 30 single-file text edits | `.git` grew 608 KiB (loose objects, no gc) |
| 3 assets replaced (210 KB) | 0.59 s, `.git` grew 228 KiB |
| Plain `git status` after a save | 74–89 ms (the index has no stat data yet), then 12–15 ms |

Fsync is not the cost: with `core.fsync=none` the first save took 1.77 s. `core.fsyncMethod=batch` made it slower (8 s), so it isn't used. The writing stage is `hash-object` compressing 14 MB into 1,501 loose objects.

## Known limits and follow-ups

- **Not wired into the Engine.** No catalog operation saves or reads history. M1-04 adds them (with init and adopting a folder, status and file diff), and resolves a snapshot id to one commit.
- **No automatic recovery yet.** A publish cut short after the ref moved leaves Draft Tide's lock. Saves refuse with `RECOVERY_REQUIRED` until M1-05's journal-driven recovery calls `finishPublish` (or marks the operation superseded). The other leftovers M1-05 has to clean:
  - an Engine killed between commit and publish leaves an unreferenced commit, which Git prunes in time;
  - it also leaves `.git/index.dt-<operationId>`.
- **The residual risk** stays: deleting the lock by hand, as Git's message suggests, brings back the stale index (tested; `finishPublish` still repairs it).
- **Not exercised.**
  - On Windows: the index rename retry, a held lock, the hostile-repo suite (shell-script markers). CI runs the rest.
  - Running out of disk space while writing objects (classified as `INSUFFICIENT_DISK_SPACE` like the adapters, but not injected).
- **`git status` after a save** lists files the default excludes left out but `.gitignore` doesn't (`.env`, `node_modules/`) as untracked. Draft Tide doesn't edit `.gitignore`.
- **Duplicate snapshot ids.** A Draft Tide commit copied by cherry-pick or amend carries the same snapshot id. `readHistory` reports both; deciding which one an id names is M1-04's.
- **The index after a save has no stat data**, so the first plain `git status` re-hashes the files (74–89 ms for 1,501 files). Partial staging (`git add -p`) is not kept: the index equals the saved tree, as in the spike.
- **First saves of large folders** pay for writing every file as a loose object (1.06 s for 14 MB). Writing a pack for a first save could be faster; not measured.
