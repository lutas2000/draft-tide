# Desktop identity spike

Date: 2026-10-01 · Machine: macOS 27.0.1, Apple Silicon (arm64) · Spike code: [`spikes/desktop-auth/`](../spikes/desktop-auth/README.md)

This is M1-00 open item 1 from [safety-model.md](safety-model.md#open-for-m1-00). In M0 the desktop proves itself with a 0600 token file, which any process of the same user can read. The spike asks how the Engine can tell the real desktop app from any other same-user process, and what defeats each approach. It is throwaway code and covers macOS only.

Status: 16/16 checks pass on three consecutive runs. Bundled Node 24.18.1 (Developer ID: Node.js Foundation), Electron 44.5.1 (dev build, ad-hoc) and the packaged M0 app (ad-hoc, fuses set).

**Decision (2026-10-01): option P, below.** The Engine verifies the desktop by code signature with a nonce handshake. It is written into `CLAUDE.md` and `.ref/` (M1 plan v2.4). Token custody stays open.

## What is being protected

Per-operation approvals are gone ([M1 plan §9.1](../.ref/M1_IMPLEMENTATION_PLAN.md)). The desktop channel still carries the operations that only the GUI may do: the agent-access switch, binding a folder, GitHub sign-in, connecting a remote and the first push.

A process that already runs code as the user can edit the design files and the SQLite store directly. That is a stated limit (TECH_STACK §9). For that process, desktop authentication guards only one thing it cannot get from the filesystem: **the GitHub token, and acting on GitHub with it** (creating repos, pushing, changing visibility). The recommendation below follows from that.

## Answers

| Question | Result | Checks |
|---|---|---|
| Can the Engine learn which code is on the other end of its socket? | **Yes.** It reads the audit token with `LOCAL_PEERTOKEN`, turns it into a `SecCode`, then calls `SecCodeCheckValidity` against a requirement. It works for an Electron main process as the peer | A1, A2, A11 |
| Is a requirement on the identifier enough? | **No.** Any binary can be ad-hoc signed with any identifier. The requirement has to anchor to Apple and the team as well | A3 |
| Is a requirement on the team enough? | **No.** A signed interpreter such as the bundled Node satisfies its team's requirement with any script. The desktop's identifier must be pinned, and the companion Node must never carry it | A4 |
| Is checking the peer when a request arrives safe? | **No.** macOS reports the *last process to use* the socket, and computes the token when it is queried. A request sent just before its process execs the genuine binary passes both the pid and the token check | A5, A6, A9 |
| Does a nonce handshake fix that? | **Yes, in every variant tried.** Pin the token at hello (T0), send a nonce, and accept only if the echo comes from the same pid and pidversion | A7, A8, A9, A10 |
| Can someone drive the genuine app instead of faking it? | **Yes.** `--remote-debugging-port` on the packaged app let another process call the desktop bridge from the GUI renderer. A guard at the top of Main that refuses debugging switches stops it. The packaged fuses already stop SIGUSR1 | B1, B2, B3 |
| Can someone attach to the Engine itself? | **Yes.** SIGUSR1 opens a Node inspector in any bundled-Node process. `--disable-sigusr1` stops it | C1 |
| Can the desktop start the Engine with a private channel? | **Yes.** Electron main hands the Engine a socketpair on fd 3. It has no path, and its peer is Electron main | D1 |

## Findings

### 1. The identity must pin identifier and team, and the interpreter must not share it

The product requirement has to name all three:

```
anchor apple generic and identifier "<desktop app id>" and certificate leaf[subject.OU] = "<team>"
```

- **Identifier alone (A3).** It accepts a different binary ad-hoc signed with the same identifier.
- **Team alone (A4).** It accepts anything the team signed, and that includes the companion Node, which runs any script. The bundled Node here is signed by the Node.js Foundation, and an inline `-e` script satisfied `anchor apple generic and certificate leaf[subject.OU] = "HX7739G8FX"`. Draft Tide will re-sign the companion Node with its own team, so the same thing would happen there.
- **Consequence.** The companion Node (and any other interpreter in the bundle) must be signed with an identifier different from the desktop app's. No identity that belongs to an interpreter may ever be trusted.

The spike had no Developer ID, so it used `cdhash` in place of the team anchor. The anchored form was exercised only against Node's real signature (A4).

### 2. Checking the peer at request time is racy on macOS

Two measured facts:

- **The peer is whoever last used the socket.** It is not the process that connected. After a fork, a child that sends is reported as the peer (A5). So is a child merely blocked in `read()` (A9).
- **`LOCAL_PEERTOKEN` is computed when queried.** It is not recorded when the data was sent. The pidversion does change on exec (for example 323338 → 323339), but the token returned afterwards already describes the new code (A6).

So an attacker connects and sends its request, then execs the real desktop binary. By the time the Engine checks, both the pid lookup and the audit-token lookup find genuine, correctly signed code, and the request is accepted (A6).

The handshake closes that gap:

1. On hello, pin T0 (pid and pidversion) and check the requirement.
2. Send a fresh nonce.
3. Accept only if the echo arrives with the same pid and pidversion as T0.

To pass T0 the process must already be the genuine binary. The genuine binary never answers a nonce it didn't ask for (A8). A forked helper answers from another pid (A10). A helper that touches the socket early becomes the peer at T0 and fails the requirement (A9). After the session is established, every message should be re-checked against T0; that part is designed but not tested.

### 3. The genuine app can be driven from outside unless Main refuses it

- **Remote debugging (B1).** Launching the packaged M0 app with `--remote-debugging-port` exposed its GUI renderer over CDP. Another process called `window.draftTide.engineInfo()` and got the Engine's answer through the real desktop channel. No peer check can catch this, because the peer really is the genuine app.
- **Guard (B2).** A check at the top of Electron main that refuses `remote-debugging-port`, `remote-debugging-pipe`, `inspect*` and `js-flags`, then exits, stopped the endpoint from ever opening.
- **SIGUSR1 (B3).** In the packaged app the `EnableNodeCliInspectArguments` fuse already blocks the SIGUSR1 inspector: the signal ends the process instead. The dev Electron opens an inspector.

M1's Main needs this guard and must keep the fuses. The list of refused switches must be reviewed on each Electron upgrade.

### 4. Every bundled-Node process can be attached with SIGUSR1

SIGUSR1 from any same-user process opens `ws://127.0.0.1:9229` in a running bundled-Node process (C1). That gives full control of the Engine, including any token in its memory. With `--disable-sigusr1` the process ignores the signal. The Engine, and every other companion process, must start with that flag.

### 5. Token custody decides the design

The Engine runs on the companion Node, and any script can run on that Node (finding 1). So nothing can verify an Engine by its code signature.

- **Engine reads the token from the keychain.** If the keychain item is readable by the companion Node's identity, any script run with that Node should be able to read it. This is reasoned from A4; keychain ACLs were not tested.
- **Desktop hands the token to an Engine found through discovery.** A fake Engine listening on the discovery socket would receive it.

The one channel the desktop can trust is to an Engine it started itself, from its own sealed bundle, over an inherited socketpair (D1).

## Options and decision

### P: the Engine verifies the desktop (chosen 2026-10-01)

The Engine checks every desktop connection by code signature, whoever started it.

1. **Requirement.** Pin identifier and team: `anchor apple generic and identifier "<app id>" and certificate leaf[subject.OU] = "<team>"`. Sign the companion Node with a different identifier (finding 1).
2. **Session handshake.** On hello, pin T0 (pid and pidversion) and check the requirement. Send a nonce, and accept only an echo from the same instance. Re-check every later message against T0 (finding 2; A7–A10).
3. **Hardening.**
   - Main refuses debugging switches before anything else runs (B2).
   - Keep the fuses (B3).
   - Every companion process runs with `--disable-sigusr1` (C1).
   - Release builds leave `get-task-allow` off (not tested here).
4. **Cost.** A small N-API addon in the companion that uses the Security framework and is loaded only there. The mechanism must be re-verified against a real Developer ID build. Windows needs its own mechanism.

**Still open under P: token custody (finding 5).** The desktop cannot verify an Engine that runs on the shared companion Node, and the keychain can't tell the Engine apart from any other script on that Node. The candidate for the M1-00 keychain item is to build the Engine as a single executable (Node SEA) with its own signing identifier that cannot load other scripts, so that the keychain ACL and the desktop can both trust it by signature. Not verified: whether a SEA build ignores `NODE_OPTIONS` and Node command-line options, and whether it survives packaging and signing.

### S: the desktop starts the Engine (the spike's recommendation, not adopted)

When the GUI starts, Main spawns the Engine from its own bundle and passes a socketpair on fd 3 (D1). The token then travels only over that socketpair, and the keychain item is readable only by the app. This needs no native addon, and it settles token custody by construction. Two costs led to its rejection:
- Saves made through CLI or MCP while the app has never been opened wait for the app before they push.
- Opening the app restarts an Engine that CLI or MCP started.

## Not verified

- A real Developer ID signature on a Draft Tide build. The team-anchored requirement ran only against Node's signature.
- Keychain ACL behavior: whether a companion-Node script can read an item trusted for that Node without a prompt (finding 5 is reasoned).
- A Node SEA Engine with its own signing identifier, the token-custody candidate under P.
- Re-checking every message against T0 after the handshake.
- Hardened-runtime protection of the Engine's memory from same-user processes (`task_for_pid`).
- Driving the app through AppleScript or Accessibility (gated by TCC), and other Chromium or Electron switches beyond the refused list.
- Windows: named-pipe handle inheritance, `GetNamedPipeClientProcessId` races, Authenticode.

## How to run

```bash
cd spikes/desktop-auth
../m0/core/node_modules/.bin/tsc -p .
node src/verify.ts
```

It needs Xcode's clang, a Node with headers (nvm or Homebrew) to build the addon, and the built M0 desktop spike. It briefly starts the dev Electron and the packaged M0 app with hidden windows and temporary data directories. Results go to `spikes/desktop-auth/results/` (git-ignored).
