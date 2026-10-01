import { stat, statfs } from 'node:fs/promises';
import type { VolumeSpace } from '@draft-tide/core';
import { ioError } from './io.ts';

// Free space for the volume holding `path`, as an unprivileged user sees it.
export async function volumeSpace(path: string): Promise<VolumeSpace> {
  try {
    const [st, fs] = await Promise.all([stat(path, { bigint: true }), statfs(path, { bigint: true })]);
    return { volume: st.dev.toString(), availableBytes: Number(fs.bavail * fs.bsize) };
  } catch (e) {
    throw ioError(e, 'checking free disk space');
  }
}
