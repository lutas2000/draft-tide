# M1-01: contracts, Engine and app skeleton

Date: 2026-10-01 · Machine: macOS 27.0.1, Apple Silicon (arm64), Node 24.18.1 · Work package: M1-01 ([M1 plan §12](../.ref/M1_IMPLEMENTATION_PLAN.md))

M1-01 delivers the skeleton every later work package plugs into: the contracts, core with its ports, the SQLite store with migrations, the Engine with its client, CLI and MCP entry points, the desktop shell with a GUI you can launch, and CI. It saves nothing yet. Binding folders and saving arrive with M1-02 to M1-04.

## Can M1-01 start? (checked 2026-10-01)

M1-01 depends on M1-00. These M1-00 items are done: raw bytes into the project's own repo (single-repo spike), Electron and companion packaging, the SQLite addon and Engine election (M0), desktop identity (desktop-auth spike, re-verified with a Developer ID), and the preview and agent fixtures (M0).

Still open:
- GitHub sign-in: the flow, the token type and scope.
- Token custody: the keychain item, and whether the Engine becomes a Node SEA.
- A real GitHub round trip (`spikes/single-repo/src/github-check.ts` has not been run).
- Measuring the full Git build that includes https.

None of these is needed by the skeleton. They block M1-07 (remote sync), which lists M1-00 as a direct dependency, and M1-09 (release). If the Engine does become a SEA, only `engineLaunch()` and the packaging change: the Engine is already a single esbuild bundle.

## What was built

| Module | Contents |
|---|---|
| `packages/contracts` | Branded lowercase-UUID IDs. The error catalog (the §11.1 codes plus three new ones, below) with `DtError`. The result envelope and the exit-code and MCP `isError` mapping. The strict `.drafttide.json` parser. Snapshot metadata, operation states, canonical JSON, the Engine protocol messages and the **operation catalog**. `build` exports 18 JSON Schemas and fails if one can't be represented |
| `packages/core` | Ports (`Clock`, `LocalStore`, `EventSink`, `EngineIdentity`). `authorize()`, the channel and agent-access policy. `createEngineCore()`, the one dispatcher every channel goes through: it authorizes, then parses the input strictly, then runs the use case, then checks the result against the catalog |
| `packages/local-store` | better-sqlite3 with WAL, `synchronous = FULL` and foreign keys. Append-only migrations, each in its own transaction, and a consistent backup before migrating an existing database. Refuses a newer schema, an unknown migration history or a corrupt file without writing to it. The agent-access setting reads as off when missing or unreadable. Also the single-Engine lock (an EXCLUSIVE SQLite lock, as verified in M0) |
| `packages/engine-client` | Runtime paths: the socket falls back when `sun_path` would overflow, and Windows uses a named pipe. Length-framed JSON. The handshake (a tool token, or the desktop nonce echo). Connect-or-start with a from-scratch environment and `--disable-sigusr1`. Sequenced events with gap detection |
| `apps/companion` | The Engine: lock, private runtime directory, 0600 socket and discovery file, sessions, idle exit, a diagnostics log. The desktop handshake pins the peer instance (T0) at hello, accepts the nonce only from that instance, and re-checks every later message. The `peer-identity` N-API addon (macOS, ported from the spike). The `draft-tide` CLI (Commander) and the MCP stdio server, whose tools are generated from the catalog |
| `apps/desktop` | Main refuses debugging switches before anything else runs. GUI served over `app://` with a CSP. One window, no navigation, popups, webviews or permissions. Sandboxed preload exposing five functions. The React GUI uses the M0 prototype's tokens, shadcn-style components on Radix and TanStack Query. Three screens: projects, account and sync, settings and diagnostics. The agent-access switch works end to end |
| CI | Format, lint (including module-boundary rules) and typecheck. Tests on macOS, Linux and Windows. Desktop build and GUI E2E on macOS |

### Operations in the catalog

| Operation | Desktop | Tool channel (CLI, MCP) |
|---|---|---|
| `engine.info` | yes | always, even with agent access off |
| `project.list` | yes | only with agent access on |
| `agentAccess.get` / `agentAccess.set` | yes | not offered (`UNKNOWN_OPERATION`) |

Later work packages add their operations to the catalog. The CLI commands, MCP tools, the Engine dispatcher and the GUI's typed bridge all follow from it.

## Decisions taken here

- **New error codes.** `ENGINE_UNAVAILABLE` (retryable): the Engine isn't running or didn't start; M0 overloaded `LOCKED` for this. `INVALID_ARGUMENT`: input outside the contract. `INTERNAL_ERROR`: anything that isn't a `DtError`, where M0 used `STORAGE_IO_FAILED`. Written into M1 plan §11.1.
- **Exit codes and no-op.** 0 ok, 1 failed, 2 usage (`INVALID_ARGUMENT`), 3 no-op (`NO_CHANGES`). A no-op is still `ok: false` in the envelope, but MCP doesn't set `isError` for it. All of this is derived from the envelope in `contracts`.
- **Self-asserted flags are refused, not ignored.** Inputs are strict objects, so `confirmed: true` or `force: true` gets `INVALID_ARGUMENT`. The MCP SDK may strip unknown keys before the call; the Engine is the one that enforces.
- **Desktop identity per build.**
  - The release requirement (identifier, team and the Developer ID markers) is compiled into the Engine bundle. No environment variable, argument or file can set or relax it.
  - Development builds skip the signature check, and `engine.info` reports `desktopIdentity: "development"`. On macOS they still pin the peer instance through the addon, so the handshake path is exercised.
  - E2E builds (`dist-e2e/`) alone let Main accept debugging switches, because Playwright needs them. They are never shipped.
- **Toolchain.**
  - TypeScript 6.0.3: typescript-eslint 8.71 supports only `<6.1`. The spikes used 7.0.
  - Sources import with explicit `.ts` extensions and erasable syntax only, so Node 24 runs them directly. The integration tests spawn the Engine from source.
  - Root scripts call `corepack pnpm`, which works without `corepack enable`.

## How to run

```bash
corepack pnpm install
corepack pnpm run check          # format, lint, typecheck, build, unit + integration tests
corepack pnpm --filter @draft-tide/desktop run test:e2e   # Electron GUI E2E (macOS)
corepack pnpm run desktop        # build and launch the app
node apps/companion/dist/cli.mjs --json engine info
```

`DRAFT_TIDE_DATA_DIR` points every component at another data store, and each store gets its own Engine. `DRAFT_TIDE_ENGINE_IDLE_MS` shortens the Engine's idle exit for tests.

## Results (this machine)

| Suite | Result |
|---|---|
| `corepack pnpm run check` | format, lint, typecheck and build clean; **84/84** tests |
| Contracts | 42: catalog completeness, the envelope and exit codes, `.drafttide.json` rejections, a property round-trip and path safety, strict protocol messages, canonical JSON, JSON Schema export |
| Core | 8: a property test of `authorize()` over every operation, channel and switch state. The tool channel can't flip the switch whatever it sends. Events fire on real changes only. Results outside the contract (for example a leaked token field) become `INTERNAL_ERROR` |
| Local store | 10: WAL and schema version. The switch survives a reopen, and an unreadable value reads as off. A newer schema, an unknown history and a corrupt file are each refused with the file's bytes unchanged. A failed migration rolls back after the backup is written. The lock takes over after a holder is killed with `kill -9` |
| Engine client | 6: framing under every split (property), the oversize and bad-UTF-8 refusals, the socket and pipe paths |
| Companion | 18 (real Engine processes): private runtime files; 8 racing cold starts reach one Engine; replacement after `kill -9`; idle exit; the switch takes effect across channels at once and survives a restart; bad and missing tokens, protocol mismatch and requests before hello are rejected; the tool channel can't reach desktop operations. **macOS pinning:** a nonce echoed by another process is refused (spike A10), and a verified session is closed when another process writes to it. A control asserts pinning was active. Also the CLI envelope and exit codes, and MCP tools and annotations through the same Engine |
| Desktop E2E | 7 (Playwright, Electron 44.5.1): the GUI connects to the Engine; the renderer has no `require` or `process` and exactly the five bridge functions; Main refuses non-desktop operations and self-asserted flags; the switch needs confirmation and the CLI follows each change; Main exits on `--remote-debugging-port`, `--remote-debugging-pipe` and `--js-flags` |

## Known limits and follow-ups

- **Not verified here.** Windows and Linux: CI runs them, but this machine didn't. The Windows named-pipe ACL and desktop identity are still unverified (CLAUDE.md). A release build: no Developer ID run of the M1 Engine yet; the spike already did that.
- **Startup failures are invisible to the GUI.** When the Engine can't open its state (corrupt or newer database), it logs to `diagnostics/engine.log` and exits. The GUI only shows "can't connect". Doctor and recovery (M1-05) should surface this.
- **SQLite errors outside open.** A SQLite error inside an operation reports as `INTERNAL_ERROR`, not `STORAGE_IO_FAILED`.
- **Not yet built.** Idempotent replay of mutating requests (needs the journal, M1-05). Operation status and cancel. GUI-only request operations (`CONFIRMATION_REQUIRED` plus an operationId). Recovery at Engine start: there is a marked spot in `apps/companion/src/engine/main.ts`.
- **CLI and MCP launch flags.** They run with `--disable-sigusr1` only once the product launcher exists (M1-09). The Engine already gets the flag from every client that starts it.
- **Not set up yet.** No packaging, signing, fuses, bundled Node or Git (M1-09). No Changesets.
