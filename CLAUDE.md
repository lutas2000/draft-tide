# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Draft Tide ("Version history for your designs") is a local-first design version control tool for designers. It is **pre-implementation**. M0 feasibility work has been done, but M1 has not started: there is no root `package.json` or pnpm workspace and no product code under `apps/` or `packages/`. Don't invent commands. Once the workspace exists, read the real scripts from `package.json`.

- `spikes/m0/` holds **throwaway** M0 spike code: `core/`, `gui/` and `desktop/`, each a standalone pnpm package run through `corepack pnpm`. Commands are in `spikes/m0/README.md`. Don't grow it into M1, and don't import from it; copy ideas deliberately.
- `docs/m0-report.md` records the M0 results, open items and the findings M1 must absorb. Details are in `docs/benchmark.md`, `docs/compatibility.md`, `docs/safety-model.md`, `docs/agent-e2e.md` and `docs/manual-e2e.md`.

The specs live in `.ref/`, which is **gitignored and local-only**. They are written in Traditional Chinese:
- `.ref/ROADMAP.md`: milestones M0–M5 and their exit gates
- `.ref/M1_IMPLEMENTATION_PLAN.md`: the v0.1 local alpha scope, work packages M1-00…M1-09, CLI/MCP contracts, error codes and release checklist
- `.ref/TECH_STACK.md`: process architecture, storage, packaging and the dependency list
- `.ref/brand.md`: name and tagline ("Let ideas flow. Keep every draft.")

Read the relevant section before implementing anything. When a product or safety contract changes, update all three main docs together (the docs require this). Everything in them is a proposal, not an existing feature.

## Planned stack and toolchain

TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) with ESM sources. The rest of the stack:
- Desktop: Electron with a React + Vite GUI, shadcn/ui, Tailwind and TanStack Query.
- Runtimes: the Engine, CLI and MCP server run on a **bundled Node LTS companion**, not on Electron's Node.
- Storage: SQLite through better-sqlite3, Zod for contracts (exported to JSON Schema, with branded IDs), and Commander for the CLI.
- Agent integration: the official MCP TypeScript SDK over stdio.
- Diffs and backups: jsdiff, plus yazl/yauzl for backups.
- Build: pnpm workspace; `tsc` for type checking, Vite for the GUI, esbuild for main/preload/Engine/CLI/MCP; ESLint (typescript-eslint) and Prettier; Electron Forge for DMG/Squirrel packaging, not Forge's Vite plugin; Changesets for versioning.
- Tests: Vitest with fast-check, integration tests against real Git, filesystem and SQLite (not mocks), and Playwright for Electron GUI E2E.

Add a dependency only when a verified feature needs it.

## Architecture: one Engine, many clients

```
React GUI → restricted preload → Electron Main ─┐
CLI  → engine-client ───────────────────────────┼─ local Engine (only writer)
MCP stdio → engine-client ──────────────────────┘    ├ core use cases / operation state machine
Skill guides external agents to CLI/MCP              ├ git-backend (per-project bare repo)
                                                     ├ adapter-filesystem (scope, capture, write-back)
                                                     ├ local-store (SQLite, journal)
                                                     └ preview supervisor → isolated Preview Host
```

Planned layout: `apps/desktop`, `apps/companion`, `packages/{contracts,core,git-backend,adapter-filesystem,local-store,engine-client}`, `skills/draft-tide/SKILL.md`, `fixtures/`, `docs/`. Split out a package only when publishing or isolation needs it.

Invariants that span modules:
- **Single writer.** The Engine is the only process that writes design data or SQLite. It is started on demand, and a cross-process startup lock plus handshake keeps it to one Engine per data store. Per-project write guards serialize writes. GUI, CLI and MCP never open the DB, never run a writable core in-process, and never shell out to Git.
- **Core stays pure.** It receives ports and never imports Electron, React, the MCP SDK, better-sqlite3, providers or model SDKs.
- **Transport.** Clients use length-framed JSON over a Unix socket or Windows named pipe. There is **no HTTP control port** in production.
- **Where truth lives.** Each project's bare Git repo in app-data owns history and raw bytes. Every snapshot is a full-tree commit, and metadata goes in canonical JSON inside the commit message. SQLite owns bindings, scope policy, plans, approvals and the operation journal; it is **not a cache**. Only the history index, diffs, preview metadata and thumbnails are rebuildable. No LFS and no second asset store.
- **The user's own repo is untouchable.** Never change their `.git`, HEAD, refs, index, config or hooks, and never use checkout, stash or clean. Restore rewrites only planned working files.
- **Git hygiene.** Git goes through named backend operations (writeBlob, writeTree, createCommit, updateRef with expected-old-OID, bundle…). Calls use spawn with argument arrays and a sanitized env, with hooks, filters, textconv and external diff disabled. There is no passthrough and no arbitrary revision expressions.
- **Approvals.** Only the trusted desktop confirmation channel can produce them. CLI and MCP can only *request* approval and poll status; `--yes`, `--force` or `confirmed: true` never count. A receipt is bound to caller, project, operation kind, plan fingerprint and expiry, and is consumed once.
- **Restore appends history.** A restore adds a pre-restore protection commit and a restore commit; it never rewinds HEAD. Operations move through `planned → confirmed → preflight → protected → staged → applying → verified → committed → completed` (or `recovery-required`). Crash recovery matches by operationId and resultingCommit, never by guessing.
- **Capture.** Files stream into immutable staging, then a full rescan checks stability (up to 3 retries before `SOURCE_BUSY`). Git objects come only from staged bytes, and an unchanged tree returns `NO_CHANGES`.
- **No fixed quotas.** Don't cap project size, file size, file count or version count. Use bounded streams, disk-space preflight, progress and recoverable errors. Diff, preview and import budgets must never exclude original files from a save.
- **Preview isolation.** The Preview Host is a separate process with a sandboxed, context-isolated renderer, no Node or preload, an ephemeral session, and a custom protocol with an allowlist (no `file://`). Network is blocked. A failed preview never undoes a save.
- **Machine output.** CLI and MCP stdout carry protocol data only; diagnostics go to stderr. Use the JSON envelope `{schemaVersion, ok, data, warnings, error{code,message,details,retryable}}`, with stable error codes defined once in `contracts` (see M1 plan §11.1).
- **Commit metadata** must never include absolute paths, prompts, keys or approval secrets.

## Product rules that shape code

- Every user-facing feature needs a GUI path; no CLI-only or agent-only features. Manual use must work offline without an agent, account or API key.
- GUI copy uses designer terms such as "保存版本" (save version) and "回復到此版" (restore this version). Show snapshot UUIDs and Git OIDs only in details or diagnostics. Show a completed restore only after the Engine reports verified or completed state, not optimistically.
- M1 scope: generic filesystem source, a single `main` line, manual saves only, and previews of self-contained HTML/CSS/JS plus PNG/JPEG. Branches/directions, pixel diff and autosave come in M2; source adapters in M3; remotes in M4.
