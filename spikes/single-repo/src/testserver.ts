import { spawn, execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

// A stand-in for GitHub: smart-HTTP Git served by `git http-backend` behind
// Basic auth. Fixture for the suite only.
export interface RequestLog {
  method: string;
  path: string;
  authorized: boolean;
  headers: Record<string, string | string[] | undefined>;
}

export interface TestServer {
  url: string;
  requests: RequestLog[];
  close(): Promise<void>;
}

const SYSTEM_GIT = '/usr/bin/git';

export function startGitServer(opts: { projectRoot: string; username: string; token: string }): Promise<TestServer> {
  const execPath = execFileSync(SYSTEM_GIT, ['--exec-path'], { encoding: 'utf8' }).trim();
  const backend = join(execPath, 'git-http-backend');
  const requests: RequestLog[] = [];
  const expected = `Basic ${Buffer.from(`${opts.username}:${opts.token}`).toString('base64')}`;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const authorized = req.headers['authorization'] === expected;
    requests.push({ method: req.method ?? '', path: url.pathname, authorized, headers: { ...req.headers } });
    if (!authorized) {
      req.resume();
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="draft-tide-test"' }).end();
      return;
    }
    const env: Record<string, string> = {
      PATH: '/usr/bin:/bin',
      GIT_PROJECT_ROOT: opts.projectRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      REQUEST_METHOD: req.method ?? 'GET',
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.replace(/^\?/, ''),
      REMOTE_USER: opts.username,
      REMOTE_ADDR: '127.0.0.1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    };
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v !== 'string') continue;
      const name = k.toUpperCase().replace(/-/g, '_');
      if (name === 'CONTENT_TYPE') env['CONTENT_TYPE'] = v;
      else if (name === 'CONTENT_LENGTH') env['CONTENT_LENGTH'] = v;
      else env[`HTTP_${name}`] = v;
    }
    const child = spawn(backend, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    req.pipe(child.stdin);
    child.stdin.on('error', () => undefined);
    let head = Buffer.alloc(0);
    let headDone = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (headDone) {
        res.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const sep = head.indexOf('\r\n\r\n');
      const sep2 = head.indexOf('\n\n');
      const at = sep >= 0 ? sep : sep2;
      if (at < 0) return;
      const len = sep >= 0 ? 4 : 2;
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.subarray(0, at).toString('latin1').split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === 'status') status = Number.parseInt(v, 10) || 200;
        else headers[k] = v;
      }
      res.writeHead(status, headers);
      headDone = true;
      const rest = head.subarray(at + len);
      if (rest.length) res.write(rest);
    });
    child.on('close', () => {
      if (!headDone) res.writeHead(500);
      res.end();
    });
  };

  return new Promise((resolvePromise) => {
    const server: Server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolvePromise({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
      });
    });
  });
}

// A listener that records every request: used to prove traffic did NOT go
// there. With `challenge` it asks for Basic credentials like a real server, so
// a client that was redirected here would hand over its token.
export function startCanary(opts: { challenge?: boolean } = {}): Promise<{ url: string; hits: string[]; creds: string[]; close(): Promise<void> }> {
  const hits: string[] = [];
  const creds: string[] = [];
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const auth = req.headers['authorization'];
      hits.push(`${req.method} ${req.url}${auth ? ' (with credentials)' : ''}`);
      if (typeof auth === 'string' && auth.startsWith('Basic ')) creds.push(Buffer.from(auth.slice(6), 'base64').toString('utf8'));
      req.resume();
      if (opts.challenge && !auth) res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="canary"' }).end();
      else res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolvePromise({ url: `http://127.0.0.1:${port}`, hits, creds, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) });
    });
  });
}
