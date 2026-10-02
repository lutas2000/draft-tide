# Token custody spike report

Date: 2026-10-03 · Machine: macOS 27.0.1, Apple Silicon (arm64), Node 24.18.1 · Signing: Developer ID Application, team ZUHKJTHALN · Spike code: [`spikes/token-custody/`](../spikes/token-custody/README.md)

This closes the last open M1-00 item. The [desktop-auth spike](desktop-auth-spike.md) left it open (its finding 5). The Engine runs on the companion Node, and any script run with that Node carries the same signature (A12). So a keychain item trusted for that Node would trust every script, and the desktop could not tell the real Engine from a fake one. The candidate was to build the Engine as a Node single executable application (SEA) with its own signing identifier, and let the keychain trust only that. The spike is throwaway code and covers macOS only.

**Decision (2026-10-03): adopted.** The Engine ships as a Node SEA under its own identifier. It creates the token's keychain item itself, and the item's default access list then trusts only the Engine's designated requirement. It is written into `CLAUDE.md` and `.ref/` (M1 plan v2.16, TECH_STACK v2.15, ROADMAP v2.9).

**Suite: 17/17**, plus two observations. No dialog appeared during the run.

## Answers

| Question | Result | Evidence |
|---|---|---|
| Can the Engine be a SEA signed under its own identifier with hardened runtime? | **Yes.** Built from the official Node 24.18.1 with `postject`, re-signed with the Developer ID, hardened runtime and `allow-jit` only. `codesign --verify --strict` passes, and the designated requirement is identifier + Developer ID markers + team | L1 |
| Does it need JIT? | **Yes.** Without `allow-jit` it dies at start with SIGTRAP | L2 |
| Does a SEA ignore `NODE_OPTIONS`? | **Not by default.** A default SEA ran a `--require` script from `NODE_OPTIONS`. With `"execArgvExtension": "none"` in the SEA config it is ignored | L3 |
| Command-line Node options? | Only arguments to the program: `--require`, `--inspect=0` and `-e` loaded nothing and opened no inspector | L4 |
| SIGUSR1? | A default SEA opens an inspector. `"execArgv": ["--disable-sigusr1"]` in the SEA config stops it | L5 |
| Library injection and memory access? | `DYLD_INSERT_LIBRARIES` is ignored, and a debugger-entitled same-user probe gets no task port. The official Node allows both (controls) | L6, L7 |
| Can its launch environment still weaken TLS? | **Yes.** The SEA honors `NODE_TLS_REJECT_UNAUTHORIZED=0` and `NODE_EXTRA_CA_CERTS` (a self-signed server was accepted), and `NODE_USE_ENV_PROXY` + `HTTPS_PROXY` (a `CONNECT api.github.com:443` reached a local proxy). An allowlist checked first refuses to start with any of them | L8, L9 |
| Does an allowlist work in practice? | Yes. CoreFoundation adds `__CF_USER_TEXT_ENCODING` to every process, even one spawned with an empty environment, so it has to be on the list. With only listed variables the SEA starts; adding `PATH` alone is refused | L10 |
| Native addons? | The team-signed better-sqlite3 prebuild loads under library validation, from beside the executable | L11 |
| Who can read the item the SEA created? | The SEA itself, with no dialog. A new build with different code but the same identifier and team, with no dialog. **Not**: a script on the team-signed companion Node, a script on the official Node, or an ad-hoc SEA with the Engine's identifier and library validation off. All three got `errSecAuthFailed` (-25293) with no dialog | K1–K6 |
| Can the desktop tell the real Engine from a fake one? | **Yes.** The SEA on the Engine socket satisfies the Engine requirement. A script on the companion Node serving the same kind of socket passes team-only but not the Engine requirement | D1 |

## Findings

### 1. A SEA is only as closed as its config

Out of the box a SEA still reads `NODE_OPTIONS` and still opens an inspector on SIGUSR1 (L3, L5). Two lines in the SEA config close both:

```json
{ "execArgv": ["--disable-sigusr1"], "execArgvExtension": "none" }
```

Node 24.18.1 supports both fields; `--build-sea` does not exist yet, so the blob is injected with `postject`. Command-line options are never parsed as Node options in a SEA (L4). Hardened runtime handles dyld injection and task ports, as it does for the re-signed companion Node (L6, L7; desktop-auth E1, E2).

### 2. The environment is the remaining attack surface, so the Engine allowlists it

Anyone can start the genuine Engine, and the keychain will hand the token to it. What remains is the environment it starts in. Node reads `NODE_EXTRA_CA_CERTS` before any of the Engine's code runs, and `NODE_TLS_REJECT_UNAUTHORIZED` and `NODE_USE_ENV_PROXY` when it connects (L8, L9). Either way, the token refresh and API calls could be intercepted. A denylist would miss variables nobody has listed yet. So the Engine's first act is to compare `process.env` with an allowlist and exit if anything else is present:
- **OS basics.** `HOME`, `TMPDIR`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, and `__CF_USER_TEXT_ENCODING`, which CoreFoundation sets itself (L10).
- **Draft Tide's own variables.** Only those the build honors.

Launchers (desktop, CLI) already build the Engine's environment from scratch. Git subprocesses get their own from-scratch environment, as before.

### 3. The keychain item is created by the Engine, in-process

The addon calls `SecItemAdd` without `kSecAttrAccess`, so the default access list trusts only the calling program by its designated requirement. That requirement is the identifier plus Developer ID markers plus team (L1).
- **Updates.** A new build signed the same way still matches, so updates keep the token (K2).
- **Everyone else.** Other code is refused: other team-signed code, the official Node, and a forgery with the same identifier (K3–K5).
- **Not through `/usr/bin/security`.** That would make `security` the trusted reader.
- **No dialog.** Reads pass `kSecUseAuthenticationUIFail` and turn user interaction off, so a refused read fails instead of asking.

### 4. The desktop can verify the Engine

Under the SEA the Engine has an identity of its own, so the desktop can check the peer on the Engine socket the way the Engine checks the desktop (D1). The token doesn't need this, because it never crosses that socket. It is available if the desktop should refuse to talk to a fake Engine.

## Residual risks and rules that follow

- **Prompted access.** A process that reads with UI allowed makes macOS ask the user. If the user clicks Allow, that process gets the token; "Always Allow" adds it to the item's access list for good. This is user consent, not a bypass. The spike's readers never allowed UI, so the dialog itself was not exercised.
- **Where the token goes.** Reasoned, not tested. The data store is writable by any same-user process, so a remote binding could be pointed at another host. The Engine therefore sends the token only to `https://github.com` and `https://api.github.com`, checked before each request, never to whatever URL a binding names.
- **Engine code.** It never loads code from a path given by argv, the environment, config or SQLite. Addons come only from beside the executable and must be team-signed (L11).

## Not verified

- The SEA inside the packaged, notarized app, and Gatekeeper on it (M1-09).
- The keychain dialog when a reader allows UI, and `security find-generic-password -w`.
- Same-team Apple Development certificates (as in the desktop-auth spike).
- Windows (Credential Manager / DPAPI) and Linux.
- Node's built-in SEA builder (`--build-sea`) in later Node versions.

## How to run

See [`spikes/token-custody/README.md`](../spikes/token-custody/README.md).
