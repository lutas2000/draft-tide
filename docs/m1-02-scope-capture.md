# M1-02: filesystem scope and capture

Date: 2026-10-02 · Machine: macOS 27.0.1, Apple Silicon (arm64), Node 24.18.1, Apple Git 2.54.0 · Work package: M1-02 ([M1 plan §12](../.ref/M1_IMPLEMENTATION_PLAN.md))

M1-02 decides what a version contains and reads it safely: canonical roots, the scope rule, repo-form detection, `.drafttide.json` as untrusted input, the parent-directory check, streaming capture into immutable staging with a free-space preflight and progress, and per-project write guards. It writes nothing into the design folder or its `.git`. Writing objects, the index and refs (the snapshot itself) is M1-03; the GUI and CLI flow on top is M1-04.

M1-02 depends on M1-01 only, which is done (`docs/m1-01-skeleton.md`).

## What was built

| Module | Contents |
|---|---|
| `packages/contracts` | `scope.ts`: the stable reasons for `REPO_UNSUPPORTED` (20) and `REPO_BUSY` (7), the `UNSUPPORTED_ENTRY` kinds (7), repo warnings, the default excludes, and `CaptureProgress`. `CONFIG_INVALID` reasons are now a list, adding `missing` and `not-regular-file`. Four more JSON Schemas (22 in total) |
| `packages/core` | Ports `GitRepo`, `Workspace` and `StagingArea`. `scanScope()` (the scope rule), `reviewScope()` (what the GUI shows before binding), `captureScope()` (§7.1 steps 3–5), `attributeVerdict()`, `blobMode()`, `createProjectWriteGuards()`, Git path order and collision detection |
| `packages/git-backend` (new) | The only code that runs Git. A process runner (argument arrays, an environment built from scratch, the command-line hardening, bounded output, timeout and abort), `probeRepo()`, and the named read-only operations: `listIndex`, `listUntracked`, `listExcluded`, `checkAttributes`, `existingBlobs`. `createScratchGitDir()` for folders that have no `.git` yet |
| `packages/adapter-filesystem` (new) | Never runs Git. `canonicalRoot()`, `inspectPaths()` (lstat with every parent checked), `digestFile()` (streaming blob hash, optionally into an exclusive read-only staged copy), `readProjectConfigFile()`, `createStagingArea()`, `volumeSpace()`, and `openWorkspace()` tying them to one root |
| Lint | Module boundaries for the two new packages: core imports no adapter; git-backend and adapter-filesystem stay out of each other; adapter-filesystem may not spawn processes; no client (GUI, Main, CLI, MCP) imports either |

### The scope rule

As decided in the single-repo spike (`git add -A` semantics), now in `scanScope()`:

- Every tracked file is in. An untracked file is in unless `.gitignore`, `info/exclude`, the default excludes or the project's own excludes leave it out. `.drafttide.json` is always in.
- Excludes only gate untracked files, so neither a default nor a project rule can drop a tracked file.
- A tracked file that is gone, or whose path now holds a folder, or whose parent folder is now a file, is a deletion (Git's view too).
- Anything in scope that can't be saved is reported, never skipped: symlinks (tracked or new), special files, a parent that is a symlink, unreadable files, unsafe or non-UTF-8 names, and paths that collide by case or Unicode normalization.
- Index entries decide repo blockers: unmerged entries are `REPO_BUSY`; gitlinks, skip-worktree and assume-unchanged are `REPO_UNSUPPORTED`. An untracked nested repo is `nested-repo`.

### Capture

`captureScope()` runs up to four attempts (one plus three retries), then fails with `SOURCE_BUSY`, naming the files that kept changing. One attempt:

1. Read `.drafttide.json`, list the scope with its excludes, refuse blockers and unsupported entries, check attributes.
2. Hash every file, read only. A file must still be the inode the scan saw, opened without following links, unchanged while read.
3. Ask Git which of these blobs the index already references. Check free space for exactly the rest.
4. Stream only that new content into immutable staging, hashing it again.
5. List and hash everything again: same paths, same ids, same modes, and the settings file still the bytes that defined the scope.

The result lists every file with its mode and blob id, and a staged path or `null` when the index already references the blob.

## Decisions taken here

- **Who calls what.** Core orchestrates the capture through ports; it is a use case, and fakes test its retry and preflight decisions deterministically. git-backend is the only package that runs Git. adapter-filesystem only reads, stages and measures. Neither adapter imports the other, and lint enforces it. Real-Git, real-filesystem tests live with the composition root (`apps/companion/test/scope-capture.test.ts`).
- **Hash first, then stage only what is new.** The spike staged every file on every save. Now every file is hashed once (read only), and only content whose blob the index doesn't already reference is staged. Then everything is hashed again to verify. A typical save writes almost nothing to staging, and the preflight checks exactly the bytes that will be added.
  - **Only blobs the index references count as present.** gc keeps those, so a version never depends on a dangling object (TECH_STACK §6.5). Content Git only holds as a dangling blob is staged again (tested).
  - Git objects still come only from staged bytes or from those same blobs. M1-03's `write-tree` refuses a tree whose objects are missing.
- **Free space.** Checked after hashing, for the new content only, on each volume. The data directory needs room for the staged copies, and the project's `.git` for loose objects (with per-object overhead) and a new index. When both are on one volume, the needs add up. Each volume keeps a 64 MiB margin (headroom, not a quota). Running out mid-write is also `INSUFFICIENT_DISK_SPACE`, and the attempt's staging is removed. Details name the volume (`app-data`, `project` or `shared`), never a path.
- **Stable reasons in contracts.** Every `REPO_UNSUPPORTED`, `REPO_BUSY`, `UNSUPPORTED_ENTRY` and `CONFIG_INVALID` reason is defined once in `contracts`. Errors carry `details.reason` (the first blocker) and `details.blockers` (all of them, each with a count and up to five sample paths).
  - **New repo reasons.** Besides the spike's list: `overlaps-app-data` (below), `unknown-repo-format` (a format version above 1, or an unknown extension in a version-1 repo), `bare-repo`, and `dot-git-special` (`.git` neither a file, a folder nor a symlink).
  - **Precedence.** An unsupported form wins over a busy one, since retrying won't fix it.
- **Default excludes** (new files only):
  - Folders: `node_modules`, `.cache`, `.parcel-cache`, `.next`, `.turbo`, `.vite`, `.pnpm-store`, `.claude`, `.cursor`, `.idea`, `.vscode`.
  - Files: `.DS_Store`, `Thumbs.db`, `desktop.ini`, `.env`, `.env.*`, `*.log`, `*.tmp`, `*.swp`, `*.swo`, `~$*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`, `.npmrc`, `.netrc`, `.git-credentials`, `.*.dt-tmp-*`.
  - They use the same character set as the project's own excludes (tested).
  - Command-line excludes outrank `.gitignore`, so a `!` line there can't bring back a defaulted file.
- **Executable bit.** Taken from the file where the filesystem has one and the repo says `core.fileMode` is on. Otherwise (Windows, `core.fileMode=false`) a tracked file keeps its index mode and a new file is `100644`, as `git add` does.
- **A folder that overlaps Draft Tide's data directory is refused** (`overlaps-app-data`), in either direction. Staging inside the project would become part of the scope.
- **Scope review before `git init`.** A plain folder is listed through an empty bare git dir in the data directory (`createScratchGitDir`). Its `.gitignore` files apply, and nothing is written into the folder.
  - The review skips the scope scan when the repo form is unsupported (it can't be bound as it is).
  - It reads file contents only to check line endings on files with explicit `text`/`eol` attributes.
- **Git environment.** Built from scratch on every call, with the spike's command-line hardening. Additions:
  - `GIT_ALLOW_PROTOCOL=none`: set, so it outranks any `protocol.*.allow` in the repo, and it names no real protocol.
  - `GIT_NO_LAZY_FETCH=1` and `GIT_ADVICE=0`.
  - On Windows, `SystemRoot`/`WINDIR` and `USERPROFILE`.
  - Plumbing only: `ls-files`, `check-attr`, `cat-file --batch-check`, `config --file --no-includes`, `symbolic-ref`, `for-each-ref`, and `init --bare` for the scratch dir. No config includes are followed when probing.
- **Which Git.** git-backend takes a `GitRuntime` (executable, exec path, an empty private HOME). Development and tests use `DRAFT_TIDE_GIT` or the first `git` on `PATH` (`findGitOnPath`). Release builds will use the bundled full Git and never look at `PATH` (M1-09).
- **No fixed quotas in the runner.** Listings stream NUL-separated records with no output budget, because their size is proportional to the project. Small metadata calls have a 4 MiB output budget (`RESOURCE_BUDGET_EXCEEDED`, budget `git-metadata-output`) and a 60 s timeout. Listings take an abort signal instead.
- **Cancellation.** Every step takes an `AbortSignal`. A cancelled capture discards its attempt and rethrows the signal's reason. No error code was added: mapping it to the `cancelled` operation state comes with operation status and cancel (M1-05).
- **Write guards.** One queue per project inside the Engine. A failed write releases the guard like a successful one. Different projects run concurrently.

## How to run

```bash
corepack pnpm run check                                        # everything
corepack pnpm exec vitest run packages/core packages/git-backend packages/adapter-filesystem
corepack pnpm exec vitest run apps/companion/test/scope-capture.test.ts   # real Git + filesystem
```

Draft Tide's code under test uses `DRAFT_TIDE_GIT` or the first `git` on `PATH`. Fixtures and controls use the `git` on `PATH` the way a user would, with a private global config instead of the developer's own.

## Results (this machine)

`corepack pnpm run check`: format, lint, typecheck and build clean; **228 passed, 3 skipped** (Linux-only: non-UTF-8 names twice, case collisions). M1-01 had 84.

| Suite | Tests | What they show |
|---|---|---|
| Contracts | 5 new | Defaults fit the project-exclude character set; reasons unique and stable in form; blocker codes paired with their own reasons; no ETA in progress |
| Core | 35 new | Capture with an in-memory folder: staging only new content, deletions, defaults only for new files, `.drafttide.json` always in, retry then success, `SOURCE_BUSY` after 4 attempts with nothing left staged, an inode swap, files appearing mid-capture, settings changing mid-capture, project excludes, missing settings, unsupported entries and collisions refused without retry, probe and index blockers, LFS, CR with explicit `text` (not with `text=auto`), preflight per volume and shared, cancellation, executable-bit trust. Also write guards, Git path order (property), collisions, `mapLimit` |
| git-backend | 59 new (1 skipped) | Every refused form on real repos: inside another repo, detached HEAD, linked worktree, `.git` symlink, shallow clone, sha256, reftable, partial clone, promisor, sparse checkout and index, bare, unknown extension and format, each busy marker, a real merge conflict. Plus hooks and dangerous-config warnings, `core.fileMode`, a missing folder. Listings: modes, flags, symlink and gitlink entries; `.gitignore`/`info/exclude`/rules; nested repos; Unicode names; attributes; existing blobs. **Nothing under `.git` changes** (byte and mtime digest). The scratch git dir writes nothing into the folder. Hostile `core.excludesFile` and `core.attributesFile` are ignored, each with a plain-Git control that honors them. The environment ignores `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG_PARAMETERS` and `GIT_OBJECT_DIRECTORY` from the Engine's own environment. Every call carries the hardening and explicit dirs, and only plumbing commands run. The runner handles a missing Git, a failing command, an output budget, abort and timeout |
| adapter-filesystem | 26 new | Canonical roots through symlinks, refusals, data-dir overlap both ways. Parent checks: a symlinked parent is refused; a file where a folder was is a deletion. Special and unreadable files. Blob ids equal Git's for random bytes (property) and for empty, CRLF and 3 MiB files. Staged copies are exact, 0400 and exclusive: an existing file at the destination is left alone, and a cancelled or changed copy is removed. An atomic-save inode swap and a parent swapped for a link after the scan both read as `changed`, and nothing is staged. Cancellation. `.drafttide.json`: folder, too large, not JSON, not UTF-8, unknown field and symlink each rejected with their reason. Staging paths and permissions, id validation, free space |
| Companion (real Git + filesystem) | 22 new (2 skipped) | A realistic folder (HTML/CSS/JS, PNG and font binaries, CRLF text, CJK, emoji and NFD names, tracked `.env.production`, `.drafttide.json` in `.gitignore`, default and project excludes, a deleted file) captured with every blob id equal to `git hash-object --no-filters`. Staged bytes equal the files, **the folder and `.git` unchanged, `git status` identical**. Also: an executable-bit-only change, a fresh repo, a dangling blob, a writer that stops (2 attempts) and one that doesn't (`SOURCE_BUSY`, staging empty), the disk-space refusal, missing and newer-schema settings. Refusals: parent swapped for a symlink to outside (the outside content is not in the object store or staging), tracked and new symlinks, a nested repo, skip-worktree, a real merge conflict, detached HEAD, a filter (with a control: plain `git add` runs it), LFS, `text` with CRLF (`text=auto` and `core.autocrlf` pass). **Hostile repo**: hooks in `.git/hooks` and `core.hooksPath`, fsmonitor through `include.path`, pager, editor, sshCommand, askPass, `diff.external`, `gpg.program` with `commit.gpgSign`, `credential.helper`, `alternateRefsCommand`. Nothing ran during review and capture; the controls (plain `git status`, `git commit`) fire them. Scope review of a plain folder; every blocker of a repo at once; no scan when the form is unsupported |

Timing (capture only, one machine, informational; M1-03 adds objects and the commit):

| Case (1,501 files, 13.6 MB) | Result |
|---|---|
| Everything new (staged 13.6 MB) | 0.57–0.61 s |
| Unchanged, all referenced by the index (nothing staged) | 0.43 s |
| One file edited | 0.36–0.37 s |
| Scope review | 76 ms |

## Known limits and follow-ups

- **Not wired into the Engine yet.** No catalog operation uses the scope or capture. M1-04 adds them:
  - a desktop-only scope review and init, plus the GUI screen;
  - the Engine's Git runtime (bundled path in release, an empty HOME in the data directory);
  - turning progress into throttled operation events.
  - The `ScopeReview` shape lives in core until it crosses the process boundary; then it moves to contracts.
- **Check then open.** Node has no `openat`, so a parent swapped between the parent check and the open can't be prevented. After opening, the file must be the inode the scan saw, so another file's content is never read or staged (tested), as in the spike.
- **Not exercised.**
  - The foreign-owner check: it needs a repo owned by another user.
  - An `ENOSPC` in the middle of staging: the preflight refusal is tested with an injected volume.
  - On Windows, CI runs everything except the symlink, FIFO, permission and executable-bit tests and the hostile-repo suite (shell-script markers). The owner check doesn't exist there.
  - Non-UTF-8 names and case collisions are tested on Linux only (APFS can't create them).
- **Stricter than needed.** Paths that collide by case or Unicode normalization are refused at capture, not only before write-back, as M0 and the spike did.
- **Stuck until fixed elsewhere.** A tracked symlink or gitlink blocks saving until it is removed from the index with other tools: excludes never drop tracked files.
- **Keynote files.** `*.key` (private keys) also keeps new Keynote files out. They show up under excluded files in the review, and there is no way to bring them back in M1 (no `!` patterns). Tracked ones are kept.
- **Hardlinks** are saved by content. Links are not preserved and links that leave the folder are not detected.
- **SHA-1 identity.** Content identity is Git's SHA-1 blob id. A file whose bytes match a blob the index references is not hashed by Git again, so Git's collision detection doesn't see it.
- **Staged copies are not fsynced.** They only matter until the version is published. The durable boundaries for restore arrive with the journal (M1-05).
- **Memory.** Path lists are held in memory, proportional to the number of files, as in Git itself.
