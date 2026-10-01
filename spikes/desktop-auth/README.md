# Desktop identity spike

Throwaway feasibility code (macOS only). The question: how can the Engine tell the real Draft Tide desktop app from any other process running as the same user, and what defeats each approach? It is not the M1 implementation. Results, findings and the recommendation are in [`docs/desktop-auth-spike.md`](../../docs/desktop-auth-spike.md).

Nothing to install. It needs:
- Xcode's clang.
- A Node with headers (nvm or Homebrew) to build the N-API addon.
- The built M0 desktop spike (`spikes/m0/desktop/out/…/Draft Tide M0.app`), for its bundled Node and the packaged app.
- The M0 desktop's dev Electron (`spikes/m0/desktop/node_modules/electron`).

```bash
../m0/core/node_modules/.bin/tsc -p .   # typecheck
node src/verify.ts                      # build, then run all checks
```

| File | What |
|---|---|
| `native/peer.c` | N-API addon. Reads the socket peer's audit token (`LOCAL_PEERTOKEN`), resolves it to a `SecCode` and checks a code-signing requirement. `checkByPid` does the same from `LOCAL_PEERPID`, for comparison |
| `native/client.c` | Stand-in clients. One source is signed three ways: `desktop-sim` is the "real app"; `forged` has the same identifier but different code; `attacker` has its own identifier. Modes cover plain requests, fork and exec races, and the nonce handshake |
| `src/server.ts` | Stand-in Engine on the bundled Node. Handles the plain check and the handshake (pin T0, send a nonce, require the echo from the same process instance) |
| `src/build.ts` | Builds the addon and clients with `xcrun clang` (no node-gyp) and ad-hoc signs the clients with explicit identifiers |
| `electron/*.mjs` | Electron main scripts. `connect.mjs` connects as an Electron peer. `idle.mjs` stays up, optionally refusing debugging switches. `spawn-engine.mjs` starts the "Engine" with an inherited socketpair |
| `src/socketpair-child.ts` | The Engine end of that socketpair |
| `src/verify.ts` | The suite: sections A–D |

Ad-hoc signing stands in for a Developer ID: the "pinned" requirement uses `cdhash` where the product would use `anchor apple generic and identifier … and certificate leaf[subject.OU] = …`. `SPIKE_KEEP_WORK=1` keeps the temp dir. `results/` and `.work/` are git-ignored.
