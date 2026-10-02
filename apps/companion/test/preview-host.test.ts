// The Engine's preview supervisor against a scripted Preview Host
// (fake-preview-host.ts, the same pipe protocol without Electron): it starts
// the host with a from-scratch environment, serves it only what the file
// source answers, and turns every misbehaviour into PREVIEW_FAILED with the
// host stopped. The real Electron host runs in the desktop E2E.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DtError, PREVIEW_HOST_ENV, ProjectId, previewRendererId, type PreviewHostLaunch } from '@draft-tide/contracts';
import type { PreviewFileSource, RenderJob, ServedFile } from '@draft-tide/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createPreviewSupervisor, previewHostLaunch, type PreviewSupervisor } from '../src/engine/preview-host.ts';
import { COMPANION } from './helpers.ts';

const FAKE_HOST = join(COMPANION, 'test', 'fake-preview-host.ts');
const RENDERER = previewRendererId('1.0.0', '2.0.0');

function launch(mode = 'render', electron = '1.0.0'): PreviewHostLaunch {
  return {
    command: process.execPath,
    args: [FAKE_HOST, `--mode=${mode}`, `--electron=${electron}`],
    renderer: RENDERER,
  };
}

const supervisors: PreviewSupervisor[] = [];
function supervisor(l: PreviewHostLaunch | null = launch()): PreviewSupervisor {
  const s = createPreviewSupervisor({ launch: l, timezone: 'Asia/Taipei', log: () => undefined });
  supervisors.push(s);
  return s;
}
afterEach(() => {
  for (const s of supervisors.splice(0)) s.stop();
});

function job(projectId = ProjectId.parse(randomUUID()), timeoutMs = 5_000): RenderJob {
  return {
    jobId: randomUUID(),
    projectId,
    subject: { kind: 'page', path: 'index.html' },
    settings: {
      viewport: { width: 1280, height: 800, scale: 1 },
      thumbnail: { width: 400, height: 250 },
      locale: 'en-US',
      timezone: 'Asia/Taipei',
      scripts: true,
      wait: 'w',
      animations: 'a',
    },
    output: { width: 1280, height: 800 },
    thumbnail: { width: 400, height: 250 },
    timeoutMs,
  };
}

// Serves an entry page and records every path the host asked for.
function source(html: string, files: Record<string, string> = {}): PreviewFileSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    read(path): Promise<ServedFile> {
      asked.push(path);
      if (path === '/index.html') {
        return Promise.resolve({ status: 'ok', contentType: 'text/html', bytes: new TextEncoder().encode(html) });
      }
      const f = files[path.slice(1)];
      return Promise.resolve(
        f === undefined
          ? { status: 'missing' }
          : { status: 'ok', contentType: 'text/css', bytes: new TextEncoder().encode(f) },
      );
    },
  };
}

async function failure(p: Promise<unknown>): Promise<DtError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DtError) return e;
    throw e;
  }
  throw new Error('expected a DtError');
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const pidOf = (asked: string[]) => Number(asked.find((p) => p.startsWith('/__pid__/'))?.slice(9));

describe('the preview supervisor', () => {
  it('renders through the host, which only sees what the file source serves', async () => {
    const s = supervisor();
    expect(s.rendererId).toBe(RENDERER);
    const files = source('<link href="a.css"><img src="https://cdn.example/x.png"><!-- env --><!-- scratch -->', {
      'a.css': 'b{}',
    });
    const out = await s.render(job(), files, new AbortController().signal);
    expect(out.full).toMatchObject({ width: 1280, height: 800 });
    expect(out.thumbnail).toMatchObject({ width: 400, height: 250 });
    expect(out.blocked).toEqual({ count: 1, entries: [{ kind: 'network', target: 'https://cdn.example/x.png' }] });
    expect(out.environment).toMatchObject({ renderer: RENDERER, electron: '1.0.0', chromium: '2.0.0' });
    expect(files.asked.slice(0, 2)).toEqual(['/index.html', '/a.css']);
    // Built from scratch: no data directory, Git, tokens or anything else
    // of the Engine's. The OS adds its own: macOS __CF_USER_TEXT_ENCODING
    // to every process, and on Windows libuv copies the variables a Windows
    // process needs from the parent when they are missing.
    const env = decodeURIComponent(files.asked.find((p) => p.startsWith('/__env__/'))?.slice(9) ?? '')
      .split(',')
      .filter((k) => !k.startsWith('__CF_'));
    if (process.platform === 'win32') {
      const ours = ['APPDATA', 'DT_PREVIEW_SCRATCH', 'LOCALAPPDATA', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE'];
      const libuv = [
        'HOMEDRIVE',
        'HOMEPATH',
        'LOGONSERVER',
        'PATH',
        'SYSTEMDRIVE',
        'SYSTEMROOT',
        'TEMP',
        'USERDOMAIN',
        'USERNAME',
        'USERPROFILE',
        'WINDIR',
      ];
      expect(env).toEqual(expect.arrayContaining(ours));
      expect(env.filter((k) => !ours.includes(k) && !libuv.includes(k.toUpperCase()))).toEqual([]);
    } else {
      expect(env).toEqual(['DT_PREVIEW_SCRATCH', 'HOME', 'LANG', 'PATH', 'TMPDIR', 'TZ']);
    }
    const scratch = decodeURIComponent(files.asked.find((p) => p.startsWith('/__scratch__/'))?.slice(13) ?? '');
    expect(existsSync(scratch)).toBe(true);
    s.stop();
    await expect.poll(() => existsSync(scratch), { timeout: 5_000 }).toBe(false);
  });

  it('keeps one host per project, and starts another for another project', async () => {
    const s = supervisor();
    const project = ProjectId.parse(randomUUID());
    const a = source('<!-- pid -->');
    const b = source('<!-- pid -->');
    const c = source('<!-- pid -->');
    await s.render(job(project), a, new AbortController().signal);
    await s.render(job(project), b, new AbortController().signal);
    expect(pidOf(a.asked)).toBe(pidOf(b.asked));
    await s.render(job(), c, new AbortController().signal);
    expect(pidOf(c.asked)).not.toBe(pidOf(a.asked));
    await expect.poll(() => alive(pidOf(a.asked)), { timeout: 5_000 }).toBe(false);
  });

  it('turns every misbehaviour into PREVIEW_FAILED and stops the host', async () => {
    const cases: [string, string][] = [
      ['crash', 'crashed'],
      ['timeout', 'timeout'],
      ['garbage', 'crashed'],
      ['protocol', 'renderer-mismatch'],
    ];
    for (const [mode, reason] of cases) {
      const s = supervisor(launch(mode));
      expect(await failure(s.render(job(), source('x'), new AbortController().signal)), mode).toMatchObject({
        code: 'PREVIEW_FAILED',
        details: { reason },
      });
    }
    const other = supervisor(launch('render', '9.9.9'));
    expect(await failure(other.render(job(), source('x'), new AbortController().signal))).toMatchObject({
      details: { reason: 'renderer-mismatch' },
    });
    // Images of the wrong size reach core, which refuses them (core's tests).
    const wrong = await supervisor(launch('wrong-size')).render(job(), source('x'), new AbortController().signal);
    expect(wrong.full).toMatchObject({ width: 10, height: 10 });
  });

  it('kills a host that never answers, once the job and its grace are over', async () => {
    const s = supervisor(launch('hang'));
    const started = Date.now();
    const files = source('<!-- pid -->');
    expect(await failure(s.render(job(undefined, 200), files, new AbortController().signal))).toMatchObject({
      code: 'PREVIEW_FAILED',
      details: { reason: 'timeout' },
      retryable: true,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('stops at once when the render is cancelled', async () => {
    const s = supervisor(launch('hang'));
    const controller = new AbortController();
    const pending = s.render(job(), source('x'), controller.signal);
    setTimeout(() => controller.abort(new DtError('PREVIEW_FAILED', 'stop', { reason: 'timeout' })), 300);
    const started = Date.now();
    expect(await failure(pending)).toMatchObject({ details: { reason: 'timeout' } });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('has no renderer without a launch, and none in a release build', async () => {
    const s = supervisor(null);
    expect(s.rendererId).toBeNull();
    expect(await failure(s.render(job(), source('x'), new AbortController().signal))).toMatchObject({
      details: { reason: 'no-renderer' },
    });
    const env = { [PREVIEW_HOST_ENV]: JSON.stringify(launch()) };
    expect(previewHostLaunch({ mode: 'development', appVersion: '0', desktopRequirement: null }, env)).toEqual(
      launch(),
    );
    expect(previewHostLaunch({ mode: 'release', appVersion: '1', desktopRequirement: 'x' }, env)).toBeNull();
    for (const bad of [
      '{',
      '{"command":"node","args":[],"renderer":"r"}',
      '{"command":"/n","args":[],"renderer":"r","x":1}',
    ]) {
      expect(
        previewHostLaunch(
          { mode: 'development', appVersion: '0', desktopRequirement: null },
          { [PREVIEW_HOST_ENV]: bad },
        ),
        bad,
      ).toBeNull();
    }
  });
});
