# Safety model: interfaces and authorization (M0 design)

M0 draft of the interface and authorization design (ROADMAP §5). Parts marked **verified** were exercised by `spikes/m0/core/src/engine/verify.ts` (dev and packaged, 16/16). Parts marked **open** are M1-00 work. The product contracts live in `.ref/`; this document does not change them.

> **Partly superseded (2026-10-01).** The single-repo design ([single-repo-spike.md](single-repo-spike.md)) replaces the per-project bare repo with the project's own Git repo. Still valid as written: processes and channels, single writer, the channel and operation table, approvals, preview isolation and the known limits. Superseded: the "per-project bare Git" in the diagram; the **User repository** bullet under Git and filesystem hygiene (the Engine now manages the project's `.git` within the limits in `CLAUDE.md`, and that design was checked with a hostile-repo suite instead of a before/after digest); the `-c` flag list and `--template=` bullet (extended, and network operations now run in an ephemeral git dir); and the backup manifest in the metadata-privacy bullet (there is no backup container). New operations on the desktop channel only: GitHub sign-in, connecting a remote, the first push and pull (which writes working files). The tool channel gets no operation that returns a token.

## Processes and channels

```text
React GUI (sandboxed, app://gui) ── preload: draftTide.engineInfo() only
      │ ipcMain (senderFrame must be app://gui/)
Electron Main ── desktop channel ─┐
CLI  (bundled Node) ── tool channel ─┤   Unix socket 0600 in runtime/ 0700
MCP  (bundled Node) ── tool channel ─┘   length-framed JSON, no HTTP
                                     ▼
                         Engine (bundled Node) — only writer
                         SQLite state.sqlite (WAL, synchronous=FULL)
                         per-project bare Git, preview cache
                                     │ read-only workspace path only
                                     ▼
                         Preview Host (app exe --dt-preview-host)
```

## Single writer (verified)

- **Election.** The Engine opens `runtime/engine.lock.sqlite` with `locking_mode=EXCLUSIVE` and holds `BEGIN EXCLUSIVE` for its whole life, with `busy_timeout=0`. The OS lock (fcntl, and `LockFileEx` on Windows, which is untested) is released when the process dies, so no pid, file age or heartbeat is needed to decide ownership. A losing Engine exits immediately.
- **Discovery.** Only the lock holder deletes a stale socket, then writes `runtime/engine.json` atomically (pid, instanceId, protocol and storage versions, socket, tool token; mode 0600).
- **Clients.** A client reads discovery, connects, and runs the handshake, which must return the same `instanceId`. Otherwise it starts the Engine with the **bundled Node** and polls. There is no fallback writer. Twelve racing cold starts end with one Engine, and `kill -9` is followed by a clean takeover.
- **Version checks.** The handshake checks `protocolVersion` and `storageSchemaVersion`. On a mismatch the client gets `PROTOCOL_MISMATCH` and does not start a second Engine. At startup, the Engine refuses to write when the stored schema is unknown.
- **Project writes.** In-process project guards serialize writes. Git `update-ref` with the expected old OID is the last line of defense: two unsynchronized writers produce one success and one `HISTORY_CHANGED`, with no lost or forked commit.

## Channels and operations

| Operation | Tool channel (CLI, MCP) | Desktop channel |
|---|---|---|
| engine.info, project.list / status, history.list | yes | yes |
| snapshot.create (kind `manual` for GUI/CLI, `agent-requested` for MCP) | yes | yes |
| restore.plan (read-only; stores the plan as an operation) | yes | yes |
| operation.requestApproval (always answers `CONFIRMATION_REQUIRED`, notifies desktop) | yes | yes |
| operation.status, restore.apply | yes | yes |
| project.bind (scope review) | **no** | yes |
| approval.list / approval.decide | **no** | yes |
| preview.prepare (read-only workspace for the Preview Host) | **no** | yes |

An operation that does not exist on a channel returns `UNKNOWN_OPERATION`. The Engine never offers approve, shell, Git passthrough or arbitrary file reads to tool clients (verified).

## Approvals (verified)

- `approval.decide` writes a row bound to operationId, caller kind, project, operation kind, plan fingerprint and expiry. The expiry is at most 5 minutes and never later than the plan's.
- `restore.apply` consumes that row in the **same SQLite transaction** that moves the operation to `confirmed`. Denied, consumed, expired or mismatched rows are refused, and so is an apply from a different caller kind.
- Fields a caller adds, such as `confirmed: true`, `approvalId` or `force`, are ignored. The CLI has no `--yes` or `--force`.
- After approval, `applyRestore` re-checks HEAD and the live fingerprint. A file changed after approval gives `PLAN_STALE`, and the edit survives.
- The GUI confirmation is a native `dialog.showMessageBox` owned by Electron Main. It shows the Engine-computed summary (overwrite, add and delete counts, protection note, stop-writers note) and never renders design content.

## Git and filesystem hygiene (verified)

- **Process isolation.** Git runs via `spawn` with argument arrays and an environment built from scratch: no inherited `GIT_*`, `HOME` set to an empty directory, `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_ALLOW_PROTOCOL=file`. The `-c` flags disable hooks, the attributes file, fsmonitor, autocrlf, auto GC and maintenance, and signing. The repo is created with `--template=`, so it has no sample hooks. `hash-object --no-filters`.
- **User repository (M0 design, superseded).** The designer's `.git` is never read or written. The test compares a byte-level digest of the whole directory before and after, with hostile hooks and filters present and a hostile parent environment.
- **Capture.** Symlinks and special entries stop the capture (`UNSUPPORTED_ENTRY`). Files are opened with `O_NOFOLLOW` and their inode is re-checked. Case and normalization collisions are rejected.
- **Write-back.** Restore writes a temp file in the target folder, fsyncs and closes it, re-checks the expected old OID, then renames. A symlinked or non-directory parent is refused.
- **Metadata privacy.** Commit metadata and the backup manifest contain no absolute paths, home directory or user name. This is checked by scanning every commit and the manifest.

## Preview isolation (verified in dev and packaged builds)

- **Process.** The Preview Host is a separate process: the app executable with `--dt-preview-host <job.json>`, a minimal environment (no data dir, no tokens) and its own `userData`.
- **Renderer.** An offscreen BrowserWindow runs with `sandbox`, `contextIsolation`, no `nodeIntegration`, no preload and an in-memory `session.fromPartition` (no `persist:`).
- **Protocol.** `dt-preview://job/<path>` serves only regular files from the read-only workspace, with an allowlist of types and a per-file preview budget. A decoded path must stay inside the workspace (403 otherwise). Responses carry a CSP limiting everything to `dt-preview:` and data or blob URLs.
- **Everything else.**
  - Requests: `webRequest` cancels every other scheme.
  - Permissions: all denied (geolocation was attempted and denied).
  - Windows and navigation: `window.open` and navigation are denied.
  - Downloads, webviews and service workers: downloads are prevented, webviews blocked, service worker registration refused.
- **Probe results.** `require`, `process` and the GUI bridge are undefined. External, loopback, private-net, `file:` and `app://` fetches are all blocked. Plain `..` is normalized and returns 404, encoded `..` returns 403. Only the page's own asset can be read.

## Known limits (by design)

- A process running as the same OS user with an unrestricted shell can bypass every product API boundary: edit design files, read the tokens, or talk to the socket. Draft Tide is not that agent's sandbox (TECH_STACK §9). Live-writer checks, per-file verification and the append-only history stay necessary.
- Optimistic capture is not a cross-file atomic snapshot. `SOURCE_BUSY` catches files that keep changing, but a tool that pauses between two related writes can still be captured in between.

## Open for M1-00

1. **Desktop enrollment.** In M0 the desktop credential is a 0600 `runtime/desktop.token` file, readable by any same-user process. Candidate replacements:
   - macOS: get the peer's audit token (`LOCAL_PEERTOKEN`) and check its code signature against the app's designated requirement. This needs a small native addon in the companion.
   - Windows: `GetNamedPipeClientProcessId` plus Authenticode verification.
   - Alternative: Electron Main spawns the Engine and passes an inherited socketpair. That only works when the desktop starts the Engine, so it also needs an upgrade path for an Engine the CLI started.
2. **Caller identity.** M0 binds approvals to the client kind (`mcp`, `cli`). M1 needs per-host enrollment, for example "Claude Code on this Mac", shown in the dialog.
3. **Recovery.** The operation journal covers approval consumption and state, but not per-file write-back steps or crash recovery (M1-05).
4. **Windows transport and locking.** The named pipe ACL and the SQLite lock behavior are untested.
