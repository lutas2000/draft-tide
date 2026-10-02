// The PNGs of cached previews: <data>/projects/<project-id>/cache/previews/
// <key>.full.png and <key>.thumb.png. A rebuildable cache (TECH_STACK §6.1):
// never inside the design folder or its repo. Files are written to a
// temporary name and renamed, so a reader sees a whole PNG or none.
import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DtError, ProjectId, type PreviewImageKind } from '@draft-tide/contracts';
import type { PreviewImageStore } from '@draft-tide/core';

const KEY = /^[0-9a-f]{64}$/;
const FILE = /^([0-9a-f]{64})\.(full|thumb)\.png$/;

export function createPreviewImageStore(dataDir: string): PreviewImageStore {
  const projectsDir = join(dataDir, 'projects');
  const dirOf = (projectId: string) => {
    if (!ProjectId.safeParse(projectId).success) throw new DtError('INTERNAL_ERROR', 'invalid project id');
    return join(projectsDir, projectId, 'cache', 'previews');
  };
  const fileOf = (projectId: string, key: string, image: PreviewImageKind) => {
    if (!KEY.test(key)) throw new DtError('INTERNAL_ERROR', 'invalid preview key');
    return join(dirOf(projectId), `${key}.${image === 'full' ? 'full' : 'thumb'}.png`);
  };

  return {
    async write(projectId, key, image, png) {
      const file = fileOf(projectId, key, image);
      await mkdir(dirOf(projectId), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, png, { mode: 0o600, flag: 'wx' });
        await rename(tmp, file);
      } catch (e) {
        await rm(tmp, { force: true });
        throw new DtError('STORAGE_IO_FAILED', `could not keep the preview: ${(e as Error).message}`, {
          reason: 'preview-cache',
        });
      }
    },
    async read(projectId, key, image, offset, length) {
      let handle;
      try {
        handle = await open(fileOf(projectId, key, image), 'r');
      } catch {
        return null;
      }
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
      } finally {
        await handle.close();
      }
    },
    async has(projectId, key) {
      try {
        const [a, b] = await Promise.all([
          stat(fileOf(projectId, key, 'full')),
          stat(fileOf(projectId, key, 'thumbnail')),
        ]);
        return a.isFile() && b.isFile();
      } catch {
        return false;
      }
    },
    async remove(projectId, key) {
      await rm(fileOf(projectId, key, 'full'), { force: true });
      await rm(fileOf(projectId, key, 'thumbnail'), { force: true });
    },
    async removeAllExcept(keep) {
      let projects: string[];
      try {
        projects = await readdir(projectsDir);
      } catch {
        return;
      }
      for (const projectId of projects) {
        if (!ProjectId.safeParse(projectId).success) continue;
        const dir = dirOf(projectId);
        let names: string[];
        try {
          names = await readdir(dir);
        } catch {
          continue;
        }
        for (const name of names) {
          const m = FILE.exec(name);
          if (m && keep.has(`${projectId}/${m[1] ?? ''}`)) continue;
          // Only what this store writes: its PNGs and their temporary files.
          if (m || /^[0-9a-f]{64}\.(full|thumb)\.png\.[0-9a-f-]{36}\.tmp$/.test(name)) {
            await rm(join(dir, name), { force: true });
          }
        }
      }
    },
  };
}
