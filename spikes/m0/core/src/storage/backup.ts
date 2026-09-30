// `.drafttide` portable backup: a ZIP holding manifest.json,
// scope-policy.json and a Git bundle of the whole saved history. No local
// binding, absolute paths, approvals or agent settings are exported.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, readFile, readdir, rm, stat, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { z } from 'zod';
import { DtError } from '../shared/errors.ts';
import type { GitRuntime } from '../shared/git.ts';
import { canonicalJson } from './metadata.ts';
import type { ScopePolicy } from './scope.ts';
import { ProjectStore } from './store.ts';

const FileRef = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().nonnegative() }).strict();

export const BackupManifestSchema = z
  .object({
    format: z.literal('draft-tide-backup'),
    schemaVersion: z.literal(1),
    createdAt: z.iso.datetime(),
    generator: z.object({ name: z.string().max(100), version: z.string().max(50) }).strict(),
    project: z.object({ sourceProjectId: z.uuid(), displayName: z.string().max(200) }).strict(),
    refs: z.object({ 'refs/heads/main': z.string().regex(/^[0-9a-f]{40}$/) }).strict(),
    snapshots: z.array(z.object({ snapshotId: z.uuid(), commit: z.string().regex(/^[0-9a-f]{40}$/), kind: z.string().max(32) }).strict()).max(1_000_000),
    files: z.object({ 'history.bundle': FileRef, 'scope-policy.json': FileRef }).strict(),
  })
  .strict();
export type BackupManifest = z.infer<typeof BackupManifestSchema>;

const ScopeFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    entryFiles: z.array(z.string().max(1024)).max(16),
    scopeHash: z.string().regex(/^[0-9a-f]{64}$/),
    policy: z.object({ schemaVersion: z.literal(1), excludeDirNames: z.array(z.string().max(255)), excludeFilePatterns: z.array(z.string().max(255)) }).strict(),
  })
  .strict();

// Budgets for the import container itself (never a cap on the design).
const JSON_ENTRY_BUDGET = 8 * 1024 * 1024;
const MAX_JSON_RATIO = 200;
const ALLOWED_ENTRIES = new Set(['manifest.json', 'scope-policy.json', 'history.bundle']);

async function sha256File(path: string): Promise<{ sha256: string; size: number }> {
  const h = createHash('sha256');
  let size = 0;
  for await (const c of createReadStream(path)) {
    h.update(c as Buffer);
    size += (c as Buffer).length;
  }
  return { sha256: h.digest('hex'), size };
}

export async function exportBackup(store: ProjectStore, outFile: string, displayName: string): Promise<{ file: string; bytes: number; bundleBytes: number; manifest: BackupManifest }> {
  return store.guard(async () => {
    const head = await store.head();
    if (!head) throw new DtError('PROJECT_NOT_BOUND', 'nothing saved yet');
    const opDir = join(store.projectDir, 'operations', randomUUID());
    await mkdir(opDir, { recursive: true, mode: 0o700 });
    try {
      const bundle = join(opDir, 'history.bundle');
      await store.git.run(['bundle', 'create', '--quiet', bundle, 'refs/heads/main']);
      await store.git.run(['bundle', 'verify', '--quiet', bundle]);
      const scopeJson = Buffer.from(
        canonicalJson({ schemaVersion: 1, entryFiles: store.cfg.entryFiles, scopeHash: store.scopeHash, policy: store.cfg.policy }) + '\n',
      );
      const bundleRef = await sha256File(bundle);
      const history = await store.history();
      const manifest: BackupManifest = {
        format: 'draft-tide-backup',
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        generator: { name: 'draft-tide-m0-spike', version: '0.0.0' },
        project: { sourceProjectId: store.cfg.projectId, displayName },
        refs: { 'refs/heads/main': head },
        snapshots: history.map((s) => ({ snapshotId: s.meta.snapshotId, commit: s.commit, kind: s.meta.kind })),
        files: {
          'history.bundle': bundleRef,
          'scope-policy.json': { sha256: createHash('sha256').update(scopeJson).digest('hex'), size: scopeJson.length },
        },
      };
      const zip = new yazl.ZipFile();
      zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), 'manifest.json');
      zip.addBuffer(scopeJson, 'scope-policy.json');
      zip.addReadStream(createReadStream(bundle), 'history.bundle', { compress: false, size: bundleRef.size });
      zip.end();
      // Write aside, then publish with link(): never clobbers an existing file.
      const partial = `${outFile}.partial-${randomUUID()}`;
      await pipeline(zip.outputStream, createWriteStream(partial, { flags: 'wx', flush: true }));
      try {
        await link(partial, outFile);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new DtError('PATH_OUTSIDE_ROOT', 'backup destination already exists; choose a new file name');
        throw e;
      } finally {
        await unlink(partial);
      }
      return { file: outFile, bytes: (await stat(outFile)).size, bundleBytes: bundleRef.size, manifest };
    } finally {
      await rm(opDir, { recursive: true, force: true });
    }
  });
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((res, rej) =>
    yauzl.open(file, { lazyEntries: true, autoClose: true, strictFileNames: true, validateEntrySizes: true }, (err, zf) => (err || !zf ? rej(err) : res(zf))),
  );
}

async function extractAllowlisted(file: string, stagingDir: string): Promise<Map<string, string>> {
  const zf = await openZip(file).catch((e: unknown) => {
    throw new DtError('BACKUP_INVALID', `backup container is damaged: ${(e as Error).message}`);
  });
  const out = new Map<string, string>();
  const free = await statfs(stagingDir);
  const freeBytes = free.bavail * free.bsize;
  await new Promise<void>((resolve, reject) => {
    const fail = (e: unknown) => {
      zf.close();
      reject(e);
    };
    zf.on('error', fail);
    zf.on('end', () => resolve());
    zf.on('entry', (entry: yauzl.Entry) => {
      const name = entry.fileName;
      if (!ALLOWED_ENTRIES.has(name)) return fail(new DtError('BACKUP_INVALID', 'backup contains an unexpected entry', { entry: name.slice(0, 200) }));
      if (out.has(name)) return fail(new DtError('BACKUP_INVALID', 'backup contains a duplicate entry', { entry: name }));
      const isJson = name.endsWith('.json');
      if (isJson && entry.uncompressedSize > JSON_ENTRY_BUDGET) return fail(new DtError('RESOURCE_BUDGET_EXCEEDED', 'backup metadata is too large', { budget: 'import-metadata' }));
      if (isJson && entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > MAX_JSON_RATIO) return fail(new DtError('RESOURCE_BUDGET_EXCEEDED', 'backup metadata compression ratio is suspicious', { budget: 'import-expansion' }));
      if (entry.uncompressedSize > freeBytes) return fail(new DtError('INSUFFICIENT_DISK_SPACE', 'not enough space to import this backup', { requiredBytes: entry.uncompressedSize, availableBytes: freeBytes, volume: 'history' }, true));
      zf.openReadStream(entry, (err, rs) => {
        if (err || !rs) return fail(err);
        const dst = join(stagingDir, name);
        let n = 0;
        const counter = new Transform({
          transform(c: Buffer, _e, cb) {
            n += c.length;
            if (n > entry.uncompressedSize) cb(new DtError('BACKUP_INVALID', 'entry larger than declared'));
            else cb(null, c);
          },
        });
        pipeline(rs, counter, createWriteStream(dst, { flags: 'wx', mode: 0o600 }))
          .then(() => {
            out.set(name, dst);
            zf.readEntry();
          })
          .catch(fail);
      });
    });
    zf.readEntry();
  }).catch((e: unknown) => {
    if (e instanceof DtError) throw e;
    throw new DtError('BACKUP_INVALID', `backup container is damaged: ${(e as Error).message}`);
  });
  for (const n of ALLOWED_ENTRIES) if (!out.has(n)) throw new DtError('BACKUP_INVALID', `backup is missing ${n}`);
  return out;
}

export interface ImportResult {
  store: ProjectStore;
  manifest: BackupManifest;
  materializedFiles: number;
}

// Import into a NEW empty destination and a NEW isolated history only.
export async function importBackup(file: string, dataDir: string, rt: GitRuntime, destination: string): Promise<ImportResult> {
  try {
    if ((await readdir(destination)).length) throw new DtError('UNTRACKED_FILES', 'import destination must be an empty folder');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const staging = join(dataDir, 'import-staging', randomUUID());
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    const entries = await extractAllowlisted(file, staging);
    const manifestPath = entries.get('manifest.json') as string;
    const parsed = BackupManifestSchema.safeParse(JSON.parse(await readFile(manifestPath, 'utf8')));
    if (!parsed.success) throw new DtError('BACKUP_INVALID', 'backup manifest is not supported', { issues: parsed.error.issues.slice(0, 5).map((i) => i.message) });
    const manifest = parsed.data;
    for (const name of ['history.bundle', 'scope-policy.json'] as const) {
      const got = await sha256File(entries.get(name) as string);
      if (got.sha256 !== manifest.files[name].sha256 || got.size !== manifest.files[name].size) {
        throw new DtError('BACKUP_INVALID', `${name} does not match the manifest`, { entry: name });
      }
    }
    const scopeParsed = ScopeFileSchema.safeParse(JSON.parse(await readFile(entries.get('scope-policy.json') as string, 'utf8')));
    if (!scopeParsed.success) throw new DtError('BACKUP_INVALID', 'scope policy is not supported');
    const scope = scopeParsed.data;

    const store = await ProjectStore.create(dataDir, rt, { root: destination, entryFiles: scope.entryFiles, policy: scope.policy as ScopePolicy });
    if (store.scopeHash !== scope.scopeHash) throw new DtError('BACKUP_INVALID', 'scope hash mismatch');
    const bundle = entries.get('history.bundle') as string;
    await store.git.run(['bundle', 'verify', '--quiet', bundle]);
    const heads = (await store.git.run(['bundle', 'list-heads', bundle])).stdout.trim().split('\n');
    if (heads.length !== 1 || heads[0] !== `${manifest.refs['refs/heads/main']} refs/heads/main`) {
      throw new DtError('BACKUP_INVALID', 'bundle refs do not match the manifest');
    }
    await store.git.run(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--end-of-options', bundle, 'refs/heads/main:refs/heads/main']);
    await store.fsck();
    const history = await store.history();
    const byCommit = new Map(history.map((s) => [s.commit, s.meta.snapshotId]));
    for (const s of manifest.snapshots) {
      if (byCommit.get(s.commit) !== s.snapshotId) throw new DtError('BACKUP_INVALID', 'snapshot identities do not match the manifest', { snapshotId: s.snapshotId });
    }
    const materializedFiles = await store.materialize(manifest.refs['refs/heads/main'], destination);
    return { store, manifest, materializedFiles };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
