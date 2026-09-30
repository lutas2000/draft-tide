# Compatibility record (M0)

This file records what was actually tested, not what is supported. Everything below is an unsigned M0 spike build on one development machine.

## Tested platform

| | |
|---|---|
| OS / CPU | macOS 27.0.1 (26A434), Apple Silicon arm64 |
| Filesystem | APFS (case-insensitive, normalization-insensitive) |
| Clean machine | **Not tested.** Approximations: the app launched with `env -i` and `PATH=/usr/bin:/bin`, and the CLI ran with an empty environment from the read-only mounted DMG. Xcode is installed on this machine, so a missing-developer-tools case is unproven |
| Windows / Linux | Not tested |

## Runtime set in the package

| Component | Version | Where it runs | Notes |
|---|---|---|---|
| Electron | 44.5.1 (Chromium 152.0.7977.130, internal Node 24.21.0) | GUI shell, Preview Host | Electron's Node is never used for the Engine |
| Companion Node | 24.18.1 (official build, 115.5 MiB) | Engine, CLI, MCP | `Contents/Resources/node/bin/node`; the launcher never consults `PATH` |
| better-sqlite3 | 13.0.3, SQLite 3.53.4 | Engine only | Ships N-API prebuilds for darwin/linux/linuxmusl/win32 × x64/arm64, so nothing is compiled. The app copies one prebuild. Forge has no native modules to rebuild |
| Git | 2.53.0 (dugite-native v2.53.0-4) | Engine only | Trimmed to `bin/git` + `libexec/git-core/git -> ../../bin/git` (3.2 MiB; the full tarball is 148 MiB, mostly Git Credential Manager/.NET and git-lfs). Links only to system libz, libiconv, CoreServices and CoreFoundation. Passes all 31 storage checks, including bundle, fetch-from-bundle, fsck and repack |
| MCP SDK | @modelcontextprotocol/sdk 1.31.0 (zod 4.6.5) | MCP stdio server | `McpServer.registerTool`, `StdioServerTransport` |
| CLI | commander 15.0.0 | CLI | |
| Backup container | yazl 3.3.1 / yauzl 3.4.0 | Engine | |
| GUI | React 19.3.0, Vite 8.3.1, Tailwind 4.3.3 | GUI renderer | |
| Build | TypeScript 7.0.2 (native), esbuild 0.28.2, pnpm 12.8.1 via corepack | | |
| Packaging | @electron-forge/cli 7.11.2, maker-dmg, maker-zip, plugin-fuses, @electron/fuses 2.1.3 | | Forge 8.0.1 was published 2026-09-29, and pnpm's minimum-release-age excluded it |

## Package measurements

| Artifact | Size |
|---|---|
| `Draft Tide M0.app` | 425 MB: Electron Frameworks 287 MB, Node 128 MB, companion 5.0 MB, Git 4.1 MB, GUI 0.4 MB, app.asar 28 KB |
| DMG (ULFO) | 160 MB |
| ZIP | 176 MB |
| Engine cold start (12 racing CLI clients, local .app) | 246–548 ms until every client has the handshake |
| CLI + Engine cold start from the mounted DMG | ~2.7 s (first read from the compressed image) |
| Engine takeover after `kill -9` | 186–258 ms |
| MCP server connect + list tools | 67–123 ms |
| Engine RSS after bind, save and restore | 92–104 MiB |
| Preview Host render (process start → 1280×800 PNG) | ~1.6 s |

## Build hardening that works together

- **Fuses:**
  - Disabled: RunAsNode, EnableNodeOptionsEnvironmentVariable, EnableNodeCliInspectArguments, GrantFileProtocolExtraPrivileges.
  - Enabled: OnlyLoadAppFromAsar, EnableEmbeddedAsarIntegrityValidation, EnableCookieEncryption.
  
  The design keeps working with these fuses because the Engine runs on its own Node and the Preview Host is the app executable relaunched with `--dt-preview-host`.
- **Code signing:** after the fuses plugin, the bundle's ad-hoc seal was invalid (`invalid Info.plist`). A `postPackage` hook now runs `codesign --force --deep --sign -`, and `codesign --verify --deep --strict` passes. As expected, `spctl` rejects the app. Releases need Developer ID, hardened runtime with entitlements for the bundled Node (JIT), and notarization.

## Toolchain findings

- **pnpm 12 defaults:**
  - Build scripts need `allowBuilds` for electron, esbuild and dugite; better-sqlite3 13 needs none.
  - `blockExoticSubdeps` rejects Forge's git-hosted `@electron/node-gyp`. Fixed with `overrides: "@electron/node-gyp": "10.2.0-electron.2"`, which is on the npm registry.
  - `minimumReleaseAge` held Forge at 7.11.2.
- **Forge with pnpm:** Forge needs `nodeLinker: hoisted`, and its system check shells out to `pnpm`. With corepack-only pnpm, a `pnpm` shim must be on `PATH` during `make`.
- **Unix socket paths:** macOS limits them to 104 bytes. Long data dirs fall back to `$TMPDIR/dt-<hash>.sock`. M1 must pick the runtime location.
- **TypeScript 7:** no longer includes `@types/*` implicitly, so each package sets `"types"`.
