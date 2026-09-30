# Storage benchmark (M0)

The storage strategy measured here keeps every in-scope raw file directly in a per-project bare Git (TECH_STACK §6.0). The figures come from one machine and one fixture. They are measurements, not product limits or promises.

- **Environment:** macOS 27.0.1, Apple Silicon (arm64), APFS SSD, Node 24.18.1.
- **Git:** 2.53.0 from dugite-native, in two variants: the full tarball (`dugite-dev`) and the trimmed 3.2 MiB `bundled` build.
- **Driver:** `node spikes/m0/core/src/storage/run.ts` (`M0_CAPTURE_MODE=fast|strict`, `DRAFT_TIDE_GIT_ROOT=<trimmed git>`).

## Fixture

An agent-made web design, generated at run time with a deterministic seed:

| | |
|---|---|
| Files in scope | 1,034 (index + 5 pages, 11 CSS, 11 JS, 600 HTML partials in 20 folders, 300 SVG, 40 JSON, 52 PNG, 4 JPEG, 3 TTF, edge cases) |
| Size | 29.3 MiB, of which binary assets are 29.0 MiB. PNGs are photo-like noise (near-incompressible), JPEGs come from `sips`, fonts are system TTF copies |
| Edge cases | CRLF, UTF-8 BOM, empty file, exec bit, no trailing newline, `設計稿/首頁 草稿.html` |
| Excluded by default | `.git/` (with hostile hooks and filters), `node_modules/`, `.env.local`, `.DS_Store`, `*.log` |
| History | Baseline + 50 iterations. Each iteration edits tokens.css, pricing.html, 2 random partials and every 5th app.js. There are 3 asset replacements (two 1600×900 PNGs, one 800×600 PNG), 1 new 1600×900 PNG, a rename, a delete, a CRLF edit and an exec-bit-only change |

## Results

All three runs pass 31/31 checks.

| Metric | fast (dugite) | fast (trimmed bundled Git) | strict (dugite) |
|---|---|---|---|
| Baseline save (1,034 files, 29.3 MiB) | 1,446 ms | 1,420 ms | 3,825 ms |
| – staging (stream + hash into staging) | ~200 ms | ~220 ms | 2,499 ms (fsync per file) |
| – writing Git objects (930 objects) | 1,051 ms | 1,031 ms | 977 ms |
| Iteration save, mean / p95 | 510 / 581 ms | 561 / 717 ms | 2,939 / 3,044 ms |
| – full rescan with rehash, mean | 158 ms | 175 ms | 193 ms |
| Stream-verify all 51 versions (1,612 MiB) | 7.1 s | 8.0 s | 6.5 s |
| Restore to V1 (101 writes, 2 deletes, protection first) | 1.3 s | 1.3 s | 3.6 s |
| Backup export (.drafttide) | 1.4 s | 1.4 s | 1.4 s |
| Backup import + fsck + materialize | 4.0 s | 3.9 s | 4.3 s |
| Capture retries needed | 0 | 0 | 0 |

"strict" fsyncs every staged file and hashes every staged file into Git. "fast" skips the staging fsync and hashes only content Git does not already have. Both modes fsync new Git objects (`core.fsync=objects,reference`) before the ref update. An earlier fast run with `core.fsyncMethod=batch` took 4,102 ms to write the 930 baseline objects, against about 1,000 ms with the default method, so batch mode was dropped.

### History growth

The numbers are identical in all runs because the content is deterministic.

| | |
|---|---|
| Design folder | 29.3 MiB |
| History after 51 versions, loose objects (1,522 files) | **47.2 MiB** |
| Same history, packed (`repack -a -d` on a copy, 1.4 s) | 41.6 MiB |
| 51 full copies (no reuse) | 1,612 MiB |
| Baseline history | 31.9 MiB |
| Mean growth per text-only iteration | ~45 KiB (at most 13 new objects for at most 7 changed files) |
| Growth per asset replacement or addition | 3.9, 4.1, 1.4, 3.9 MiB (≈ the new asset's size; noise PNGs don't delta) |
| Backup file (bundle + manifest) | 41.5 MiB for 54 snapshots |

### Memory

The harness process peaked at 420–465 MiB RSS. That number includes the harness's own manifests (independent `readFile` hashing of every version) and GC slack, so it is **not** the Engine's footprint. In `engine/verify.ts`, the Engine process itself used 92–104 MiB RSS after binding, saving and restoring. M1's benchmark needs to measure the Engine separately, on this fixture.

## Recommendations

1. **Keep the strategy.** Raw bytes round-trip exactly, assets are stored once per distinct content, and a backup alone restores all versions. The M0 gate for storage is met without LFS or a second asset store.
2. **Make staging durability optional in the spec.** Staging is discarded on a crash, and the ref is published only after the new Git objects are durable. Adopt "fast" capture: stage every file (objects still come only from staged bytes), fsync only new Git objects, and use the default `core.fsyncMethod` on APFS. That cuts save time by about 5.7× on this fixture.
3. **Budget the full rescan.** The rehash costs about 160 ms for 29 MiB and grows linearly with bytes. The M1 contract ("no mtime shortcuts") is affordable at this scale. Re-measure at the §13.4 upper range (tens of MiB, about 1,000 files: this fixture) and above.
4. **Asset replacement costs roughly the asset's size every time.** For designs with frequent large-image swaps, track this in M1 telemetry-free local diagnostics (history size) rather than adding LFS preemptively.
