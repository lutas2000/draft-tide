import { createHash, randomUUID } from 'node:crypto';
import { PROJECT_CONFIG_FILE, serializeProjectConfig, type ProjectConfig } from '@draft-tide/contracts';
import type {
  CaptureOptions,
  FileIdentity,
  GitRepo,
  IndexEntry,
  PathAttributes,
  RepoProbe,
  StagingArea,
  Workspace,
} from '../src/index.ts';

// An in-memory design folder with its Git index and object store. Real Git
// and filesystem runs are in the companion's integration tests; here the
// capture loop's decisions are checked deterministically.

export const oidOf = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

export interface FakeFile {
  bytes: Buffer;
  exec: boolean;
  ino: bigint;
  mtime: bigint;
}

export const NO_ATTRS: PathAttributes = {
  filter: 'unspecified',
  text: 'unspecified',
  eol: 'unspecified',
  ident: 'unspecified',
  workingTreeEncoding: 'unspecified',
};

export class World {
  files = new Map<string, FakeFile>();
  index = new Map<string, IndexEntry>();
  blobs = new Set<string>();
  attrs = new Map<string, Partial<PathAttributes>>();
  ignored = new Set<string>();
  symlinks = new Set<string>();
  dataFree = 10 * 1024 ** 3;
  projectFree = 10 * 1024 ** 3;
  sameVolume = false;
  probe: RepoProbe = {
    hasRepo: true,
    headRef: 'refs/heads/main',
    branch: 'main',
    tip: null,
    trustExecutableBit: true,
    blockers: [],
    warnings: [],
  };
  // Called after a file is hashed or staged; tests make "writers" here.
  onRead: (path: string, pass: 'hash' | 'stage') => void = () => undefined;
  staged = new Map<string, Buffer>();
  calls = { prepare: [] as number[], discard: [] as number[], stage: 0 };
  #ino = 1n;
  #clock = 1n;
  config: ProjectConfig = {
    schemaVersion: 1,
    projectId: randomUUID() as ProjectConfig['projectId'],
    name: 'Fixture',
    entryFiles: ['index.html'],
    excludeDirNames: [],
    excludeFilePatterns: [],
  };

  constructor() {
    this.write(PROJECT_CONFIG_FILE, serializeProjectConfig(this.config));
  }

  write(path: string, content: string | Buffer, exec = false): void {
    const prev = this.files.get(path);
    this.files.set(path, {
      bytes: Buffer.from(content),
      exec,
      ino: prev?.ino ?? this.#ino++,
      mtime: this.#clock++,
    });
  }

  // Commit the current content of these paths into the index and store.
  track(...paths: string[]): void {
    for (const p of paths) {
      const f = this.files.get(p);
      if (!f) throw new Error(`no ${p}`);
      const oid = oidOf(f.bytes);
      this.blobs.add(oid);
      this.index.set(p, { path: p, mode: f.exec ? '100755' : '100644', oid, stage: 0, flag: null });
    }
  }

  identity(f: FakeFile): FileIdentity {
    return { dev: 1n, ino: f.ino, size: BigInt(f.bytes.length), mtimeNs: f.mtime, ctimeNs: f.mtime };
  }

  repo(): GitRepo {
    return {
      root: '/fake',
      probe: () => Promise.resolve(this.probe),
      listIndex: () => Promise.resolve({ entries: [...this.index.values()], nonUtf8: [] }),
      listUntracked: (rules) => {
        const files = [...this.files.keys()].filter(
          (p) =>
            !this.index.has(p) &&
            !this.ignored.has(p) &&
            !rules.filePatterns.includes(p.split('/').at(-1) as string) &&
            !p.split('/').some((seg) => rules.dirNames.includes(seg)),
        );
        return Promise.resolve({ files: [...files, ...this.symlinks], nestedRepos: [], nonUtf8: [] });
      },
      listExcluded: () => Promise.resolve({ entries: [], nonUtf8: [] }),
      checkAttributes: (paths) =>
        Promise.resolve(new Map(paths.map((p) => [p, { ...NO_ATTRS, ...this.attrs.get(p) }]))),
      existingBlobs: (oids) => Promise.resolve(new Set(oids.filter((o) => this.blobs.has(o)))),
    };
  }

  workspace(): Workspace {
    const digest = (path: string, expected: FileIdentity) => {
      const f = this.files.get(path);
      if (!f || f.ino !== expected.ino) return { changed: true as const };
      return {
        changed: false as const,
        digest: { oid: oidOf(f.bytes), size: f.bytes.length, executable: f.exec, hasCR: f.bytes.includes(13) },
      };
    };
    return {
      root: '/fake',
      readProjectConfig: () => {
        const f = this.files.get(PROJECT_CONFIG_FILE);
        if (!f) return Promise.resolve(null);
        return Promise.resolve({ config: JSON.parse(f.bytes.toString('utf8')) as ProjectConfig, oid: oidOf(f.bytes) });
      },
      inspect: (paths) =>
        Promise.resolve(
          paths.map((p) => {
            if (this.symlinks.has(p)) return { kind: 'unsupported' as const, reason: 'symlink' as const };
            const f = this.files.get(p);
            if (!f) return { kind: 'missing' as const };
            return { kind: 'file' as const, size: f.bytes.length, executable: f.exec, identity: this.identity(f) };
          }),
        ),
      hash: (path, expected) => {
        const r = digest(path, expected);
        this.onRead(path, 'hash');
        return Promise.resolve(r);
      },
      stage: (path, expected, dest) => {
        this.calls.stage++;
        const r = digest(path, expected);
        const f = this.files.get(path);
        if (!r.changed && f) this.staged.set(dest, f.bytes);
        this.onRead(path, 'stage');
        return Promise.resolve(r);
      },
      projectSpace: () =>
        Promise.resolve({ volume: this.sameVolume ? 'v' : 'project', availableBytes: this.projectFree }),
    };
  }

  staging(): StagingArea {
    return {
      dir: '/staging',
      prepareAttempt: (n) => {
        this.calls.prepare.push(n);
        return Promise.resolve();
      },
      pathFor: (n, oid) => `/staging/attempt-${n}/${oid}`,
      discardAttempt: (n) => {
        this.calls.discard.push(n);
        for (const k of [...this.staged.keys()]) if (k.startsWith(`/staging/attempt-${n}/`)) this.staged.delete(k);
        return Promise.resolve();
      },
      space: () => Promise.resolve({ volume: this.sameVolume ? 'v' : 'data', availableBytes: this.dataFree }),
      remove: () => Promise.resolve(),
    };
  }

  options(extra: Partial<CaptureOptions> = {}): CaptureOptions {
    return {
      repo: this.repo(),
      workspace: this.workspace(),
      staging: this.staging(),
      probe: this.probe,
      retryDelayMs: () => 0,
      ...extra,
    };
  }
}
