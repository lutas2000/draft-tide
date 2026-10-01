import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DtError,
  MAX_PROJECT_CONFIG_BYTES,
  PROJECT_CONFIG_FILE,
  parseProjectConfig,
  projectConfigError,
} from '@draft-tide/contracts';
import type { GitOid, ProjectConfigRead } from '@draft-tide/core';
import { gitBlobOid } from './digest.ts';
import { ioError, isGone } from './io.ts';

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

// `.drafttide.json` is untrusted input (M1 plan §5.2). The parser in
// contracts checks the content; this checks the file: a regular file, not a
// symlink, at most 64 KiB, read without following links and without reading
// past the limit.
export async function readProjectConfigFile(root: string): Promise<ProjectConfigRead | null> {
  const abs = join(root, PROJECT_CONFIG_FILE);
  let st;
  try {
    st = await lstat(abs, { bigint: true });
  } catch (e) {
    if (isGone(e)) return null;
    throw ioError(e, 'reading the project settings');
  }
  if (!st.isFile()) throw projectConfigError('not-regular-file', 'must be a regular file, not a link or folder');
  if (st.size > BigInt(MAX_PROJECT_CONFIG_BYTES)) throw projectConfigError('too-large', 'the file is too large');

  const buf = Buffer.alloc(MAX_PROJECT_CONFIG_BYTES + 1);
  let length = 0;
  try {
    const fh = await open(abs, constants.O_RDONLY | O_NOFOLLOW);
    try {
      const now = await fh.stat({ bigint: true });
      if (!now.isFile() || now.ino !== st.ino || now.dev !== st.dev) {
        throw projectConfigError('not-regular-file', 'the file was replaced while it was read');
      }
      for (;;) {
        const { bytesRead } = await fh.read(buf, length, buf.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
        if (length > MAX_PROJECT_CONFIG_BYTES) throw projectConfigError('too-large', 'the file is too large');
      }
    } finally {
      await fh.close();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ELOOP') {
      throw projectConfigError('not-regular-file', 'must be a regular file, not a link or folder');
    }
    throw ioError(e, 'reading the project settings');
  }
  const bytes = buf.subarray(0, length);
  return { config: parseProjectConfig(bytes), oid: gitBlobOid(bytes) };
}

// The blob id of the file's bytes now, or null when there is none. A file that
// is not a regular file, or is larger than any valid settings file, matches no
// reviewed state: it reads as OTHER, which is never a blob id.
const OTHER = 'not-a-settings-file';

async function currentConfigOid(abs: string): Promise<string | null> {
  let fh;
  try {
    fh = await open(abs, constants.O_RDONLY | O_NOFOLLOW);
  } catch (e) {
    if (isGone(e)) return null;
    if ((e as NodeJS.ErrnoException).code === 'ELOOP') return OTHER;
    throw ioError(e, 'reading the project settings');
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > MAX_PROJECT_CONFIG_BYTES) return OTHER;
    const buf = Buffer.alloc(MAX_PROJECT_CONFIG_BYTES + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, length, buf.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > MAX_PROJECT_CONFIG_BYTES) return OTHER;
    }
    return gitBlobOid(buf.subarray(0, length));
  } finally {
    await fh.close();
  }
}

// Replaces `.drafttide.json` atomically (a temporary file beside it, then a
// rename) and only if it still holds the reviewed bytes (expected: their blob
// id, or null for no file). Anything else is SCOPE_CHANGED with nothing
// written. Node has no openat, so a swap between the check and the rename
// can't be excluded; the rename replaces a link itself, never its target.
export async function writeProjectConfigFile(root: string, bytes: Uint8Array, expected: GitOid | null): Promise<void> {
  const abs = join(root, PROJECT_CONFIG_FILE);
  const current = await currentConfigOid(abs);
  if (current !== expected) {
    throw new DtError(
      'SCOPE_CHANGED',
      `${PROJECT_CONFIG_FILE} changed since the folder was reviewed; review it again`,
      {
        reason: 'config-changed',
      },
    );
  }
  // Matches the default exclude `.*.dt-tmp-*`, so a leftover is never saved.
  const tmp = join(root, `${PROJECT_CONFIG_FILE}.dt-tmp-${randomUUID()}`);
  let mode = 0o644;
  if (current !== null) mode = (await lstat(abs)).mode & 0o777;
  try {
    const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
    try {
      await fh.writeFile(bytes);
      // The Engine's umask is 077; the settings file is shared like any other.
      await fh.chmod(mode);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, abs);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw ioError(e, 'writing the project settings', { volume: 'project' });
  }
}
