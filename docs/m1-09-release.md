# M1-09: Alpha release — packaging and signing (part 1)

Date: 2026-10-03 · Machine: macOS 27.0.1, Apple Silicon (arm64), Xcode 27.0, Node 24.18.1 (official build), Electron 44.5.1 · Work package: M1-09 ([M1 plan §12](../.ref/M1_IMPLEMENTATION_PLAN.md))

M1-09 turns the M1 build into an installable alpha. This first part builds the macOS package and signs it the way the desktop-auth and token-custody spikes require:
- **The Engine is a Node SEA** with its own signing identifier, its addons beside it, and an environment allowlist it checks before anything else.
- **The app carries everything it runs**: the companion Node (CLI and MCP), the Engine, the bundled Git subset, the Skill and the license files, in one layout every component finds through `packagedLayout`.
- **One command** (`corepack pnpm run release:mac`) builds, packages, sets the fuses, signs every Mach-O with the team's Developer ID, checks the result statically and at runtime, notarizes and staples (with a notary profile), and makes the disk image.
- **The Preview Host has its own identity.** It is its own executable beside the app's (`Contents/MacOS/Draft Tide Preview`), signed under its own identifier, so the Engine's desktop check rejects it. Release builds now render previews.

The release run passes all ten checks, is notarized and stapled, and Gatekeeper accepts both the downloaded disk image and the app copied out of it. The signed app opened, and it passed the Engine's code-signature check and nonce handshake. Release builds compile in the release GitHub App (`draft-tide`), and Git's GPL source ships as an asset of the same GitHub Release.

Still to come in M1-09: the rest of the GitHub round trip with the packaged app (sign-in, connect and the first push passed), the diagnostics export, the clean-machine and usability gates, and the install / uninstall guide (see "What is left").

## What was built

| Module | Contents |
|---|---|
| `packages/engine-client` | `layout.ts`: `packagedLayout(resources)`, the one map of a packaged release (`node/bin/node`, `companion/cli.mjs`, `engine/draft-tide-engine` and its addons, `git/bin/git` with its exec path, `skills/draft-tide`).<br>`connect.ts`: `EngineLaunch` is now `{command, args, env}`: the release Engine executable with no arguments, or `scriptEngineLaunch(node, entry)` (`--disable-sigusr1` plus the minimal `PATH` a development Engine looks for Git on). The Engine's environment is built from the OS basics only (`HOME`, `TMPDIR`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, plus the XDG directories on Linux); no `PATH` for a release Engine |
| `apps/companion` | `scripts/build.ts`: release builds emit `cli.mjs` and the Engine SEA only (`dist/sea/`: the executable and `better_sqlite3.node`, `peer-identity.node`, `keychain.node` beside it); `--sea` builds a development SEA. The SEA is a CommonJS bundle of the Engine with better-sqlite3 inlined and its loader replaced (the addon only from beside the executable), a blob with `execArgv: ["--disable-sigusr1"]` and `execArgvExtension: "none"`, injected with postject into a copy of the running Node, ad-hoc signed for local use.<br>`src/engine/env-guard.ts` (imported first) and `environment.ts`: a release Engine exits with status 2, naming the variables, when anything outside the allowlist is present.<br>`src/engine/addons.ts`: every addon loads from beside the Engine executable in a SEA, or from `dist/native` in development, never from a path given at runtime.<br>`src/engine/host.ts`: the release Engine's Git is the bundled one, found from its own executable's place (`GIT_EXEC_PATH` always set).<br>`src/engine/main.ts`: no top-level await (a Node 24 SEA runs one CommonJS script).<br>`src/engine-launch.ts`: the release CLI and MCP server start the Engine executable of the same app |
| `apps/desktop` | `scripts/build.ts`: a release mode (`dist-release/`, no companion paths, no source maps).<br>`src/main/engine.ts`, `app.ts`: release builds start `packagedLayout(resourcesPath).engine`; the agent setup card names the packaged Node, CLI and Skill, and every CLI line and MCP configuration now starts with `--disable-sigusr1`.<br>`scripts/package.ts` and `scripts/release/` (`config.ts`, `git.ts`, `sign.ts`, `verify.ts`, `notarize.ts`, `notices.ts`): the release pipeline below |
| root | `release:mac` script; `.cache/` (pinned downloads) and `dist-release/` ignored |
| `apps/companion/src/build-info.ts` | `RELEASE_GITHUB_APP`: the release GitHub App `draft-tide` (client ID `Iv23li5bVjuyY8pVqtz5`), compiled into release builds unless `DT_GITHUB_CLIENT_ID` / `DT_GITHUB_APP_SLUG` name another.<br>`previewRenderer`: the renderer of the packaged Preview Host (`DT_PREVIEW_RENDERER` at build time), so the Engine caches previews under it before the first render |
| The Preview Host's identity | engine-client: `packagedLayout(…).previewHost`, `Contents/MacOS/Draft Tide Preview` (`PREVIEW_HOST_EXECUTABLE`).<br>companion `src/engine/preview-host.ts`: a release Engine starts the Preview Host of its own app (found from its executable's place), under the compiled-in renderer, and never one named by the environment.<br>desktop `src/main/main.ts`: in a release the executable decides the role; the app's refuses `--dt-preview-host`, the Preview Host's runs nothing else.<br>`scripts/package.ts`: copies the app's executable to the Preview Host's place and reads the renderer from the Electron it packages; `release/sign.ts` signs it as `….preview-host` with JIT; `release/verify.ts` checks it (S3, S4, R2, R4, R5) |

## The pipeline

`apps/desktop/scripts/package.ts`, in order:
1. **Preflight.** macOS; the running Node must be relocatable, meaning it links only `/usr/lib` and `/System` (an official build, not Homebrew's), because it becomes both the companion Node and the base of the Engine SEA. The signing identity must be in the keychain.
2. **Companion, release mode.** `DT_DESKTOP_APP_ID` and `DT_TEAM_ID` compile the desktop requirement into the Engine; the GitHub App goes in if given; `DT_PREVIEW_RENDERER` (`electron/44.5.1 chromium/152.0.7977.130`, read from the Electron being packaged) names the Preview Host's renderer.
3. **Desktop, release mode**, staged as a clean app directory: Main, preload, the GUI and a minimal `package.json`. No `node_modules`; Main is one bundle.
4. **`@electron/packager`**: the bundle with `app.asar` and its integrity hash in `Info.plist`; helpers named `Draft Tide Helper …`.
5. **The Preview Host and the payload**, exactly `packagedLayout`:
   - **The Preview Host.** A copy of the app's executable (Electron's 52 KB stub) at `Contents/MacOS/Draft Tide Preview`.
   - **Into `Contents/Resources`: the companion Node.** The running Node, with its `LICENSE`.
   - **The CLI.** `cli.mjs`.
   - **The Engine.** The SEA with its three addons.
   - **Git.** Assembled from the pinned dugite-native tarball (SHA-256 checked, cached, resumable): `bin/git` and `git-remote-https`, two symlinks, Git's `COPYING` (pinned too) and `SOURCE.txt`, which names the sources asset below.
   - **The Skill.** `skills/draft-tide`.
   - **Licenses.** Electron's and Chromium's licenses, Draft Tide's, and `THIRD-PARTY-NOTICES.txt`, generated from `pnpm licenses list --prod` for the desktop app and the companion (175 packages, over-inclusive on purpose).
6. **Fuses**, every V1 fuse set explicitly (`strictlyRequireAllFuses`):
   - **Off.** RunAsNode, `NODE_OPTIONS`, the inspect arguments, the browser-process V8 snapshot and file:// privileges.
   - **On.** Cookie encryption, embedded ASAR integrity, asar-only loading and the Wasm trap handlers.
7. **Signing** with `@electron/osx-sign`, inside out, with explicit per-file options. Its defaults would have added camera, microphone, location and other entitlements, so every file gets its options from us:
   - **Common to every Mach-O.** Hardened runtime and a secure timestamp.
   - **JIT only.** The app's executables (its own and the Preview Host's) and helpers, the companion Node and the Engine.
   - **No entitlements.** Git, the addons, frameworks and libraries.
   - **Identifiers.** The payload's own (below); bundles keep their `Info.plist` identifier.
8. **Checks** (`release/verify.ts`); any failure stops the run before notarization.
9. **With `DT_NOTARY_PROFILE`.**
   - **The app.** Notarized as a zip and stapled, so a copy taken out of the disk image passes Gatekeeper offline.
   - **The disk image.** Made with `hdiutil` (lzfse, with an `/Applications` link), signed, notarized and stapled.
   - **Gatekeeper.** Its verdict on both goes into `manifest.json`, and a rejection of a notarized build fails the run.
   - **Without the profile.** The disk image is signed only and is not a release artifact.
10. **The GPL sources asset**, `draft-tide-<version>-gpl-sources.tar`, beside the disk image. It holds Git's complete corresponding source, all pinned by SHA-256:
    - **Git.** `git-2.53.0.tar.xz` from kernel.org, its hash checked against kernel.org's `sha256sums.asc`.
    - **The build scripts.** dugite-native at `v2.53.0-4`. Its `git` submodule is v2.53.0's commit (`67ad421…`), and `script/build-macos.sh` applies no patches.
    - **The rest.** `COPYING` and a README matching each archive to what ships.

Identifiers (default app id `app.drafttide.desktop`, overridable with `DT_DESKTOP_APP_ID`):

| Part | Identifier | Entitlements |
|---|---|---|
| The app | `app.drafttide.desktop` | JIT |
| Preview Host | `app.drafttide.desktop.preview-host` | JIT |
| Its helpers | `app.drafttide.desktop.helper…` (packager) | JIT |
| Engine (SEA) | `app.drafttide.desktop.engine` | JIT |
| Engine addons | `app.drafttide.desktop.engine.{better-sqlite3,peer-identity,keychain}` | none |
| Companion Node | `app.drafttide.desktop.companion-node` | JIT |
| Git | `app.drafttide.desktop.git`, `….git-remote-https` | none |
| Disk image | `app.drafttide.desktop.dmg` | — |

## The checks

| Id | What |
|---|---|
| S1 | `codesign --verify --deep --strict` on the bundle |
| S2 | Every Mach-O (20) is signed by the team's Developer ID, with hardened runtime and a secure timestamp, and carries no `get-task-allow`, dyld variables or `disable-library-validation` |
| S3 | The app, the Preview Host, Node, Engine, addons and Git have the identifiers above; of these only the Preview Host, the Node and the Engine have JIT |
| S4 | The app satisfies the desktop requirement; the Preview Host, the companion Node, the Engine and every helper fail it |
| S5 | The Engine's designated requirement pins its identifier, the Developer ID markers and the team (what its keychain item trusts) |
| S6 | The Engine carries the desktop requirement compiled in |
| S7 | The fuses read back as set |
| R1 | The signed Engine started with `NODE_EXTRA_CA_CERTS` exits with status 2, names it, and creates nothing in the data directory |
| R2 | The packaged CLI on the packaged Node starts the signed Engine (`engine.info`: this version, `desktopIdentity: code-signature`); its log shows no missing Git, identity check, GitHub App (when one was given) or Preview Host |
| R3 | The bundled Git reports 2.53.0 and reaches `git-remote-https` through `GIT_EXEC_PATH` (an unreachable https address fails to connect, not "not a git command") |
| R4 | The Preview Host, under the Engine's own supervisor (`createPreviewSupervisor`, the code the release Engine runs), renders a page whose script runs and tries the network: both PNGs have the expected sizes, the attempt is recorded as blocked, and the host reports the renderer compiled into the Engine. While it idles, the running process has its own identifier and fails the desktop requirement (`codesign --verify -R … <pid>`) |
| R5 | The app's executable started with `--dt-preview-host` exits with status 2, and so does the Preview Host started without it |

## The Preview Host's identity (spike)

Until now the Preview Host was the app's own executable in another mode, so the M1-06 rule kept release builds without one: a page that escaped Chromium's renderer sandbox into the Preview Host's browser process would run as code the Engine's desktop check admits. The spike (2026-10-03) ran the Engine's real supervisor against variants of the signed release app, then checked the live host with `codesign --verify -R <desktop requirement> <pid>`:

| Variant | Renders | Live host vs the desktop requirement | asar integrity |
|---|---|---|---|
| The app's executable with `--dt-preview-host` (before) | yes, 3.2 s cold | **satisfies it** (the hole) | checked |
| **A.** A copy of the app's executable at `Contents/MacOS/Draft Tide Preview`, signed `….preview-host`, JIT | yes, 3.1 s cold | fails it | checked: a tampered `app.asar` header stops both executables (`Integrity check failed`) |
| **B1.** A nested `Contents/Frameworks/Draft Tide Preview Helper.app` with Electron's helper executable | no: "This is a helper executable and cannot be launched directly" | — | — |
| **B2.** The same nested bundle with the app's executable, rpath pointed at the outer `Frameworks` | the browser process starts, but every child dies with "Unable to find helper app" | — | would be skipped |

Why B can't work as is: Electron 44 locates the framework, the helpers and `resourcesPath` from the executable's bundle (`MainApplicationBundlePath`); only an executable named `… Helper` resolves to the outer app. It also validates `app.asar` only when the archive is inside the bundle of the running executable (`Archive::RelativePath`), so a browser process in a nested bundle would load the outer `app.asar` unchecked. Variant A resolves everything as the app does and keeps the check.

More findings on A:
- **Not a second app.** The host is not registered with LaunchServices (`lsappinfo` finds no entry for its pid) and creates no keychain item (`Draft Tide Safe Storage` stays absent).
- **The desktop identity can't be borrowed.** A copy of the app's executable that keeps the app's signature is killed at launch (`SIGKILL`) when it sits at `Contents/MacOS/Draft Tide Preview`, and fails static verification on its own (`invalid Info.plist`). So choosing the role by executable name is sound: whatever runs as the Preview Host is not the app's executable, and the app's executable refuses the role.
- **Deep strict verification and notarization** accept an extra executable in `Contents/MacOS` (S1, and the notarized run below).

## Decisions taken here

- **The Preview Host is a second executable in `Contents/MacOS`, not a nested helper app** (2026-10-03, from the spike above). It is Electron's stub copied at packaging time and signed `<app id>.preview-host` with JIT only. In a release Main chooses the role by executable: the app's never renders a page, whatever its arguments; the Preview Host's runs only the Preview Host, and only when started with the Engine's flag. Development and E2E builds keep one binary and the flag.
- **The renderer is compiled into the Engine.** The packaging script reads it from the Electron it packages; R4 checks the packaged host reports the same, so cached previews are keyed correctly from the first render.

- **@electron/packager, osx-sign and fuses directly, not Electron Forge.** These are the parts Forge runs underneath. Forge itself needs a hoisted node linker, a `pnpm` shim on `PATH` and an override for a git-hosted `node-gyp` under pnpm ([compatibility.md](compatibility.md)), and its DMG maker brings native modules to compile. `hdiutil` makes the disk image. The Windows installer (M2) can revisit Squirrel.
- **Every file's signature is chosen, not defaulted.** osx-sign's default entitlements for an Electron app include camera, microphone, Bluetooth, location, photos and USB; nothing here uses them.
- **The environment allowlist binds release builds only.** Development Engines run from tests and tools with any environment and hold no release token. The allowlist is the OS basics plus `DRAFT_TIDE_DATA_DIR` and `DRAFT_TIDE_ENGINE_IDLE_MS`; the development knobs (`DRAFT_TIDE_GIT`, the Preview Host, the test GitHub, crash points) and `PATH` are refused, not ignored.
- **The Engine's addons and Git are found from the Engine's own executable.** Nothing at runtime names a path. In a SEA, addons load through `createRequire(process.execPath)`; better-sqlite3's loader is replaced at bundle time so it can't take a `nativeBinding` path.
- **The SEA is built from the Node that ships.** The packaging script's own Node becomes both the companion Node and the Engine's base, so the two always match, and the preflight refuses a Node that links non-system libraries.
- **Two copies of Node ship.** The custody design requires it (the Engine has its own identity; the CLI and MCP run on the companion Node). Each is about 121 MB; the app is 547 MB on disk and the disk image 202.7 MiB (M0's unsigned build: 425 MB and 160 MB).
- **Git's source comes from the same place as the app** (2026-10-03). M1 alpha ships only through GitHub Releases, so the sources tar is an asset of the same Release. GPLv2 §3 counts that as distributing the source; a link to upstream alone does not, since upstream could move or vanish. Every Release carries both assets, and the sources stay for as long as the disk image is downloadable. Shipping through another channel (a website, auto-update in M5) means putting the source in the package instead (about 8 MB).
- **`--disable-sigusr1` in what the GUI hands to agent hosts.** The CLI line and the MCP configuration start with it, so every companion process an agent host starts runs without the SIGUSR1 inspector.

## How to run

```bash
DT_APP_VERSION=0.1.0-alpha.0 DT_TEAM_ID=<team> \
DT_SIGN_IDENTITY="Developer ID Application: <name> (<team>)" \
DT_NOTARY_PROFILE=draft-tide \
corepack pnpm run release:mac
```

The release GitHub App is compiled in by default; `DT_GITHUB_CLIENT_ID` / `DT_GITHUB_APP_SLUG` name another.

The notary profile is created once with `xcrun notarytool store-credentials <profile> --apple-id <id> --team-id <team>`. Output goes to `apps/desktop/out/release/`: the disk image, the GPL sources tar and `manifest.json` (identifiers, runtime versions, check results, Gatekeeper's verdict, both files' SHA-256). Publish the disk image and the sources tar together in one GitHub Release. The first run downloads the Git binaries (62 MB) and sources (8 MB) into `apps/desktop/.cache/`.

```bash
corepack pnpm exec vitest run apps/companion/test/engine-sea.test.ts     # real SEAs: allowlist, desktop check, NODE_OPTIONS, SIGUSR1
corepack pnpm exec vitest run packages/engine-client/test/launch-layout.test.ts apps/desktop/test/release.test.ts
```

## Results (this machine)

`corepack pnpm run check`: format, lint, typecheck and build clean; **576 passed, 3 skipped** (the same skips as before). M1-08 had 556; the 20 new tests are the SEA, launch, layout and release tests. Desktop E2E: **33/33**.

Two release runs, signed with Developer ID `ZUHKJTHALN`, not notarized: all ten checks pass both times. The second run, with the Git tarball cached, took 132 s and produced a 202.7 MiB disk image. Gatekeeper rejects the app and the disk image as `Unnotarized Developer ID`, which is expected. The signed app, started against a scratch data directory, ran its GUI against the signed Engine:
- **Engine log.** `ready: release 0.1.0-alpha.0 … desktop identity code-signature`, with no refused handshake.
- **The session.** The app's Main held the Engine connection.
- **Exit.** The Engine stopped on idle after the app quit.

The window's contents were not inspected in that session (no screen-recording permission); the owner opened the packaged app and confirmed it works.

Notarized runs with the `draft-tide` notary profile, the final one with the release GitHub App compiled in:
- **Checks.** All ten pass. R2 now also requires that the Engine has a GitHub App (no `GitHub sign-in unavailable` in its log).
- **Notarization.** Apple accepted the app (as a zip) and the disk image; both tickets are stapled, and `stapler validate` passes.
- **Gatekeeper.** It accepts both as `Notarized Developer ID`, including copies given the quarantine attribute a browser download sets (the disk image, and the app copied out of the mounted image).
- **Time.** 367 s in all, most of it waiting for Apple.
- **Output.** A 204.6 MiB disk image and an 8.1 MB `draft-tide-0.1.0-alpha.0-gpl-sources.tar`.

The release GitHub App answers a device-flow request (Device Flow is on), and its page is public.

**The packaged app against the real GitHub** (2026-10-03, by the owner, in the GUI of the notarized build): sign-in with the release GitHub App `draft-tide` (device flow), installing the app on an empty repository, connecting the project to it, and the first push all succeeded. Opening that project from GitHub in another folder has not been run with the packaged app yet.

## What is left in M1-09

- **The rest of the GitHub round trip with the packaged app.** Sign-in, connecting and the first push passed (see Results); left: open the project from GitHub in another folder, save there, and pull that version back into the first folder.
- **The diagnostics export, uninstall guide and usability gate**, and the clean-machine install (no Node, Git or developer tools, offline).
- **The Engine opening the app** for a request (its location is now fixed).
- **An app icon** (the build uses Electron's).

## Known limits

- **arm64 only.** The Git subset is pinned for macOS arm64; x64 and universal builds are unmeasured.
- **Chromium's profile shares the data directory.** Electron's `userData` is `~/Library/Application Support/Draft Tide`, the default data store, even when `DRAFT_TIDE_DATA_DIR` points elsewhere (pre-existing in development builds). Chromium's files sit beside `state.sqlite`; nothing collides today, but the diagnostics export and uninstall guide must account for it, or `userData` should move to a subfolder.
- **`hdiutil create` prints a deprecation warning** on macOS 27 (`diskutil image create` replaces it); it still works.
- **Windows and Linux** have no release packaging (desktop identity unverified there).
