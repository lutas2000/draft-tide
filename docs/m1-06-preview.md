# M1-06: previews and side-by-side comparison

Date: 2026-10-02 · Machine: macOS 27.0.1, Apple Silicon (arm64), Node 24.18.1, Electron 44.5.1 (Chromium 152.0.7977.130), Apple Git 2.54.0 · Work package: M1-06 ([M1 plan §12](../.ref/M1_IMPLEMENTATION_PLAN.md))

M1-06 lets designers see their versions. Every version's entry page is rendered offline by an isolated Preview Host into a 1280×800 picture and a thumbnail. The history shows each version's thumbnail. Selecting a version shows its picture, and it can be enlarged with what the page was missing and how it was rendered. Comparing two versions puts their pictures side by side and says when they are pixel-identical. A changed PNG or JPEG shows as each version holds it. A preview that can't be made says why, and the version is untouched. The CLI (`preview`) and MCP (`snapshot_preview`, `preview_read`) get the same artifacts behind agent access.

M1-06 depends on M1-04, which is done (`docs/m1-04-manual-flow.md`).

## What was built

| Module | Contents |
|---|---|
| `packages/contracts` | `preview.ts`: render settings (viewport, thumbnail, locale, time zone, scripts, wait and animation strategy), budgets, served content types, `PreviewSubject`, `PreviewArtifact`, `PreviewRecord` (the cache's local format), `PreviewChunk`, `PreviewStatus`, and the stable reasons of `PREVIEW_UNSUPPORTED`, `PREVIEW_FAILED`, missing files and blocked actions. `preview-host.ts`: the Engine ↔ Preview Host pipe protocol, the renderer id, and the development launch spec. Four catalog operations (below). 85 JSON Schemas (73 before) |
| `packages/core` | `preview.ts`: what a version shows (from its own `.drafttide.json`), the file source a render may read, cache keys, the render queue (one at a time, the app's before background ones, identical renders shared), output checks, the LRU cache, artifacts. `image-info.ts`: PNG and JPEG sizes from their headers, fitting. Ports: `PreviewRenderer`, `PreviewImageStore`, the cache methods of `LocalStore`. A save or restore warms the new version's preview in the background |
| `packages/local-store` | Migration 3: `preview_cache` (an explicit cache table; an unreadable row is dropped, not reported) |
| `packages/engine-client` | `host-framing.ts`: the pipe's frames (header length, body length, JSON header, raw body), decoded without quadratic copying |
| `apps/companion` | `preview-host.ts`: the supervisor (starts the host, serves its fetches, enforces timeouts, kills and cleans up). `preview-images.ts`: the PNG files. The Engine wiring, `DRAFT_TIDE_PREVIEW_HOST` (development only, forwarded by the CLI), the CLI's `preview`, the MCP instructions |
| `apps/desktop` | `src/preview-host/host.ts`: the Preview Host mode of the app binary. `main.ts` now only dispatches between the GUI (`app.ts`) and the host. Main gives the Engine its launch spec. GUI: thumbnails in the history (rendered when a row scrolls into view), the picture in the version panel, the enlarged picture with what was missing and how it was rendered, side-by-side pictures in the comparison, both pictures of a changed PNG or JPEG, a preview card in settings (availability, renderer, settings, cache, clear) |

### Operations added to the catalog

| Operation | Desktop | Tool channel (CLI, MCP) | Effect |
|---|---|---|---|
| `snapshot.preview` | yes | with agent access | read |
| `preview.read` | yes | with agent access | read |
| `preview.status` | yes | not offered | read |
| `preview.clearCache` | yes | not offered | write |

## How a preview is made

1. **What to show.** The version (a snapshot id or a commit id on the line) is resolved as for a comparison. A page preview shows the first entry file of the version's own `.drafttide.json`, so an older version shows the page it had. With `file`, a PNG or JPEG of the version is shown instead. A version without settings, without an entry page, with a broken settings file or an entry that isn't HTML, PNG or JPEG is `PREVIEW_UNSUPPORTED` with its reason; nothing is started.
2. **The cache key** covers the version's whole tree and the entry (a page may load any file), or the image's blob, plus the render settings and the renderer. Equal trees share a preview: a restore version shows the restored version's picture without a render. A hit answers at once.
3. **The queue.** One render at a time. Renders the app or an agent asks for go before the background ones a save or restore starts; identical requests share one render; at most 64 wait (`queue-full`).
4. **The Preview Host.** The Engine starts the app binary with `--dt-preview-host`, one host per project, reused for up to 20 jobs and stopped after 10 idle seconds. It gets an inherited pipe (fd 3), a fresh scratch directory and an environment built from scratch: `PATH`, `HOME` and `TMPDIR` (the scratch directory), `TZ` and `LANG`. No data directory, database, Git, tokens or Engine channel.
5. **Serving the page.** Every `dt-preview://job/<path>` request travels over the pipe to the Engine. Core decodes the path once and accepts only a safe relative path. It serves only regular files of that version's tree (an image job only the image), of a type previews use, within 32 MiB per file, 256 MiB and 2,000 requests per render. Everything else is answered "missing" and recorded with its reason.
6. **Rendering.** An offscreen window of exactly the output size renders with a sandboxed, context-isolated renderer, no Node or preload, and an in-memory session for the job. Software rendering, `en-US`, the computer's time zone, and dialogs disabled. Animations and transitions jump to their end. After the load event the host waits for web fonts, two frames and 300 ms, then captures. A PNG or JPEG is shown on a host-made page fitted (never enlarged) into 1600×1600 on a checkerboard.
7. **Checking and keeping.** Both PNGs must have exactly the sizes the Engine asked for. They are written to `projects/<id>/cache/previews/` (temporary name, then rename), and the record goes into `preview_cache`. Least recently used previews go beyond 256 MiB; the newest always stays.
8. **The artifact.** The caller gets an artifact: the version, what was shown, both images' sizes and SHA-256, what was missing and blocked, whether it was cached, the settings and the environment. It is valid for 30 minutes and bound to the project. Its PNGs are read with `preview.read` in base64 chunks of at most 512 KiB. It is never a path.

## Decisions taken here

- **The Engine supervises the Preview Host** (as the architecture in CLAUDE.md has it), rather than Main. Previews work for the CLI and MCP whenever the Engine knows its host, and the host never talks to Main or the Engine's socket.
- **Where the Engine finds the host.**
  - **Development and e2e builds.** Main passes its own Electron and Main bundle in `DRAFT_TIDE_PREVIEW_HOST` when it starts the Engine. The CLI forwards the variable in development builds. An Engine the CLI started without it has no host.
  - **Release builds** ignore the variable. M1-09 places the host in the app bundle. Until then a release Engine answers `no-renderer`.
  - This refines the default proposed before M1-06 ("previews only while the GUI is open"). Previews depend on whether the Engine knows the host, not on the GUI being open.
- **Files are served on request, not copied into a workspace.** M0 rendered a workspace copied to disk. Here the host asks the Engine for each file, and core answers from Git. The host can read nothing else of the project, nothing is written for a render, nothing is left behind after a crash, and every request the page makes is seen. That gives the missing list now and the per-page dependency map M2 needs later.
- **Scripts run** (the default agreed before M1-06): connecting the folder in the app is the trust decision for its pages. The network stays closed either way.
- **The network is closed below the page, not by its CSP.**
  - **Four layers.** The session's request filter cancels everything but `dt-preview://job/`, `dt-preview://frame/`, `data:` and `blob:`. DNS maps every name to nothing (`host-resolver-rules`). WebRTC may only use a proxy, and the proxy is a dead `127.0.0.1:9`. Permissions, downloads, popups, navigation and webviews are refused.
  - **Why no CSP restriction on sources.** It would stop requests before the filter sees them, so they'd vanish instead of showing as blocked. The page's CSP only closes `object-src`, `base-uri` and `form-action`.
- **Previews are of versions only.** What is rendered always comes from Git, never from the folder's unsaved state. A preview never reads the folder or writes to it or its `.git` (tested with a digest of both).
- **Images are checked before anything decodes them.** The header must be a PNG (signature and IHDR) or a JPEG (segments walked with bounds checks to a frame header), within 50 million pixels and 32 MiB. Decoding happens only in the sandboxed renderer. The app shows only PNGs the host produced, after checking their SHA-256 against the artifact.
- **Failures are never cached.** A failed render answers `PREVIEW_FAILED` with its reason (`timeout`, `crashed` and `queue-full` are retryable). The next request tries again. `invalid-output` covers a PNG of the wrong size or no PNG.
- **Timeouts.** The host reports `timeout` 20 s into a job. The supervisor kills a host that hasn't answered 5 s later. Core gives up 15 s after that. A page stuck in a loop has its renderer crashed; a host that stops answering is killed.
- **The thumbnail comes after the save.** `snapshot.create` and `restore.apply` start a background render of the new version once they have returned their result (M1 plan §7.1 step 9). A failure there is dropped.
- **The cache is a cache.** An unreadable `preview_cache` row is dropped. A row whose PNG is gone is rendered again. PNGs no row names are removed at Engine start. `preview.clearCache` removes everything and invalidates all artifacts.
- **Artifacts, not paths, cross the boundary.** `preview.read` checks the artifact's project (`artifact-of-another-project`), expiry (`artifact-expired`), id (`unknown-artifact`) and offset (`offset`), all `INVALID_ARGUMENT`. The app asks again for an expired artifact once, on its own.
- **Text from the page is untrusted.** Missing paths and blocked targets are made printable and cut to 200 characters, 20 samples each, before they leave the Engine. The counts cover everything.
- **The GUI bounds itself.** At most three preview calls wait at once (each holds one of the desktop connection's request slots). History thumbnails start only when their row is on screen. Blob URLs are released when their query leaves the cache.

## How to run

```bash
corepack pnpm run check                                                  # everything
corepack pnpm exec vitest run packages/core/test/preview.test.ts           # what a version shows, serving, cache, queue
corepack pnpm exec vitest run apps/companion/test/preview.test.ts          # a real Engine, Git and SQLite (scripted host)
corepack pnpm --filter @draft-tide/desktop run test:e2e                  # the app with the real Preview Host (macOS)
corepack pnpm run desktop                                                # try it: select a version, 比較版本
```

With agent access on (設定與診斷):

```bash
node apps/companion/dist/cli.mjs --project <id> preview <snapshot-id>
node apps/companion/dist/cli.mjs --project <id> preview <snapshot-id> --out v3.png
node apps/companion/dist/cli.mjs --project <id> preview <snapshot-id> --out thumb.png --thumbnail
node apps/companion/dist/cli.mjs --project <id> preview <snapshot-id> --file img/hero.png --out hero.png
```

An Engine the CLI starts in development has a Preview Host only when `DRAFT_TIDE_PREVIEW_HOST` is set. The app sets it for the Engine it starts.

## Results (this machine)

`corepack pnpm run check`: format, lint, typecheck and build clean; **495 passed, 3 skipped** (the same Linux-only skips). M1-05 had 439. Desktop E2E: **27/27** (6 new).

| Suite | Tests | What they show |
|---|---|---|
| Contracts | 10 new | Previews need agent access on the tool channel and are reads; the cache is the app's. Inputs take a version reference and a safe image path, nothing self-asserted. An artifact is strict (no path, at most 20 samples of 200 characters). A chunk fits one control message. Content types by extension only (`constructor` and `__proto__` aren't types). The host pipe carries a job, file answers and four host messages, nothing else |
| Core | 25 new | The entry page from the version's own settings, served only from that version: `../` and encoded tricks refused, a missing file recorded, blocked targets made printable. A second request, and a restore of the same tree, from the cache. Identical requests render once; the app's before the background's; an overfull queue refused. Every unsupported reason, with nothing rendered. A failed render passed on and never cached; PNGs of the wrong size refused. No renderer: `no-renderer`, while unsupported versions still say why. Images: fitted, served alone, shared between copies, decoded only when the header checks out and fits the budget. Artifacts bound to their project, expiring, read in 512 KiB chunks. LRU eviction keeping the newest; a vanished PNG rendered again; clear; the sweep at start. The file source's budgets and Unicode forms. Image headers never throw on any bytes (property); fitting never enlarges (property) |
| Local store | 3 new | Cache rows across reopen, least recently used first, replaced on a new render; an unreadable row dropped, not reported; migration from version 2 with a backup |
| engine-client | 3 new | Host frames decode at any split (property); an 8 MiB body in 64 KiB chunks joined once; sizes over the limits refused before buffering |
| Companion: supervisor (scripted host) | 6 new | Renders through the host, which sees only what the file source serves; its environment is exactly `DT_PREVIEW_SCRATCH`, `HOME`, `LANG`, `PATH`, `TMPDIR`, `TZ` (on Windows, the variables Draft Tide sets plus those libuv requires of every Windows process, such as `PATH`, `USERNAME` and `WINDIR`); its scratch directory is removed. One host per project. A crash, a reported timeout, a garbage frame, another protocol or another renderer each become `PREVIEW_FAILED` with the host stopped. A silent host is killed after the job's time and grace; a cancel stops it at once. No launch, or a release build, has no renderer |
| Companion: previews (real Engine, Git, SQLite) | 9 new | A version rendered from Git: the folder and its `.git` byte-for-byte unchanged, `git status` clean, the PNGs only in the data directory. An unsaved edit never shows; the next version shows it. The thumbnail made after a save; a restore's preview from the cache. An image fitted; a missing entry and a non-image refused. Another tool's commit previewed by its commit id. Clear. CLI: agent access needed; `--out` writes the PNG the artifact's hash names and never overwrites; `--thumbnail`; human output lists what was missing and blocked; exit codes. MCP: `snapshot_preview` and `preview_read`. An Engine without a host says so and everything else works |
| Desktop E2E (real Preview Host) | 6 new | Thumbnails in the history and the selected version's picture, enlarged with how it was made. Two versions side by side; a restore of V1 compared with V1 is pixel-identical. A changed PNG: the fixture's unreadable bytes explained on one side, the new image on the other. An isolation probe page: no `require`, `process` or bridge; external, loopback, LAN, `file:` and `app://` fetches blocked; `..` and encoded `..` never leave the version; WebSocket blocked; popup null; geolocation denied; no WebRTC candidate beyond host; a TCP and a UDP listener on all interfaces receive nothing; navigation, popup, permission and network attempts recorded. An entry that isn't a page explained while the version stays restorable. The settings card and clearing the cache |

Timing (one machine, informational; 1,503 files, 16 MB: 1,400 text files, 100 images; the entry page loads one stylesheet and 20 images; three runs):

| Case | Result |
|---|---|
| First preview after the Engine starts (host start included) | 0.89–1.02 s |
| Another version, host running | 0.68–0.69 s |
| A version already in the cache | 81–111 ms |
| A PNG of the version (host running) | 185–203 ms |
| Reading the full PNG (9 KB) | 2 ms |

A render with the host running is mostly the fixed wait (fonts, two frames, 300 ms) and the capture. A cache hit is mostly reading the version (Git) to compute its key.

## Known limits and follow-ups

- **The Preview Host must get its own signing identity before release (M1-09).** In this build it is the app binary in another mode. A renderer that escaped Chromium's sandbox into the host would run as code signed like the desktop app, which the Engine's desktop check admits. The release must ship the host as a separate signed helper with its own identifier, outside the desktop requirement. Until then, release builds have no Preview Host at all.
- **A release Engine has no previews yet.** It needs the host's place in the bundle (M1-09).
- **Development Engines started by the CLI** have a host only with `DRAFT_TIDE_PREVIEW_HOST`.
- **One page, one viewport.** Only the first entry file is previewed, at 1280×800 and only the visible viewport. More entry pages, viewport presets, full-page captures and per-page comparison are M2.
- **Fixed environment.** The locale is `en-US`: a page without a `lang` attribute picks fonts for that locale. The time zone is the computer's (recorded). Scripts' `Date` and `Math.random` are not frozen, so a page that draws the time renders it as of the render. Rendering is software-only (deterministic, slower WebGL).
- **Equal pictures mean equal PNG bytes.** "完全相同" compares SHA-256 of the captured PNGs. Pictures equal in pixels but encoded differently would show as different; none have been seen.
- **MCP returns base64 chunks.** Image content blocks for agents are left to M1-08.
- **Not exercised here.** The real Preview Host runs only on macOS here; Windows and Linux CI run the Engine side with the scripted host (on Windows its fd-3 pipe must be overlapped: a synchronous one deadlocked on the first write). The real Electron host on Windows is untested. Screen readers in the new picture views.
