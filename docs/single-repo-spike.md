# Single-repo spike report

Date: 2026-10-01 · Machine: macOS 27.0.1, Apple Silicon (arm64) · Spike code: [`spikes/single-repo/`](../spikes/single-repo/README.md)

This spike tests one proposal: **drop the separate per-project bare repo and keep Draft Tide's history in the project's own Git repo**, with that repo also being the thing that syncs to a remote. It is throwaway feasibility code, like `spikes/m0/`. Nothing here is the M1 implementation and nothing counts as data-safety acceptance.

Status: the suite passes on two Git builds: dugite Git 2.53.0 (48 checks, including the optional TLS check) and Apple Git 2.54.0 (47 checks, without it). The design was approved on 2026-10-01 and written into `CLAUDE.md` and `.ref/` (ROADMAP, M1 plan, TECH_STACK); this report is the evidence behind it.

## Decisions behind the spike

These product decisions came out of the discussion that led to this spike and are now in the main docs.

- The repo is a **design repo**. Draft Tide owns it; engineers read it (clone, pull, browse on GitHub) and do not write to it.
- No second repo: no app-repo handoff mode, no `drafttide/*` branch namespace, no `.drafttide` backup/import in the GUI. A snapshot is a commit on the checked-out branch (`main` by default). Directions (M2) would be ordinary branches.
- Project settings (entry files, extra scope excludes, project id) live in a small file at the repo root, **`.drafttide.json`**, so a fresh clone can rebuild its binding. Engineers can see and hand-edit it.
- Local use stays complete and offline. The remote is a per-project private GitHub repo. GitHub sign-in is skippable and is only the first sync entry point.
- A save never waits for the network: it lands locally first, and push/pull are separate operations.
- Commit identity is the signed-in GitHub user (display name plus their `ID+USERNAME@users.noreply.github.com` address, never the private email); before sign-in a fixed "Draft Tide" identity. The spike only has the fixed identity; `SaveOptions.identity` is where the real one plugs in.
- Draft Tide's commits run no repo hooks and are unsigned. The consequences (an engineer's pre-commit formatter does not apply to saves; a remote rule that requires signed commits rejects the push) were accepted.

## Answers

| Question | Result | Evidence |
|---|---|---|
| Can a snapshot be a commit in the user's own repo without disturbing it? | **Yes**, under the protocol below. `.git/config`, `HEAD`, hooks, other branches, tags and stash are untouched; `git status` is clean afterwards; `git fsck --strict` passes | A1, A2, A6 |
| Does staged / unstaged / deleted / untracked / unborn / non-git folder all work? | **Yes** | A2, A3, A4 |
| What happens when someone else writes to the repo at the same time? | Ref compare-and-swap loses cleanly (`HISTORY_CHANGED`), nothing is overwritten, retry chains on top. `index.lock` held by another Git refuses the save *before* anything is published (`LOCKED`) | B3, B4 |
| Is the index sync safe across a crash? | **Only with the lock-first protocol** (see Finding 1). With it, a kill at any point recovers, and a plain `git commit` in the window fails loudly | B1, B2, B7, B8 |
| Can a hostile repo config or hook make Draft Tide run a program or redirect traffic? | Not for local work (command-line overrides, verified against a control that does fire hooks). **Yes for network work unless it runs in an ephemeral git dir** (see Finding 3) | D1–D4, F3 |
| Does it stay correct when Git would rewrite content (LFS, filters, line endings)? | Raw bytes are kept; repos where Git would disagree are refused up front | C5, C7, C8, D3 |
| Does a remote round trip work, including authentication through askpass? | **Yes against a local smart-HTTP server**. Push, fetch, clone-from-remote, fast-forward, divergence refused both ways, token never in argv / `.git` / data dir / output | F1–F7 |
| Can an engineer use the result with plain Git? | Yes: a plain `git clone` shows the full history (including their own commits), the design files and `.drafttide.json`, with a clean `git status` | F1 |
| Real GitHub? | **Not run.** TLS verification against github.com worked read-only (`ls-remote` of a public repo). Authenticated push needs a real token: run `node src/github-check.ts` yourself (env vars in the file header) | F9, `github-check.ts` |

## Findings M1 must absorb

### 1. A stale index is not cosmetic: use a lock-first publish

If the ref moves but the real index still describes the old tree, `git status` shows reverse-staged changes, and **a plain `git commit` by anyone silently commits the old tree on top of the designer's save**. This was measured with the first protocol (move ref, then `read-tree`): the commit succeeded and reverted the snapshot in a new commit. No data was lost (the snapshot stays in history, working files are intact) but the history would be wrong.

The protocol that replaced it:

1. Build the new index for the target tree in a temp file inside `.git` (same volume, so the final rename is atomic).
2. Take `.git/index.lock` with `O_EXCL`, writing `draft-tide <operationId>` into it. If another Git holds it: fail with `LOCKED` **before** any ref or file changes.
3. Move the ref with compare-and-swap against the expected old OID.
4. Rename the temp index over `.git/index`.
5. Release the lock.

A crash between 3 and 5 leaves our identifiable lock behind. Other Git commands then fail with "Unable to create index.lock" instead of committing the old tree (B7). Recovery matches the journal by operation id and resulting commit, removes only its own lock, and rebuilds the index while HEAD is still that commit; if someone committed on top it marks the operation superseded and leaves their index alone (B1, B7, B8).

Two residual risks remain and should be stated in M1: if the user deletes the "stale" lock by hand, as Git's own message suggests, the silent revert comes back (B7 observes it), and the window only closes at the next operation, so **recovery must run at Engine start and before every write**. Restore and fast-forward use the same publish step and refuse early (`LOCKED`) before touching files (B8, F7).

### 2. The packaged Git must be a full Git with https

M0's trimmed Git (`spikes/m0/core/build/git`) has no `git-remote-http(s)`: `ls-remote` over HTTP fails with "'remote-http' is not a git command" (F8). The full dugite build has it, and TLS verification against github.com works with it on macOS (F9). Anything that trims the bundle for installer size must keep the https transport and a working CA trust path, and the size cost has to be re-measured. The full build's size was not measured here.

### 3. Network work must not read the project's Git config

For local operations, command-line `-c` overrides outrank the repo's own config, and that is enough. The hardened list (hooks path, fsmonitor, external attribute and ignore files, autocrlf, untracked cache, split index, signing, auto-gc, protocols, fsck) is in `spikes/single-repo/src/git.ts`. The control run without the overrides did run hooks from `core.hooksPath`, from `.git/hooks`, and a `core.fsmonitor` set through `include.path` (D2, D2b).

For fetch and push that is not enough. A config that says `url.<attacker>.insteadOf` redirects the request, and then the askpass token goes to the attacker: the control run delivered the real token to a listener (F3). Multi-valued keys such as `insteadOf`, `credential.helper` and `http.extraHeader` cannot be cancelled from the command line. The fix that passed: run fetch and push with `--git-dir=<ephemeral empty dir>` and `GIT_OBJECT_DIRECTORY=<project>/.git/objects`. Config, hooks and refs come from the ephemeral dir; fetched objects land in the project; real refs are then updated by us with a separate `update-ref`. With `insteadOf`, `http.proxy`, `http.extraHeader`, `credential.helper` and `core.sshCommand` all set in the repo, no request reached the redirect target, no program ran and the repo's extra header was not sent.

Credentials: the token is written to a 0600 file in the 0700 ephemeral dir, and a tiny askpass script cats it. The environment carries only the file path. The token was absent from `.git/`, the data dir, every traced git argv, all git output, and the temp dir was removed afterwards (F2).

### 4. A tracked path can point outside the project

Git hands us paths from the index. A tracked `a/secret.txt` whose directory `a` was replaced by a symlink to another folder would be read from outside the project and saved (and later pushed). Every path is now `lstat`ed component by component and refused if a parent is not a real directory (`UNSUPPORTED_ENTRY`); the outside content never entered the object store (A7). Restore writes have their own parent check (`safeTarget`); no test exercises it. A race between the check and the open is not closed (Node has no `openat`); an attacker who can write the folder can already read it, so this was left as a known limit.

### 5. Scope rule that worked

- In scope: every tracked file, plus untracked files that are not ignored and not default-excluded (`git add -A` semantics), plus `.drafttide.json` always, even if `.gitignore` lists it (E4).
- The default excludes (`node_modules`, caches, editor folders, `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.DS_Store`, logs…) only gate **new** untracked files. Tracked files are never dropped by a default, so a default can never turn into a silent deletion (A8). This matters more now that saves can leave the machine.
- `.gitignore` is honored. `.drafttide.json` adds `excludeDirNames` and `excludeFilePatterns`; they are passed to `git ls-files --exclude`, so Git's own matcher handles them and pathological patterns cannot stall a save (E3, 80 ms).
- 20,000 untracked files under `node_modules` did not change save time (116 vs 108 ms), so the excludes stop traversal (I2).

### 6. Repo forms to refuse in M1

All detected before anything is written, each with a stable reason. Shallow clone, linked worktree / submodule (`.git` is a file), sha256 object format, reftable, partial clone, sparse checkout, skip-worktree or assume-unchanged entries, gitlinks in the index, an untracked nested repo, a folder inside another repo (M1 requires root == repo root), detached HEAD, Git LFS attributes, `filter` / `ident` / `working-tree-encoding` attributes, and explicit `text` / `eol` attributes on a file that contains CR bytes (C1–C7). An in-progress merge or rebase and unmerged index entries are refused as **retryable** `REPO_BUSY` (B5, B6); cherry-pick, revert and bisect are detected the same way by their marker files but have no test. A `.git` that is a symlink, and a `.git` owned by another user, are also refused by the probe, but neither check was exercised.

Why line endings: with `*.txt text` and a CRLF file, saving raw bytes leaves `git status` reporting the file as modified; `text=auto` and `core.autocrlf=true` do not (Git keeps CRLF that is already in the index) (C7, C8). The refusal is narrow: only explicit conversion on a file that actually has CR.

### 7. Smaller results

- Partial staging (`git add -p`) intent is not preserved: after a save the index equals the committed tree. The staged-only content stays in the object store until Git prunes it (A2). Acceptable for a design repo; say so in the GUI only if it turns out to matter.
- Commits made by Draft Tide use a fixed identity (`Draft Tide <draft-tide@localhost>`) in the spike. **Decided:** the real product uses the signed-in GitHub user's identity with the noreply address (see the decisions above).
- Hooks never run for Draft Tide's commits, so an engineer's pre-commit formatter or lint does not apply to saves. Commits are unsigned, so a branch rule requiring signed commits would reject a push. **Accepted.**
- `refs/remotes/draft-tide/<branch>` is used for remote-tracking, so our bookkeeping does not collide with an existing `origin`.
- After a save the index has no stat data, so the next plain `git status` re-hashes files: 66–77 ms for 1,500 files / 12 MB.
- Unicode file names (CJK, spaces, emoji, NFC and NFD forms) save correctly and leave `git status` clean on APFS (A10). Execute-bit-only changes are real changes (A11).

## Timing (informational, one machine)

| Case | Result |
|---|---|
| 1,501 files, 12.3 MB, first save | 1.2–1.4 s |
| Same, nothing changed (`NO_CHANGES`) | 0.6–0.7 s |
| Same, one file edited | 0.6–0.7 s |
| External `git status` after a save | 66–77 ms |
| Small project save | about 0.1 s |

The no-change and one-edit cases are dominated by the full rescan and re-hash that the stable-capture rule requires. No memory or installer-size measurement was done.

## Not verified

- **Real GitHub.** Authenticated push/fetch/clone against github.com with an OAuth token, the `x-access-token` username convention, 2FA behaviour, rate limits, branch protection and GitHub's file and push size limits. `spikes/single-repo/src/github-check.ts` exercises this against a throwaway repo and deletes the one branch it creates; it needs `DT_GITHUB_URL` and `DT_GITHUB_TOKEN` and was not run.
- OAuth itself: which flow, which token type, token storage in the OS keychain, refresh and revocation. GitHub's documentation (read 2026-10-01) says the device flow needs no client secret but must be enabled in the app's settings, PKCE is supported for the web flow, and an OAuth App or classic PAT needs the `repo` scope to create a private repository. It does not say whether a GitHub App user token can create one; that has to be tried in M1-00. The `repo` scope covers all of a user's private repos, so a narrower option (the user picks an existing empty repo) should be weighed.
- A secret scan before the first push, and a large-asset policy (GitHub limits vs "no fixed quotas"; real Git LFS usage was only detected, never run: `git-lfs` is not installed here).
- Two designers editing concurrently, and what "explicit merge" means once directions exist.
- Tracked symlinks (refused as `UNSUPPORTED_ENTRY`, same as M0), empty directories (Git does not store them), case-only renames on a case-insensitive volume.
- Windows, Linux, and any Git other than 2.53.0 (dugite) and 2.54.0 (Apple).
- Two Engines or two writers of the same repo at once: one process was assumed, as in M0.
- The foreign-owner check (needs a repo owned by another user).

## Contract changes (applied 2026-10-01)

Written into `CLAUDE.md` and into `.ref/ROADMAP.md`, `.ref/M1_IMPLEMENTATION_PLAN.md` and `.ref/TECH_STACK.md`. `docs/safety-model.md`, `docs/m0-report.md` and `docs/compatibility.md` carry notes where they are superseded. The list below is what changed.

1. **Invariants.** Replace "the user's own repo is untouchable" with: Draft Tide manages the design repo; it never rewrites history (no rebase, reset, force-push, stash, checkout or clean), never runs the repo's hooks, filters, textconv or configured programs, and changes only HEAD's branch ref (compare-and-swap), the index (under `index.lock`), planned working files, and `.drafttide.json`.
2. **Truth.** History and raw bytes live in the project repo. The per-project bare repo in app-data, `.drafttide` backup/import and the app-repo handoff mode are removed. SQLite keeps bindings, approvals, plans and the journal; project identity and scope settings move into `.drafttide.json`.
3. **Operation state machine.** A `publishing` state between `verified` and `committed` carries the lock-first protocol and recovery rules from Finding 1; recovery runs at Engine start and before each write.
4. **Git backend.** Named operations only, now including `check-attr`, `ls-files`, `read-tree`, `update-index --index-info`, `write-tree`, `commit-tree`, `update-ref`, `merge-base --is-ancestor`, and network fetch/push through the ephemeral git dir. Never `status`, `diff`, `add`, `commit`, `checkout` or anything that applies filters.
5. **Error codes.** Added by the spike: `CONFIG_INVALID`, `REPO_UNSUPPORTED`, `REPO_BUSY`, `UNSAVED_CHANGES`, `AUTH_REQUIRED`, `REMOTE_DIVERGED`, `REMOTE_REJECTED`, `NETWORK_UNAVAILABLE`. `LOCKED` (already in M1 §11.1) now also means "another Git holds `index.lock`".
6. **Scope.** The rule in Finding 5; the config schema is in `spikes/single-repo/src/config.ts` (`schemaVersion`, `projectId`, `name`, `entryFiles`, `excludeDirNames`, `excludeFilePatterns`, unknown fields rejected).
7. **Roadmap.** Remote sync moves from M4 into M1 (sign-in skippable, save stays local-first); review and multi-designer merge stay in M4. M1-07 (backup/import) is replaced by sync work packages. Packaging: full Git with https.

## How to run

```bash
cd spikes/single-repo
../m0/core/node_modules/.bin/tsc -p .     # typecheck (reuses the M0 toolchain, nothing to install)
node src/verify.ts                        # everything
node src/verify.ts local hostile sync     # or a subset
SPIKE_TLS_CHECK=1 node src/verify.ts      # adds the read-only github.com TLS check
DRAFT_TIDE_GIT_ROOT=system node src/verify.ts   # use Apple's Git instead of dugite's
```

It needs the M0 core dependencies installed (`spikes/m0/core/node_modules`) for the dugite Git, and falls back to `/usr/bin/git`. Set `SPIKE_WORK=<dir>` to choose where fixtures go and `SPIKE_KEEP_WORK=1` to keep them. Results are written to `spikes/single-repo/results/` (git-ignored).
