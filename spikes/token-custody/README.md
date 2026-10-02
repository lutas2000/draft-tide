# Token custody spike

Throwaway feasibility code (macOS only). The question: can the GitHub token sit in the keychain so that only the Engine can read it, when the CLI and MCP run arbitrary scripts on the same team-signed companion Node? The candidate was an Engine built as a Node single executable application (SEA) with its own signing identifier. It is not the M1 implementation. Results and what they change are in [`docs/token-custody-spike.md`](../../docs/token-custody-spike.md).

It needs:
- Xcode's clang, and a Node 24 with headers (nvm or Homebrew) for the N-API addon and as the SEA base.
- `corepack pnpm install --ignore-workspace` here (only `postject`, which injects the SEA blob; Node 24 has no `--build-sea`).
- The repo's root `node_modules` (the better-sqlite3 prebuild) and `spikes/desktop-auth/native/` (peer, inject and task-port probes).
- A Developer ID Application identity. The checks depend on a real team signature, so there is no ad-hoc mode.

```bash
../m0/core/node_modules/.bin/tsc -p .   # typecheck
SPIKE_SIGN_IDENTITY=<Developer ID Application SHA-1> SPIKE_TEAM=<team id> node src/verify.ts
```

The suite creates one generic password (service `dev.drafttide.spike.token-custody`) in the login keychain and removes it at the end. No reader is allowed to show a dialog, so a run asks nothing of the user apart from possible `codesign` access to the signing key.

| File | What |
|---|---|
| `native/keychain.c` | N-API addon: store, read (with or without UI) and remove a generic password through the Security framework, in-process |
| `sea/engine.cjs` | Stand-in Engine built into the SEA. Refuses any environment variable outside an allowlist; loads addons only from beside its executable. Its argv modes exist only for the suite (`raw-*` skips the allowlist to show what Node itself honors) |
| `sea/reader.cjs` | Another process's view: read the item through the same addon, or pose as the Engine on a socket |
| `sea/check-peer.cjs` | The desktop's view: check the code signature of whoever serves the Engine socket (desktop-auth's peer addon) |
| `src/verify.ts` | Builds the addons and five executables (two SEA builds, a default-config SEA, a SEA without JIT, an ad-hoc forged SEA, a team-signed companion Node), then runs sections L, K and D |

`results/` and `.work/` are git-ignored.
