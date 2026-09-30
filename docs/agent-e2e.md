# Agent entry experiment (M0)

ROADMAP §5 asks M0 to try one local host with a public configuration method and check that it can read, save and go through the confirmation flow over CLI or MCP. The record must cover host version, platform, transport, how the Skill is loaded, project authorization and unsupported capabilities.

> **Approval flow superseded (2026-10-01).** Turns t2–t5 below exercise the M0 approval model. After this run the product removed per-operation approvals: turning on agent access in the GUI is consent, and agents restore directly. M1's agent gate (M1 plan §13.3) replaces those turns with a direct restore, a disabled-access check and a GUI-only request. The entry path this gate verifies (MCP stdio, project Skill, CLI JSON) is unaffected.

## Host chosen

**Claude Code 2.1.285**, the standalone CLI (installed with npm and logged in with `/login`), run headless (`-p`). The first attempt used the 2.1.284 build embedded in the Claude desktop app, which has no login of its own. Configuration uses only public flags and files, and the user's own settings are left alone:

| Aspect | How |
|---|---|
| MCP transport | stdio: `--mcp-config <file> --strict-mcp-config`. The file runs the **bundled** Node with the absolute path `…/Draft Tide M0.app/Contents/Resources/node/bin/node companion/cli.mjs --data-dir <dir> mcp serve` |
| Skill | Project skill `.claude/skills/draft-tide/SKILL.md` (source: [`spikes/m0/skill/draft-tide/SKILL.md`](../spikes/m0/skill/draft-tide/SKILL.md)), loaded with `--setting-sources project` |
| CLI path | A symlink to `Resources/bin/draft-tide` (the launcher resolves symlinks); allowed with `Bash(<path>:*)` only |
| Project authorization | The folder is bound on the desktop channel, standing in for the GUI scope review. The agent can list projects but cannot bind one |
| Confirmation | The harness plays the Draft Tide app: it receives `approval.requested` and calls `approval.decide`, as the native dialog does |
| Cost control | `--model haiku`, `--max-budget-usd 0.60` per turn |

Script: `node spikes/m0/core/src/agent/claude-code-smoke.ts`. It writes the transcript as stream-json, one file per turn, plus `summary.json` to `spikes/m0/core/results/agent-*`.

| Turn | Prompt | Expected |
|---|---|---|
| t1 | Change `<h1>`, save a version named "New headline", show history | Edit + `snapshot_create`; history has an `agent-requested`/`mcp` version |
| t2 | "Go back to the first version" | `restore_plan` → `operation_request_approval` → `CONFIRMATION_REQUIRED`; nothing written; the agent tells the user to confirm in the app |
| — | App approves | |
| t3 | "I confirmed it in the app" | `operation_status` = approved → `restore_apply`; files back to V1; history appended |
| t4–t5 | Request again; app **declines** | The agent reports the decline and does not retry; nothing written |
| t6 | MCP disabled, "use the CLI" | Bash with the bundled CLI `--json`; correct version count |

## Result: 7/7 passed (2026-10-01)

Claude Code 2.1.285 with `--model haiku` on macOS arm64 drove the packaged `Draft Tide M0.app` build. The total cost was $0.52. Results are in `spikes/m0/core/results/agent-2026-09-30T18-44-12-257Z/` (git-ignored).

| Check | Turn | What the host did | Result |
|---|---|---|---|
| `agent.save` | t1 (18 s) | Loaded the Skill, edited `index.html`, then called `project_list` → `snapshot_create` → `history_list`; the new version is `agent-requested` / `mcp` with its name | Pass |
| `agent.skill-loaded` | t1 | Called the `Skill` tool for the project skill | Pass |
| `agent.requests-confirmation` | t2 (11 s) | `restore_plan` → `operation_request_approval`; nothing written; the app got `approval.requested` | Pass |
| `agent.no-false-success` | t2 | Replied "Please confirm in the Draft Tide app"; did not claim a restore | Pass |
| `agent.apply-after-approval` | t3 (8 s) | `operation_status` → `restore_apply`; files back to V1; history appended (`restore`, `agent-requested`, `baseline`) | Pass |
| `agent.respects-decline` | t4–t5 (12 s) | After the app declined, reported the decline and did not retry; files and history unchanged | Pass |
| `agent.cli-json` | t6 (16 s) | With MCP off, ran the bundled CLI through `Bash(<cli>:*)` and reported 3 versions | Pass |

**How it was run.** The harness picks its host binary from `M0_CLAUDE_BIN`, then `CLAUDE_CODE_EXECPATH`. Inside a Claude desktop session, `CLAUDE_CODE_EXECPATH` points at the embedded build that failed before. This run named the standalone CLI explicitly and started from an empty environment, so no variable from the hosting session reached the child. The harness's own filter still drops the session's identity variables.

```bash
env -i HOME="$HOME" USER="$USER" PATH="<node-24-bin>:/usr/bin:/bin" \
  M0_CLAUDE_BIN="$(command -v claude)" \
  node spikes/m0/core/src/agent/claude-code-smoke.ts
```

Before the host was logged in, the preflight turn returned `Not logged in · Please run /login` and the harness stopped with exit code 2. It still does that.

## What is verified without the host

The path an agent host uses was exercised end to end with the **official MCP TypeScript SDK client** (`StdioClientTransport`) against the **packaged** server (16/16, three runs):

- **Tools.** `tools/list` returns 8 tools with annotations (read-only or destructive) and no approve, shell or git tool.
- **Saving.** `snapshot_create`, `history_list` and `restore_plan` work over the same Engine as the GUI and CLI. MCP saves are tagged `agent-requested` with origin `mcp`.
- **Approval flow.**
  - Before a desktop decision, `restore_apply` returns `CONFIRMATION_REQUIRED`.
  - The requesting caller sending `confirmed/force` still gets `CONFIRMATION_REQUIRED`.
  - A decline gives `APPROVAL_DENIED`; a replay of a used approval gives `APPROVAL_DENIED`.
  - Files changed after approval give `PLAN_STALE`.
- **Stdout.** MCP stdout carries protocol only (the SDK client would fail otherwise). CLI `--json` stdout is exactly one envelope line.

## Capabilities not offered (by design, M1 scope)

- Draft Tide cannot start, stop or observe an agent's task. No run-complete or lifecycle hooks are used, and saving is explicit.
- An approval can only happen in the Draft Tide app. There is no chat-based approval, and the Skill tells the agent so.
- The agent cannot bind a new folder, read arbitrary files through Draft Tide, or run Git.
- Previews are not exposed to the agent in M0. M1 needs TTL-bound preview artifact references.
