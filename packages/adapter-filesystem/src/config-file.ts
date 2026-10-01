import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MAX_PROJECT_CONFIG_BYTES,
  PROJECT_CONFIG_FILE,
  parseProjectConfig,
  projectConfigError,
} from '@draft-tide/contracts';
import type { ProjectConfigRead } from '@draft-tide/core';
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
