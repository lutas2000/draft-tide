# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Draft Tide ("Version history for your designs") is a local-first design version control tool for designers. It is **pre-implementation**. M0 feasibility work has been done, but M1 has not started: there is no root `package.json` or pnpm workspace and no product code under `apps/` or `packages/`. Don't invent commands. Once the workspace exists, read the real scripts from `package.json`.

- `spikes/m0/` holds **throwaway** M0 spike code: `core/`, `gui/` and `desktop/`, each a standalone pnpm package run through `corepack pnpm`. Commands are in `spikes/m0/README.md`. Don't grow it into M1, and don't import from it; copy ideas deliberately. It was built on the older design (a separate bare repo per project, backup/import), so its storage code and the GUI prototype's backup/import screens are superseded for M1.
- `spikes/single-repo/` is a second **throwaway** spike (48 checks) that validated the design now adopted: history lives in the project's own Git repo and syncs to GitHub. Same rules: don't grow it into M1, don't import from it. Run it with the commands in its README.
- `docs/single-repo-spike.md` is the evidence and the findings M1 must absorb. `docs/m0-report.md` records the M0 results and open items. Details are in `docs/benchmark.md`, `docs/compatibility.md`, `docs/safety-model.md`, `docs/agent-e2e.md` and `docs/manual-e2e.md`; those M0 records carry a note where the single-repo design supersedes them.

The specs live in `.ref/`, which is **gitignored and local-only**. They are written in Traditional Chinese and were revised on 2026-10-01 for the single-repo design:
- `.ref/ROADMAP.md`: milestones M0–M5 and their exit gates
- `.ref/M1_IMPLEMENTATION_PLAN.md`: the v0.1 local alpha scope, work packages M1-00…M1-09, CLI/MCP contracts, error codes and release checklist
- `.ref/TECH_STACK.md`: process architecture, storage, packaging and the dependency list
- `.ref/brand.md`: name and tagline ("Let ideas flow. Keep every draft.")

Read the relevant section before implementing anything. When a product or safety contract changes, update all three main docs together (the docs require this), then this file. Everything in them is a proposal, not an existing feature.

## Planned stack and toolchain

TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) with ESM sources. The rest of the stack:
- Desktop: Electron with a React + Vite GUI, shadcn/ui, Tailwind and TanStack Query.
- Runtimes: the Engine, CLI and MCP server run on a **bundled Node LTS companion**, not on Electron's Node.
- Storage: SQLite through better-sqlite3, Zod for contracts (exported to JSON Schema, with branded IDs), and Commander for the CLI.
- Agent integration: the official MCP TypeScript SDK over stdio.
- Diffs: jsdiff.
- Remote sync: the bundled **full** Git (with `git-remote-https`) over https, GitHub sign-in whose flow and token type are decided in M1-00, and the token in the OS keychain. No Git library, and no backup container (yazl/yauzl are dropped).
- Build: pnpm workspace; `tsc` for type checking, Vite for the GUI, esbuild for main/preload/Engine/CLI/MCP; ESLint (typescript-eslint) and Prettier; Electron Forge for DMG/Squirrel packaging, not Forge's Vite plugin; Changesets for versioning.
- Tests: Vitest with fast-check, integration tests against real Git, filesystem and SQLite (not mocks), and Playwright for Electron GUI E2E.

Add a dependency only when a verified feature needs it.

## Architecture: one Engine, many clients

```
React GUI → restricted preload → Electron Main ─┐
CLI  → engine-client ───────────────────────────┼─ local Engine (only writer)
MCP stdio → engine-client ──────────────────────┘    ├ core use cases / operation state machine
Skill guides external agents to CLI/MCP              ├ git-backend (the project's own repo)
                                                     ├ adapter-filesystem (scope, capture, write-back)
                                                     ├ local-store (SQLite, journal, sync queue)
                                                     ├ remote provider (GitHub sign-in, repo management)
                                                     └ preview supervisor → isolated Preview Host
```

Planned layout: `apps/desktop`, `apps/companion`, `packages/{contracts,core,git-backend,adapter-filesystem,local-store,remote-github,engine-client}`, `skills/draft-tide/SKILL.md`, `fixtures/`, `docs/`. Split out a package only when publishing or isolation needs it (`remote-github` can start inside the companion).

Invariants that span modules:
- **Single writer.** The Engine is the only process that writes design data or SQLite. It is started on demand, and a cross-process startup lock plus handshake keeps it to one Engine per data store. Per-project write guards serialize writes. GUI, CLI and MCP never open the DB, never run a writable core in-process, and never shell out to Git.
- **Core stays pure.** It receives ports and never imports Electron, React, the MCP SDK, better-sqlite3, providers or model SDKs.
- **Transport.** Clients use length-framed JSON over a Unix socket or Windows named pipe. There is **no HTTP control port** in production.
- **Where truth lives.** The project's own Git repo (the project folder's `.git`) owns history and raw bytes. It is a *design repo*: Draft Tide manages it, engineers only read it. Every snapshot is a full-tree commit on the checked-out branch, and metadata goes in canonical JSON inside the commit message. Project identity and settings (projectId, entry files, extra excludes) live in `.drafttide.json` at the repo root, inside the tree, and are **untrusted input** (strict schema, `CONFIG_INVALID` on anything unsafe). SQLite owns local bindings, remote bindings, plans, the agent-access setting, the operation journal and the sync queue; it is **not a cache**. Only the history index, diffs, preview metadata and thumbnails are rebuildable. No LFS, no second asset store, and no second copy of history (no app-data bare repo, no backup container).
- **Draft Tide manages the design repo, within limits.** It may change only: the checked-out branch's ref (compare-and-swap on the expected old OID), the index (under `index.lock`), planned working files, `.drafttide.json`, temp index files and objects inside `.git`, and `refs/remotes/draft-tide/*`; `remote.origin.*` only after the user confirms connecting a remote. It never rewrites history (no rebase, reset or force-push), never calls the porcelain commands checkout, stash, clean, merge, add, commit, status or diff (plumbing only, e.g. commit-tree), never runs the repo's hooks, filters, textconv or configured programs, never signs, and leaves the user's other branches, tags, stash, config and hooks alone. It refuses repo forms it cannot handle safely (shallow, linked worktree, submodule, LFS, detached HEAD, merge or rebase in progress, `text`/`eol` attributes on files with CR…) before writing anything.
- **Git hygiene.** Git goes through named backend operations (hash-object `--no-filters`, temp index, write-tree, commit-tree, update-ref with expected-old-OID, ls-files, check-attr, merge-base, fetch/push…). Calls use spawn with argument arrays, explicit `--git-dir`/`--work-tree` and a from-scratch env. **Local operations** override the repo's config on the command line (hooks path, fsmonitor, attributes/excludes files, autocrlf, signing, auto gc…). **Network operations never read the project's Git config**: a repo's `url.*.insteadOf` or `http.proxy` can redirect traffic and steal the token, and multi-valued keys cannot be cancelled with `-c`. They run in an ephemeral empty git dir with `GIT_OBJECT_DIRECTORY` pointing at the project's objects, `GIT_ALLOW_PROTOCOL=https`, and credentials through a 0600 askpass file. The bundled Git must be a full build with `git-remote-https` (M0's trimmed build has none). No passthrough, no arbitrary revision expressions.
- **Agent access is consent; there are no approvals.** One global switch in the trusted GUI, off by default. When it's on, CLI and MCP (treated the same) may operate on every bound project without per-operation confirmation. With it off, the tool channel gets only `engine.info` and the handshake; everything else returns `AGENT_ACCESS_DISABLED`.
  - **Agent-runnable when on.** Local, recoverable operations: query, save, compare, restore, pull (fast-forward only), recovery apply, and open-from-remote into a missing or empty folder. Anything that writes working files stays plan → apply, and apply re-checks access, HEAD and the fingerprint (`PLAN_STALE`).
  - **GUI-only.** Binding a new folder (scope review), GitHub sign-in, connecting a remote and the first push. The tool channel can only *request* these (`CONFIRMATION_REQUIRED` plus an operationId; a user decline is `APPROVAL_DENIED`), and `--yes`, `--force` or `confirmed: true` never count.
  - **Visibility.** Agent restores and pulls show up as GUI notices and carry their source in history.
  - **Accepted risk.** A misled agent can restore without asking. Protection versions keep the data. There are no approval receipts or approve actions.
  - **Sync.** After the user authorizes syncing a project, background pushes need nothing further (they write no working files).
- **Restore appends history, and publishing is lock-first.** A restore adds a pre-restore protection commit and a restore commit; it never rewinds HEAD. Operations move through `planned → confirmed → preflight → protected → staged → applying → verified → publishing → committed → completed` (or `recovery-required`). `publishing` means: take `.git/index.lock` (fail with `LOCKED` before changing anything), compare-and-swap the ref, atomically rename the prebuilt index in, release the lock. Moving the ref first would leave a stale index in which someone else's plain `git commit` silently re-commits the old tree (measured in the spike). Crash recovery matches by operationId and resultingCommit, removes only its own lock, never guesses, and runs at Engine start and before every write.
- **Capture and scope.** Files stream into immutable staging, then a full rescan checks stability (up to 3 retries before `SOURCE_BUSY`). Git objects come only from staged bytes, and an unchanged tree returns `NO_CHANGES`. Scope follows `git add -A` semantics: tracked files are always in; new files are in unless `.gitignore` or the default excludes (secrets, caches…) drop them, and defaults never remove a tracked file; `.drafttide.json` is always in. Every path Git hands over has its parent directories checked (an index path can run through a symlink to outside the project).
- **Remote sync is local-first and fast-forward only.** Saving never waits for the network; push and pull are separate operations. No `+` refspec, no force-push: if both sides have new versions the result is `REMOTE_DIVERGED` and nothing changes on either side. GitHub sign-in is skippable and happens only in the trusted GUI. The token lives only in the Engine (OS keychain) and never appears in argv, `.git`, SQLite plaintext, logs, commit metadata, the tool channel or the Preview Host. Before the first push the GUI shows what will be pushed and its visibility (private by default); pushed history cannot be taken back by the tool.
- **Commit identity.** The signed-in GitHub user's display name with their `ID+USERNAME@users.noreply.github.com` address; before sign-in a fixed "Draft Tide" identity; never the private email or the global Git identity. Draft Tide's commits run no hooks and are unsigned (accepted): an engineer's pre-commit formatter does not apply to saves, and a remote rule that requires signatures makes the push fail with `REMOTE_REJECTED`.
- **No fixed quotas.** Don't cap project size, file size, file count or version count. Use bounded streams, disk-space preflight, progress and recoverable errors. Diff and preview budgets must never exclude original files from a save. A remote's limits (GitHub blocks files over 100 MiB) only affect pushing and never block saving.
- **Preview isolation.** The Preview Host is a separate process with a sandboxed, context-isolated renderer, no Node or preload, an ephemeral session, and a custom protocol with an allowlist (no `file://`). Network is blocked. A failed preview never undoes a save. Screenshots live only in the local rebuildable cache, never in the design repo. Capture control (viewport emulation, full-page shots) uses in-process CDP through `webContents.debugger` inside the Preview Host, never a remote-debugging port; Playwright is a dev/CI tool only.
- **Machine output.** CLI and MCP stdout carry protocol data only; diagnostics go to stderr. Use the JSON envelope `{schemaVersion, ok, data, warnings, error{code,message,details,retryable}}`, with stable error codes defined once in `contracts` (see M1 plan §11.1).
- **Commit metadata** must never include absolute paths, prompts, keys, the GitHub token or Engine connection tokens. The only personal data is the display name and noreply address of the commit identity.

## Product rules that shape code

- Every user-facing feature needs a GUI path; no CLI-only or agent-only features. Manual use must work offline without an agent, account or API key.
- GUI copy uses designer terms such as "保存版本" (save version) and "回復到此版" (restore this version). Show snapshot UUIDs and Git OIDs only in details or diagnostics. Show a completed restore only after the Engine reports verified or completed state, not optimistically.
- M1 scope: generic filesystem source, a single line (the checked-out branch, `main` for new projects), manual saves only, previews of self-contained HTML/CSS/JS plus PNG/JPEG (entry page side by side at a fixed viewport), and skippable GitHub sign-in with fast-forward-only sync and open-from-remote. M2 brings branches/directions, autosave, and per-page visual comparison. That comparison ranks pages > DOM regions > images > line diff and uses viewport presets from `.drafttide.json`. It renders only the pages a change affects, found through a per-page dependency map (ROADMAP §7.2, TECH_STACK §10.4). Don't build any of it in M1. Source adapters come in M3; multi-designer collaboration (divergence handling, review) in M4. Engineers are read-only users of the design repo; there is no application-repo handoff and no backup/import.
