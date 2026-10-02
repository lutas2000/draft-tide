// A scripted Preview Host for the Engine's tests. It speaks the pipe protocol
// on fd 3 exactly as the real one (apps/desktop/src/preview-host/host.ts)
// does, without Electron, so the Engine's side runs on every CI platform.
// It "renders" a page by fetching what the entry references (src="…" and
// href="…"), answering with generated PNGs. Markers in the page make it
// report what it can see:
//   <!-- env -->       fetches /__env__/<its environment's variable names>
//   <!-- scratch -->   fetches /__scratch__/<its scratch directory>
//   <!-- pid -->       fetches /__pid__/<its process id>
// --mode=<m> picks a misbehaviour: crash, timeout, hang, wrong-size, garbage,
// protocol.
import { Socket } from 'node:net';
import { EngineToHost, PREVIEW_HOST_PROTOCOL, type HostJob, type HostToEngine } from '@draft-tide/contracts';
import { HostFrameDecoder, encodeHostFrame } from '@draft-tide/engine-client';
import { makePng } from './png.ts';

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const mode = arg('mode', 'render');

const pipe = new Socket({ fd: 3, readable: true, writable: true });
const send = (m: HostToEngine, body?: Uint8Array) => pipe.write(encodeHostFrame(m, body));
pipe.on('close', () => process.exit(0));
pipe.on('error', () => process.exit(0));

let nextRequest = 0;
const waiting = new Map<number, (r: { status: string; body: Buffer }) => void>();
function fetchPath(jobId: string, path: string): Promise<{ status: string; body: Buffer }> {
  const requestId = nextRequest++;
  return new Promise((resolve) => {
    waiting.set(requestId, resolve);
    send({ type: 'fetch', jobId, requestId, path });
  });
}

async function run(job: HostJob): Promise<void> {
  if (mode === 'crash') process.exit(1);
  if (mode === 'hang') return;
  if (mode === 'garbage') {
    pipe.write(Buffer.from('this is not a frame at all, not even close'));
    return;
  }
  const blocked: { kind: 'network'; target: string }[] = [];
  const entry = await fetchPath(job.jobId, `/${job.subject.path.split('/').map(encodeURIComponent).join('/')}`);
  if (job.subject.kind === 'page' && entry.status === 'ok') {
    const html = entry.body.toString('utf8');
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const ref = m[1] ?? '';
      if (/^https?:/.test(ref)) blocked.push({ kind: 'network', target: ref });
      else await fetchPath(job.jobId, ref.startsWith('/') ? ref : `/${ref}`);
    }
    if (html.includes('<!-- env -->')) {
      await fetchPath(job.jobId, `/__env__/${encodeURIComponent(Object.keys(process.env).sort().join(','))}`);
    }
    if (html.includes('<!-- scratch -->')) {
      await fetchPath(job.jobId, `/__scratch__/${encodeURIComponent(process.env['DT_PREVIEW_SCRATCH'] ?? '')}`);
    }
    if (html.includes('<!-- pid -->')) await fetchPath(job.jobId, `/__pid__/${process.pid}`);
  }
  if (mode === 'timeout') {
    send({ type: 'done', jobId: job.jobId, outcome: 'timeout', blocked: { count: 0, entries: [] } });
    return;
  }
  const size = mode === 'wrong-size' ? { width: 10, height: 10 } : job.output;
  send({ type: 'image', jobId: job.jobId, image: 'full', ...size }, makePng(size.width, size.height));
  send(
    { type: 'image', jobId: job.jobId, image: 'thumbnail', ...job.thumbnail },
    makePng(job.thumbnail.width, job.thumbnail.height, 120),
  );
  send({ type: 'done', jobId: job.jobId, outcome: 'captured', blocked: { count: blocked.length, entries: blocked } });
}

const decoder = new HostFrameDecoder();
pipe.on('data', (c: Buffer) => {
  for (const { header, body } of decoder.push(c)) {
    const msg = EngineToHost.parse(header);
    if (msg.type === 'exit') process.exit(0);
    if (msg.type === 'job') void run(msg);
    else {
      const w = waiting.get(msg.requestId);
      waiting.delete(msg.requestId);
      w?.({ status: msg.status, body });
    }
  }
});

send({
  type: 'ready',
  protocol: mode === 'protocol' ? PREVIEW_HOST_PROTOCOL + 1 : PREVIEW_HOST_PROTOCOL,
  electron: arg('electron', '1.0.0'),
  chromium: '2.0.0',
  platform: process.platform,
  osRelease: 'test',
});
