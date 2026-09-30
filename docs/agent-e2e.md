# Agent entry experiment (M0)

ROADMAP §5 asks M0 to try one local host with a public configuration method and check that it can read, save and go through the confirmation flow over CLI or MCP. The record must cover host version, platform, transport, how the Skill is loaded, project authorization and unsupported capabilities.

## Host chosen

**Claude Code 2.1.284** (the build installed with the Claude desktop app), run headless (`-p`). Configuration uses only public flags and files, and the user's own settings are left alone:

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

## Result: blocked by host login

The preflight turn returned `Not logged in · Please run /login`. The desktop app authenticates the Claude Code sessions it hosts through its own channel, and a separate headless process gets no credentials. The harness strips this session's identity variables on purpose; passing the host session's messaging socket to a child process is not acceptable. The harness now stops at preflight with exit code 2 and a clear message.

**To finish this gate**, log in the standalone `claude` once (interactive `/login`) and re-run:

```bash
node spikes/m0/core/src/agent/claude-code-smoke.ts
```

Or choose another public local host and point `M0_CLAUDE_BIN` at a compatible CLI. The Skill and MCP config are host-neutral.

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
