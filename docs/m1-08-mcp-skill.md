# M1-08: MCP, Skill and agent setup

Date: 2026-10-03 · Machine: macOS 27.0.1, Apple Silicon (arm64), Node 24.18.1, Electron 44.5.1, Apple Git 2.54.0 · Work package: M1-08 ([M1 plan §12](../.ref/M1_IMPLEMENTATION_PLAN.md))

M1-08 makes Draft Tide usable by an external agent, on the designer's terms:
- **MCP.** The stdio server offers every tool-channel operation of the catalog as a tool (twenty-seven tools), with honest annotations, and gives an agent the picture of a version as image content.
- **Skill.** `skills/draft-tide/SKILL.md` tells an agent how to check the project, save, compare, preview, restore (plan, then apply, and name the protection version), handle busy, stale and interrupted operations, and what only the designer can do. It never spells a Git command.
- **Setup in the app.** 設定與診斷 shows this installation's CLI line, the MCP configuration and the Skill folder, with copy buttons, so the designer pastes them into their agent host.
- **A real host.** Claude Code 2.1.285 ran the Skill, the MCP server and the CLI against a real Engine: project check, save, compare, preview, direct restore with a protection version, agent access off, a stale plan, and a connect request the designer declined.

M1-08 depends on M1-05, M1-06 and M1-07 (all done). The manual flow is untouched: nothing here is needed to use the app.

## What was built

| Module | Contents |
|---|---|
| `apps/companion` | `mcp/server.ts`:<br>• **Tools from the catalog.** Every operation whose tool access is `always` or `agent-access` becomes a tool (`snapshot.diffFile` → `snapshot_diff_file`); `none` stays out. Descriptions carry the catalog summary and whether agent access is needed; annotations follow the catalog's effect (`readOnlyHint`, `destructiveHint`, `openWorldHint: false`).<br>• **Loose host validation, strict Engine.** The host validates arguments against the operation's shape with unknown fields allowed, so a self-asserted `confirmed: true` reaches the Engine and comes back as `INVALID_ARGUMENT` in the envelope instead of being silently dropped by the SDK's object schema. A wrong type or pattern is still refused by the host before the Engine.<br>• **Image content.** `snapshot_preview` answers the artifact envelope as text, followed by the PNG as `image` content: the full 1280×800 picture by default, the thumbnail with `image: "thumbnail"`, nothing with `"none"`. The PNG is read from the Engine in chunks and checked against the artifact's SHA-256; a picture that can't be read is a warning (`PREVIEW_IMAGE_UNAVAILABLE`) on a successful envelope, never a failed tool. `preview_read` stays for hosts that want the bytes.<br>• **Instructions** for the host: envelope, `engine_info` first, agent access, requests, saving, restoring, recovery, GitHub and the image content.<br>stdout carries MCP only; the ready line goes to stderr |
| `skills/draft-tide` (new) | `SKILL.md` (frontmatter `name`, `description`; requirements, which interface, start every task, save, history and pictures, restore, busy/stale/interrupted, GitHub, never) and `references/reference.md` (every tool with its CLI command and effect; every error code with its next step) |
| `apps/desktop` | **Main:** `agentSetup()` answers the companion Node, the CLI bundle, `--data-dir` when the window's data directory isn't the platform default, and the Skill folder when it ships (the repository's for development and e2e builds; the app's resources from M1-09). `copyText` takes the app's own multi-line snippets (8 KiB).<br>**Build:** the companion's `cliEntry` and the `skillDir` join the build info.<br>**GUI:** the CLI / MCP / Skill 設定 card in 設定與診斷: the CLI line as a shell command, the `mcpServers` JSON (the shape Claude Code, Claude Desktop and Cursor read), the Skill folder, each with 複製, and which host was tested |
| Tests | `apps/companion/test/mcp.test.ts`: the same fixture through MCP and the CLI (same snapshot ids, the same diff), `NO_CHANGES` without `isError`, restore with and without a protection version, a plan applied once (`PLAN_STALE`, `used`), `confirmed`/`force` refused by the Engine, a plan of another project, a stale plan, image content checked against the artifact (full, thumbnail, none, a PNG in the version, a file that can't be previewed, an unknown choice refused by the host), and the switch turned off while connected.<br>`apps/companion/test/skill.test.ts`: the frontmatter, every tool name the Skill uses exists and every tool is covered, every error code exists, no Git workaround.<br>Desktop E2E: the settings card shows this build's CLI and data directory, the copied MCP configuration parses to the companion command, and the Skill folder holds `SKILL.md` |

No catalog operation, error code or contract changed. `doctor` is still not a command: `status` and `recover inspect` cover what agents need, and the diagnostics export is M1-09.

## The real-host smoke (M1 plan §13.3, agent gate)

Host: Claude Code 2.1.285 in `--print` mode (model `claude-fable-5-1`), the Skill linked into the workspace's `.claude/skills/draft-tide`, the MCP server from a `--mcp-config` file (`--strict-mcp-config`), tools limited to `mcp__draft-tide__*`, the Skill, Read, and, for the CLI run, Bash restricted to the CLI. The project was bound through the desktop channel of a development Engine (what the app does), with agent access on and one unsaved change.

| Run | Asked | What the agent did | Turns |
|---|---|---|---|
| 1 | Check the project, save "Bigger price", compare with the previous version, get a picture, restore the previous version, list the history | Loaded the Skill; `engine_info`, `project_list`, `project_status` (one unsaved file, named), `snapshot_create` (V2, agent-requested, mcp), `snapshot_diff` and `snapshot_diff_file` (the exact lines), `snapshot_preview` → reported `PREVIEW_FAILED` / `no-renderer` as about the picture only, `restore_plan` → `restore_apply` (V3, no protection version because nothing was unsaved, and said so), `history_list` with every id. The CLI and `git log` agree; `git status` is clean | 14 |
| 2 | Save "Tweak", with agent access **off** | Loaded the Skill; `engine_info`, `project_list` → `AGENT_ACCESS_DISABLED`. Stopped, told the designer where the switch is (設定與診斷 → 允許 agent 存取), that only they can turn it on, that nothing was changed and no Git was run | 6 |
| 3a | Connect a new folder as "Other" | `project_connect_request` → `CONFIRMATION_REQUIRED` with the operation id; `operation_status` twice (`awaiting-user`); said it cannot approve and there is no flag that bypasses it | 9 |
| 3b | (the request was declined through the desktop channel) Check that request | `operation_status` → `denied`, `APPROVAL_DENIED`; reported it and sent no new request | 5 |
| 4a | Plan a restore to "Bigger price" and stop | `history_list`, `project_status`, `restore_plan`; reported the plan id, summary and expiry, applied nothing | 9 |
| 4b | (a file was edited meanwhile) Apply that plan | `restore_apply` → `PLAN_STALE` (`changed`), nothing written; planned again (first with the version's name, which the host's schema refused; then with the snapshot id from `history_list`), `restore_apply` → ok; reported the restore version (V5) and the protection version (V4) and that the edit is one restore away | 11 |
| 5 | CLI only, no MCP: check the project, status, compare V1 with V2, save "CLI check" | Loaded the Skill; `--json engine info`, `project list`, `status`, `history`, `diff`, `snapshot` → `NO_CHANGES`, exit code 3, reported as nothing to save, not as an error | 13 |

Everything the agent reported matched what the CLI and Git showed afterwards. Run 4b showed one gap in the Skill, now closed: version arguments take a snapshot id or commit id, never a name. Other hosts (Claude Desktop, Cursor, …) read the same `mcpServers` shape but are untested, and the settings card says so.

## Decisions taken here

- **The host's schema is loose; the Engine's is strict.** The MCP SDK builds a plain object schema from a raw shape, which strips unknown keys before the handler runs: an agent's `confirmed: true` would have vanished instead of being refused. The tools now register a loose object, so the Engine's strict schema answers `INVALID_ARGUMENT` (with the key named) in the envelope, as the CLI does. The host still refuses wrong types and patterns itself (an MCP `-32602` tool error), which is fine: those never reach the Engine either.
- **The picture is content, the artifact is the result.** An agent that can see images gets the full PNG by default. The artifact comes first, as the text envelope, so an agent that can't see images still has the facts (what was missing or blocked). A picture that can't be attached is a warning on a successful envelope: the preview was made, and `preview_read` has it.
- **One Skill for both interfaces.** The Skill prefers the MCP server and falls back to the CLI with `--json`; both run the same Engine. It names tools and codes only; the reference maps each tool to its CLI command.
- **The settings card tells where, never grants.** It composes the CLI line, the `mcpServers` JSON and the Skill folder from the build and the window's data directory. Agent access remains the only thing that lets an agent in, and the card says so.
- **The companion is named by the build.** Development and e2e builds point the card at the companion dist and the repository's Skill folder; release builds (M1-09) point at the app's resources. A build without the Skill folder says it has none.
- **`doctor` stays out** (as in M1-05): the diagnostics export is M1-09.

## How to run

```bash
corepack pnpm run check                                                   # everything
corepack pnpm exec vitest run apps/companion/test/mcp.test.ts             # MCP against a real Engine
corepack pnpm exec vitest run apps/companion/test/skill.test.ts           # the Skill against the catalog
corepack pnpm --filter @draft-tide/desktop run test:e2e                    # the settings card
```

To connect Claude Code to a development build (the settings card shows the exact lines for your data directory):

```bash
claude mcp add draft-tide -- node apps/companion/dist/cli.mjs mcp serve
cp -R skills/draft-tide ~/.claude/skills/draft-tide
```

Then turn on agent access in 設定與診斷 and ask the agent to save a version.

## Results (this machine)

`corepack pnpm run check`: format, lint, typecheck and build clean; **556 passed, 3 skipped** (the same Linux-only skips). M1-07 had 548. Desktop E2E: **33/33** (1 new).

The real-host smoke above: seven runs, every tool answer reported as it was, no Git run, nothing changed without a successful apply.

## Known limits

- **Previews from an agent need the app's Engine.** Only an Engine the desktop app started has a Preview Host (`DRAFT_TIDE_PREVIEW_HOST`); an Engine the MCP server or CLI starts answers `PREVIEW_FAILED` (`no-renderer`), as run 1 showed. Release builds get their Preview Host in M1-09.
- **The Engine doesn't open the app** for a request (M1-09): the Skill tells the designer to open it.
- **One host tested.** Claude Code only. The `mcpServers` shape is shared by other hosts, but their Skill loading and lifecycle are unverified.
- **Images cross the host's limits as they are.** The full PNG is 1280×800; a host with a smaller image budget should ask for the thumbnail.
- **The Skill ships with the repository** until M1-09 packages it in the app's resources; the settings card finds it there.
- **Windows and Linux** are untested for the settings card's paths (the shell quoting is POSIX).
