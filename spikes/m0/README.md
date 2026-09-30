# M0 spikes

This is throwaway feasibility code for the M0 phase (ROADMAP §5, TECH_STACK §14). It is **not** the M1 implementation: no package here maps to the planned `apps/`/`packages/` layout, and nothing here counts as data-safety acceptance. Results and conclusions are in [`docs/m0-report.md`](../../docs/m0-report.md).

The spike has three standalone pnpm packages, with no workspace. pnpm 12 runs through corepack:

| Dir | What |
|---|---|
| `core/` | Storage strategy (capture, bare Git, restore, `.drafttide` backup), Engine (lock, socket, SQLite), CLI, MCP server, companion build, agent harness |
| `gui/` | Clickable React + Vite + Tailwind prototype with example data |
| `desktop/` | Electron 44 shell + Preview Host + Forge packaging (DMG/ZIP) |
| `skill/draft-tide/SKILL.md` | Agent Skill used by the host experiment |

## Run

```bash
cd spikes/m0/core && corepack pnpm install
```

`corepack pnpm install` also downloads dugite-native Git (checksum-pinned, via `allowBuilds`). Then:

```bash
corepack pnpm typecheck
```

Storage validation (31 checks; about 1–4 min; writes `results/storage-*.json`):

```bash
M0_CAPTURE_MODE=fast corepack pnpm storage
```

`M0_CAPTURE_MODE=strict` fsyncs every staged file; `DRAFT_TIDE_GIT_ROOT=$PWD/build/git` uses the trimmed Git; `M0_ITERATIONS` defaults to 50.

Engine, CLI and MCP validation against the dev sources (16 checks):

```bash
corepack pnpm engine:verify
```

Build the companion payload (bundled Node, trimmed Git, `cli.mjs`/`engine.mjs`, and the GUI if `gui/dist` exists) into `core/build/`:

```bash
cd ../gui && corepack pnpm install && corepack pnpm build
cd ../core && corepack pnpm build:companion
```

Package the desktop app. Forge calls `pnpm` directly, so it must be on `PATH` (for example a shim running `corepack pnpm "$@"`):

```bash
cd ../desktop && corepack pnpm install && corepack pnpm make
```

The output is `out/Draft Tide M0-darwin-arm64/Draft Tide M0.app` and `out/make/*.dmg`. Opening the app shows the prototype. Setting `DRAFT_TIDE_SMOKE_OUT=<dir>` runs the scripted smoke instead: renderer isolation probe, Engine info, Preview Host with an attack page, and screenshots.

Engine checks against the packaged companion:

```bash
cd ../core
R="../desktop/out/Draft Tide M0-darwin-arm64/Draft Tide M0.app/Contents/Resources"
M0_LABEL=packaged M0_CLI_NODE="$R/node/bin/node" M0_CLI_ENTRY="$R/companion/cli.mjs" \
  M0_ENGINE_MATCH="$R/companion/engine.mjs" M0_ENGINE_NODE="$R/node/bin/node" \
  M0_ENGINE_ENTRY="$R/companion/engine.mjs" corepack pnpm engine:verify
```

Agent host experiment. It needs a logged-in Claude Code (`M0_CLAUDE_BIN`) and spends at most $0.60 per turn on `haiku`:

```bash
corepack pnpm agent:smoke
```

`.work/` (scratch data), `build/` and `results/` are git-ignored.
