import { createHash, type Hash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, open, rm, type FileHandle } from 'node:fs/promises';
import { Transform, Writable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { DtError } from '@draft-tide/contracts';
import type { DigestResult, FileIdentity, GitOid } from '@draft-tide/core';
import { errnoOf, ioError, isDenied, isGone } from './io.ts';

const CHUNK = 1024 * 1024;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function blobHash(size: number | bigint): Hash {
  return createHash('sha1').update(`blob ${size}\0`);
}

// The id Git gives these bytes as a blob (SHA-1 repositories only).
export function gitBlobOid(bytes: Uint8Array): GitOid {
  return blobHash(bytes.byteLength).update(bytes).digest('hex');
}

class Digester extends Transform {
  readonly hash: Hash;
  bytes = 0;
  hasCR = false;

  constructor(size: bigint) {
    super();
    this.hash = blobHash(size);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    if (!this.hasCR && chunk.includes(13)) this.hasCR = true;
    done(null, chunk);
  }
}

const discard = () =>
  new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

// Streams one file through the blob hash, and into `dest` when given (a new,
// exclusive file that ends up read-only). The file must still be the one the
// scan saw (same device and inode), opened without following a symlink, and
// must not change while it is read; otherwise the result is `changed` and the
// capture retries. Opening and then checking the inode also means a parent
// swapped for a link after the scan can't make it read another file.
export async function digestFile(
  root: string,
  rel: string,
  expected: FileIdentity,
  dest: string | null,
  signal?: AbortSignal,
): Promise<DigestResult> {
  const abs = join(root, rel);
  let fh: FileHandle;
  try {
    fh = await open(abs, constants.O_RDONLY | O_NOFOLLOW);
  } catch (e) {
    const code = errnoOf(e);
    // Gone, now a symlink (ELOOP), or locked by another program (EBUSY).
    if (isGone(e) || code === 'ELOOP' || code === 'EBUSY') return { changed: true };
    if (isDenied(e)) throw unreadable(rel);
    throw ioError(e, 'reading a design file');
  }
  // Set once this call has created dest: only then is it ours to remove.
  let created = false;
  let out: FileHandle | null = null;
  try {
    const before = await fh.stat({ bigint: true });
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino) return { changed: true };
    if (dest !== null) {
      try {
        out = await open(dest, 'wx', 0o600);
      } catch (e) {
        throw ioError(e, 'staging a design file', { volume: 'app-data' });
      }
      created = true;
    }
    const digester = new Digester(before.size);
    const source = fh.createReadStream({ highWaterMark: CHUNK, autoClose: false, start: 0 });
    // The write stream closes `out` itself, on success and on failure.
    const sink = out ? out.createWriteStream() : discard();
    try {
      await pipeline(source, digester, sink, signal ? { signal } : {});
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      // EBUSY on Windows: another program holds the file.
      if (errnoOf(e) === 'EBUSY') return { changed: true };
      if (isDenied(e) && out === null) throw unreadable(rel);
      throw ioError(e, out === null ? 'reading a design file' : 'staging a design file', {
        volume: out === null ? 'project' : 'app-data',
      });
    }
    const after = await lstat(abs, { bigint: true }).catch(() => null);
    const now: FileIdentity | null = after && {
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeNs: after.mtimeNs,
      ctimeNs: after.ctimeNs,
    };
    const beforeId: FileIdentity = {
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
    };
    if (BigInt(digester.bytes) !== before.size || !now || !sameIdentity(beforeId, now)) return { changed: true };
    if (dest !== null) await chmod(dest, 0o400);
    created = false;
    return {
      changed: false,
      digest: {
        oid: digester.hash.digest('hex'),
        size: digester.bytes,
        executable: (before.mode & 0o100n) !== 0n,
        hasCR: digester.hasCR,
      },
    };
  } finally {
    await fh.close();
    // A staged copy that isn't a verified copy is removed at once.
    if (created && dest !== null) await rm(dest, { force: true, maxRetries: 3 });
  }
}

// Same shape as the scan's UNSUPPORTED_ENTRY.
function unreadable(rel: string): DtError {
  return new DtError('UNSUPPORTED_ENTRY', 'a file in the folder cannot be read', {
    count: 1,
    entries: [{ path: rel, kind: 'unreadable' }],
  });
}
