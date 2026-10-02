# Single-repo spike

Throwaway feasibility code: Draft Tide history kept in the **project's own Git repo** (no separate bare repo), synced to a remote, with project settings in `.drafttide.json`. It is not the M1 implementation: nothing here maps to the planned `apps/` / `packages/` layout. Results, findings and what they change are in [`docs/single-repo-spike.md`](../../docs/single-repo-spike.md).

No dependencies to install. It reuses the M0 spike's toolchain and its dugite Git (`spikes/m0/core/node_modules`), and falls back to `/usr/bin/git`.

```bash
../m0/core/node_modules/.bin/tsc -p .             # typecheck
node src/verify.ts                                # the whole suite
node src/verify.ts local hostile sync             # or a subset
SPIKE_TLS_CHECK=1 node src/verify.ts              # also a read-only TLS check against github.com
DRAFT_TIDE_GIT_ROOT=system node src/verify.ts     # run on Apple's Git instead of dugite's
```

| File | What |
|---|---|
| `src/git.ts` | Hardened Git runner (explicit `--git-dir` / `--work-tree`, command-line overrides of the repo's config, sanitized env) |
| `src/probe.ts` | Static look at a repo: unsupported forms, in-progress operations, hazardous config keys |
| `src/scope.ts` | What is in scope, capture with stability check, attribute checks, symlink-parent guard |
| `src/config.ts` | `.drafttide.json` schema (untrusted input) |
| `src/repo.ts` | Adopt, save, history, restore, fast-forward, crash recovery, the lock-first index publish |
| `src/sync.ts` | fetch / push / classify / pull / open-from-remote through an ephemeral git dir + askpass |
| `src/testserver.ts` | Smart-HTTP Git behind Basic auth (stand-in for GitHub) and a request-recording canary |
| `src/tests-*.ts`, `src/verify.ts`, `src/harness.ts` | The suite (sections A–I) |
| `src/github-check.ts` | For you to run against a throwaway GitHub repo (with a default branch) with your own token. **Not** part of `verify`. Passed on 2026-10-02 (report Finding 8) |
| `src/github-app-check.ts` | GitHub App device-flow sign-in, installation scope, visibility, push and refresh, with a person entering the code. **Not** part of `verify`. Passed on 2026-10-02 (report Finding 9) |

`SPIKE_WORK=<dir>` picks where fixtures go (default: the OS temp dir), `SPIKE_KEEP_WORK=1` keeps them. `results/` is git-ignored.
