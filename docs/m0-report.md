# M0 verification report

Date: 2026-09-30 · Machine: macOS 27.0.1, Apple Silicon (arm64) · Spike code: [`spikes/m0/`](../spikes/m0/README.md)

> **Follow-up (2026-10-01).** After this report the storage design was revisited: history now lives in the project's own Git repo and syncs to GitHub, with no separate bare repo and no backup/import ([single-repo-spike.md](single-repo-spike.md)). For M1, §1 (per-project bare Git), the backup and import results, and "the user's own repo is untouchable" are superseded. The raw-bytes strategy, the Engine, transport, approvals, Preview Host and packaging results stand.

M0 is the pre-implementation phase from ROADMAP §5 and the TECH_STACK §14 row "M0 / M1-00". This report records what was run, what passed and what is still open. The spike code is throwaway: it proves feasibility and is not the M1 implementation, and nothing here counts as data-safety acceptance for M1.

## Exit gate status

| M0 exit gate (ROADMAP §4) | Status | Evidence |
|---|---|---|
| Raw bytes, asset reuse and backup can be verified | **Pass** | Storage validation 31/31 in both capture modes and with the trimmed bundled Git ([benchmark.md](benchmark.md)) |
| The manual flow is understandable | **Open** | Clickable GUI prototype and facilitator script are ready ([manual-e2e.md](manual-e2e.md)); no session with a Git-inexperienced designer has been run yet |
| Install path can be verified | **Partial** | Unsigned `.app` / `.dmg` build, launched with an empty environment and from the read-only DMG; engine checks 16/16 against the packaged companion ([compatibility.md](compatibility.md)). Clean-machine, signing and notarization not done |
| Public agent entry has a verifiable path | **Partial** | MCP (official SDK client, stdio) and CLI JSON verified against the packaged build. The real-host smoke with Claude Code 2.1.284 is scripted but blocked: the headless host is not logged in ([agent-e2e.md](agent-e2e.md)) |

## What each M0 track did

### 1. Storage strategy: raw files directly in a per-project bare Git

`spikes/m0/core/src/storage/` implements the M1 §7.1 capture path (immutable staging → full rescan → objects from staged bytes → `commit-tree` → expected-old-OID `update-ref`), restore (§9.3 without the SQLite journal) and the `.drafttide` backup (ZIP with a Git bundle, manifest and scope policy). The fixture approximates an agent-made web design: 1,034 files, 29.3 MiB, HTML/CSS/JS/SVG/JSON plus PNG, JPEG and TTF. It then goes through 50 agent-style iterations, including 3 asset replacements, 1 asset addition, a rename, a delete, a CRLF edit and an exec-bit-only change.

- Every file of all 51 versions streams back byte-identical with the same mode (1.6 GiB verified), including CRLF, BOM, empty, exec-bit, no-trailing-newline and CJK/space file names.
- Each of the 60 binary asset paths is stored once per distinct content. A rename reuses the blob; a mode-only change reuses the blob.
- History for 51 versions is 47.2 MiB loose (41.6 MiB packed). Full copies would take 1,612 MiB. A text-only iteration adds about 45 KiB. Replacing an asset adds roughly that asset's size (compressed images do not delta).
- The backup alone restores all 51 versions byte-exact into a new empty folder and new history, keeps every snapshot and commit ID, and saving continues on top. Tampered bundles, path traversal, duplicate entries, truncated files and non-empty destinations are all refused.
- The designer's own `.git` is byte-identical after all saves and restores. It was seeded with hostile hooks, filters and `.gitattributes`, and the parent process had `GIT_DIR`, `GIT_CONFIG_PARAMETERS`, `GIT_TRACE` and `GIT_EXTERNAL_DIFF` set. No hook, filter or trace ran.
- Restore appends history (`pre-restore` → `restore`), never rewinds it, and protects unsaved work byte-exact. `PLAN_STALE`, `UNTRACKED_FILES`, `SOURCE_BUSY`, `NO_CHANGES`, symlink `UNSUPPORTED_ENTRY` and ref CAS behave as specified.

**Decision input for M1 (capture cost).** An fsync on every staged file costs about 2.5 s per save on this fixture, most of the 2.9 s strict-mode save. Staging is not a durability boundary: a crash before the ref update just discards it, and the ref is published only after the new Git objects are fsynced. The "fast" mode therefore skips staging fsync and hashes into Git only content Git does not already have. With that, a save takes 510 ms on average (p95 581 ms) and the baseline 1.4 s. `core.fsyncMethod=batch` was *slower* on APFS: 4.1 s versus about 1 s for 930 new objects. Suggested spec wording is in [benchmark.md](benchmark.md#recommendations).

### 2. Packaging: Electron + companion Node + SQLite + Git

`spikes/m0/desktop` produces `Draft Tide M0.app` (425 MB) and a DMG (160 MB) with Electron 44.5.1 and Electron Forge 7.11.2, with no Forge Vite plugin. The companion (Engine, CLI and MCP) runs on a bundled Node 24.18.1, never Electron's Node 24.21.0. better-sqlite3 13 loads only there, from its N-API prebuild (no compile step). Git is a 3.2 MiB trimmed `git` from dugite-native 2.53.0, cut down from the 148 MiB tarball, and passes every storage operation. Fuses are set with RunAsNode, NODE_OPTIONS and inspect off, ASAR integrity on, and file-protocol privileges off. The GUI prototype runs sandboxed over `app://` with a one-function preload bridge.

### 3. Engine bootstrap, single writer, CLI and MCP

- **Single writer.** A crash-safe single instance comes from an EXCLUSIVE lock on `runtime/engine.lock.sqlite`, an OS lock that is released when the process dies. In a race, 12 cold-start clients reached exactly one Engine. After `kill -9`, the next client took over in 186–258 ms without any pid guessing.
- **Transport.** Length-framed JSON goes over a 0600 Unix socket in a 0700 runtime directory. The handshake rejects a protocol mismatch without starting a second Engine, and a forged desktop token gets `UNAUTHENTICATED`. The Engine exits on its own when idle.
- **CLI and MCP.** The CLI (`--json` prints exactly one envelope line) and the MCP stdio server (8 tools, and no approve, shell or git tool) go through the same Engine. A restore needs a desktop decision. `confirmed: true` or `force` from the caller, another caller's apply, a replay, a denial and a stale approval are all refused.

### 4. Preview Host isolation

The app executable relaunches itself with `--dt-preview-host`, with no tokens or data dir in its environment. It renders a read-only snapshot workspace offscreen through `dt-preview://` in an ephemeral session. External, loopback, private-net, `file://` and `app://` fetches are blocked, and traversal returns 403/404. Popups, navigation, service workers and geolocation are denied. Renderer globals (`require`, `process`, the bridge) are absent. A 1280×800 capture takes about 1.6 s including process start.

### 5. Interface and authorization design

See [safety-model.md](safety-model.md). The tool channel has no approve or bind operation. Approvals are desktop decisions bound to operation, caller kind, project, kind, plan fingerprint and expiry, and each is consumed once in a SQLite transaction. **Known M0 gap:** the desktop credential is a 0600 file, which is not a boundary against same-user code. M1-00 must replace it with OS-verified peer identity.

### 6. GUI prototype

`spikes/m0/gui` is a React 19 + Vite 8 + Tailwind 4 clickable prototype using example data. It covers the start screen, scope review, version cards, compare, restore with plan, protection, progress and result, the `PLAN_STALE` / `UNTRACKED_FILES` states, backup and import, and settings and diagnostics. It shows live Engine status when hosted in the Electron spike.

## Bugs M0 found (fixed in the spike, relevant to M1 tests)

1. The blob reader deadlocked when the last chunk of a blob hit sink backpressure: `drain` never fires after `end()`. M1 needs the streaming and backpressure tests from M1 §13.1.
2. A truncated `.drafttide` escaped the error mapping instead of returning `BACKUP_INVALID`.
3. The optimistic capture can legitimately land between two writes of a busy file. The `SOURCE_BUSY` test needs a continuous writer to be deterministic.
4. Twice, the engine check counted two Engines, although every client reached the same instance. The harness was counting Engines from other data dirs that were still in their idle window. Scoping the count to the test's data dir fixed it: packaged 16/16 on three consecutive runs, dev 16/16. M1 crash tests should identify Engines by data store, not by executable path.

## Proposed contract additions

Error codes the spike needed that M1 §11.1 lacks:
- `HISTORY_CHANGED`: ref CAS lost.
- `PROTOCOL_MISMATCH`: incompatible client, Engine or storage schema.
- `UNAUTHENTICATED`: failed handshake.
- `UNKNOWN_OPERATION`: operation not offered on this channel.

## Open items carried into M1-00

- Run at least 3 manual sessions with designers who have no Git experience, using the prototype and [manual-e2e.md](manual-e2e.md).
- Real agent host smoke: `claude` logged in for headless use, then `node spikes/m0/core/src/agent/claude-code-smoke.ts`, or pick another public host.
- Desktop enrollment and peer verification (see [safety-model.md](safety-model.md#open-for-m1-00)); approval caller identity per host enrollment rather than per client kind.
- Developer ID signing, hardened runtime entitlements for the bundled Node (JIT), notarization, clean-machine install and uninstall.
- Git GPL-2.0 notices and source offer, plus Node and Electron third-party notices in the artifact manifest.
- Windows: named pipe, SQLite `LockFileEx` lock and Squirrel packaging are untested.
- Engine memory needs its own benchmark: the harness process RSS of 420–460 MiB includes harness data; the Engine itself used 94–101 MiB.
- Installer size: Node (128 MB) is the second largest item after Electron (287 MB).
