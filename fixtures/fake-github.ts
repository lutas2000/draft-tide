// A stand-in for GitHub on loopback, for tests and the desktop E2E (never
// shipped). It serves what Draft Tide uses of GitHub:
//
//   /login/device/code, /login/oauth/access_token   a GitHub App's device flow
//                                                   and token refresh (with
//                                                   rotation: every refresh
//                                                   voids the old tokens)
//   /api/user, /api/user/installations[/<id>/repositories], /api/repos/<o>/<n>
//   /git/<owner>/<name>.git/...                     smart-HTTP Git through
//                                                   `git http-backend`, Basic
//                                                   auth with x-access-token
//
// Point an Engine at it with DRAFT_TIDE_TEST_GITHUB=<env> (development
// builds only). Repositories are bare repos under rootDir; "installing" the
// app on one is a flag. Every request is logged, and every token issued is
// remembered, so tests can look for them where they must never be.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { delimiter, isAbsolute, join } from 'node:path';

export interface FakeUser {
  id: number;
  login: string;
  name: string | null;
}

export interface FakeRepo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  installed: boolean;
  defaultBranch: string;
  // The bare repository on disk.
  dir: string;
}

export interface LoggedRequest {
  method: string;
  path: string;
  // The token the request carried (Bearer or Basic password), if any.
  token: string | null;
}

export interface FakeGitHub {
  url: string;
  // JSON for DRAFT_TIDE_TEST_GITHUB.
  env: string;
  endpoints: { web: string; api: string; git: string };
  // The client IDs the device flow and refreshes were asked with.
  clientIds: Set<string>;
  user: FakeUser;
  requests: LoggedRequest[];
  // Every access and refresh token ever issued.
  tokens: string[];
  createRepo(
    owner: string,
    name: string,
    options?: { private?: boolean; installed?: boolean; defaultBranch?: string },
  ): FakeRepo;
  repo(owner: string, name: string): FakeRepo;
  setInstalled(owner: string, name: string, installed: boolean): void;
  // The device flow: the code is approved after this many polls (default 1),
  // or denied.
  login: { approveAfterPolls: number; deny: boolean; expired: boolean };
  // A valid access token without the device flow (tests of Git alone).
  issueAccessToken(): string;
  // Current access tokens stop working (as if they expired).
  expireAccessTokens(): void;
  // Every token stops working, refresh tokens included (revoked on GitHub).
  revokeAll(): void;
  // How long issued access tokens claim to last (seconds).
  accessTokenSeconds: number;
  // A pre-receive hook refuses pushes to this repo with GitHub's wording.
  rejectPushes(owner: string, name: string, kind: 'protected-branch' | 'large-file' | null): void;
  // The repo's branch as the server has it (null: none).
  branchTip(owner: string, name: string, branch: string): string | null;
  close(): Promise<void>;
}

function findGit(): string {
  const forced = process.env['DRAFT_TIDE_GIT'];
  if (forced && isAbsolute(forced)) return forced;
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    for (const name of process.platform === 'win32' ? ['git.exe'] : ['git']) {
      const p = join(dir, name);
      if (dir && existsSync(p)) return p;
    }
  }
  throw new Error('the fake GitHub needs git on PATH');
}

const PLAIN_ENV = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

function token(prefix: string): string {
  return `${prefix}_${randomBytes(27)
    .toString('base64url')
    .replace(/[^A-Za-z0-9]/g, 'x')
    .slice(0, 36)}`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startFakeGitHub(options: { rootDir: string; user?: FakeUser }): Promise<FakeGitHub> {
  const git = findGit();
  const execPath = execFileSync(git, ['--exec-path'], {
    encoding: 'utf8',
    env: { ...process.env, ...PLAIN_ENV },
  }).trim();
  const backend = join(execPath, process.platform === 'win32' ? 'git-http-backend.exe' : 'git-http-backend');
  const reposRoot = join(options.rootDir, 'repos');
  mkdirSync(reposRoot, { recursive: true });
  const clientIds = new Set<string>();
  const user: FakeUser = options.user ?? { id: 4242, login: 'designer', name: 'Dee Signer' };
  const requests: LoggedRequest[] = [];
  const tokens: string[] = [];
  const repos = new Map<string, FakeRepo>();
  let nextRepoId = 1000;
  // Valid tokens now.
  const access = new Set<string>();
  const refresh = new Set<string>();
  const devices = new Map<string, { polls: number }>();
  let base = '';

  const key = (owner: string, name: string) => `${owner.toLowerCase()}/${name.toLowerCase()}`;
  const repoJson = (r: FakeRepo) => ({
    id: r.id,
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner },
    private: r.private,
    visibility: r.private ? 'private' : 'public',
    default_branch: r.defaultBranch,
    html_url: `${base}/${r.owner}/${r.name}`,
    permissions: { admin: true, push: true, pull: true },
  });

  function issue(): Record<string, unknown> {
    const a = token('ghu');
    const r = token('ghr');
    access.add(a);
    refresh.add(r);
    tokens.push(a, r);
    return {
      access_token: a,
      expires_in: fake.accessTokenSeconds,
      refresh_token: r,
      refresh_token_expires_in: 15897600,
      token_type: 'bearer',
      scope: '',
    };
  }

  function bearer(req: IncomingMessage): string | null {
    const h = req.headers['authorization'];
    if (typeof h !== 'string') return null;
    if (h.startsWith('Bearer ')) return h.slice(7);
    if (h.startsWith('Basic ')) {
      const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
      return decoded.slice(decoded.indexOf(':') + 1);
    }
    return null;
  }

  async function oauth(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const form = new URLSearchParams(await readBody(req));
    const id = form.get('client_id') ?? '';
    if (id === '' || form.has('client_secret')) return json(res, 200, { error: 'incorrect_client_credentials' });
    clientIds.add(id);
    if (path === '/login/device/code') {
      const device = token('dc');
      devices.set(device, { polls: 0 });
      return json(res, 200, {
        device_code: device,
        user_code: 'WDJB-MJHT',
        verification_uri: `${base}/login/device`,
        expires_in: 900,
        interval: 1,
      });
    }
    const grant = form.get('grant_type');
    if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
      const d = devices.get(form.get('device_code') ?? '');
      if (!d || fake.login.expired) return json(res, 200, { error: 'expired_token' });
      if (fake.login.deny) {
        devices.delete(form.get('device_code') ?? '');
        return json(res, 200, { error: 'access_denied' });
      }
      d.polls++;
      if (d.polls < fake.login.approveAfterPolls) return json(res, 200, { error: 'authorization_pending' });
      devices.delete(form.get('device_code') ?? '');
      return json(res, 200, issue());
    }
    if (grant === 'refresh_token') {
      const r = form.get('refresh_token') ?? '';
      if (!refresh.has(r)) return json(res, 200, { error: 'bad_refresh_token' });
      // Rotation: the old refresh token and every access token go.
      refresh.delete(r);
      access.clear();
      return json(res, 200, issue());
    }
    return json(res, 200, { error: 'unsupported_grant_type' });
  }

  function api(req: IncomingMessage, res: ServerResponse, path: string): void {
    const t = bearer(req);
    if (!t || !access.has(t)) return json(res, 401, { message: 'Bad credentials' });
    if (path === '/user') return json(res, 200, { id: user.id, login: user.login, name: user.name });
    const installed = [...repos.values()].filter((r) => r.installed);
    if (path.startsWith('/user/installations')) {
      const url = new URL(path, 'http://x');
      const page = Number(url.searchParams.get('page') ?? '1');
      if (url.pathname === '/user/installations') {
        return json(res, 200, {
          total_count: installed.length > 0 ? 1 : 0,
          installations: installed.length > 0 && page === 1 ? [{ id: 1 }] : [],
        });
      }
      if (url.pathname === '/user/installations/1/repositories') {
        const slice = installed.slice((page - 1) * 100, page * 100);
        return json(res, 200, { total_count: installed.length, repositories: slice.map(repoJson) });
      }
      return json(res, 404, { message: 'Not Found' });
    }
    const m = /^\/repos\/([^/]+)\/([^/?]+)$/.exec(path);
    if (m) {
      const r = repos.get(key(decodeURIComponent(m[1] as string), decodeURIComponent(m[2] as string)));
      // A user token reaches a private repo only where the app is installed.
      if (!r || (r.private && !r.installed)) return json(res, 404, { message: 'Not Found' });
      return json(res, 200, repoJson(r));
    }
    return json(res, 404, { message: 'Not Found' });
  }

  function gitHttp(req: IncomingMessage, res: ServerResponse, path: string, search: string): void {
    const m = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/.exec(path);
    const r = m ? repos.get(key(m[1] as string, m[2] as string)) : undefined;
    const t = bearer(req);
    if (!t) {
      req.resume();
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitHub"' }).end();
      return;
    }
    if (!access.has(t)) {
      req.resume();
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitHub"' }).end('Invalid username or token.');
      return;
    }
    if (!m || !r || !r.installed) {
      req.resume();
      res.writeHead(404).end('Repository not found.');
      return;
    }
    const env: Record<string, string> = {
      ...PLAIN_ENV,
      PATH: process.env['PATH'] ?? '',
      GIT_PROJECT_ROOT: reposRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      REQUEST_METHOD: req.method ?? 'GET',
      PATH_INFO: `/${r.owner.toLowerCase()}/${r.name.toLowerCase()}.git${m[3] as string}`,
      QUERY_STRING: search.replace(/^\?/, ''),
      REMOTE_USER: 'x-access-token',
      REMOTE_ADDR: '127.0.0.1',
    };
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v !== 'string') continue;
      const name = k.toUpperCase().replace(/-/g, '_');
      if (name === 'CONTENT_TYPE' || name === 'CONTENT_LENGTH') env[name] = v;
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
      const crlf = head.indexOf('\r\n\r\n');
      const lf = head.indexOf('\n\n');
      const at = crlf >= 0 ? crlf : lf;
      if (at < 0) return;
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
      const rest = head.subarray(at + (crlf >= 0 ? 4 : 2));
      if (rest.length > 0) res.write(rest);
    });
    child.on('close', () => {
      if (!headDone) res.writeHead(500);
      res.end();
    });
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({ method: req.method ?? '', path: url.pathname + url.search, token: bearer(req) });
    const path = url.pathname;
    if (req.method === 'POST' && (path === '/login/device/code' || path === '/login/oauth/access_token')) {
      void oauth(req, res, path).catch(() => res.writeHead(500).end());
      return;
    }
    if (path.startsWith('/api/')) {
      req.resume();
      api(req, res, path.slice(4) + url.search);
      return;
    }
    if (path.startsWith('/git/')) {
      gitHttp(req, res, path.slice(4), url.search);
      return;
    }
    req.resume();
    res.writeHead(404).end();
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
  const endpoints = { web: base, api: `${base}/api`, git: `${base}/git` };

  const fake: FakeGitHub = {
    url: base,
    env: JSON.stringify(endpoints),
    endpoints,
    clientIds,
    user,
    requests,
    tokens,
    login: { approveAfterPolls: 1, deny: false, expired: false },
    accessTokenSeconds: 28800,
    createRepo(owner, name, opts = {}) {
      const dir = join(reposRoot, owner.toLowerCase(), `${name.toLowerCase()}.git`);
      mkdirSync(dir, { recursive: true });
      const branch = opts.defaultBranch ?? 'main';
      execFileSync(git, ['init', '--quiet', '--bare', `--initial-branch=${branch}`, dir], {
        env: { ...process.env, ...PLAIN_ENV },
      });
      execFileSync(git, ['--git-dir', dir, 'config', 'http.receivepack', 'true'], {
        env: { ...process.env, ...PLAIN_ENV },
      });
      const repo: FakeRepo = {
        id: nextRepoId++,
        owner,
        name,
        private: opts.private ?? true,
        installed: opts.installed ?? true,
        defaultBranch: branch,
        dir,
      };
      repos.set(key(owner, name), repo);
      return repo;
    },
    repo(owner, name) {
      const r = repos.get(key(owner, name));
      if (!r) throw new Error(`no fake repo ${owner}/${name}`);
      return r;
    },
    setInstalled(owner, name, installed) {
      fake.repo(owner, name).installed = installed;
    },
    issueAccessToken() {
      return issue()['access_token'] as string;
    },
    expireAccessTokens() {
      access.clear();
    },
    revokeAll() {
      access.clear();
      refresh.clear();
    },
    rejectPushes(owner, name, kind) {
      const hooks = join(fake.repo(owner, name).dir, 'hooks');
      mkdirSync(hooks, { recursive: true });
      const hook = join(hooks, 'pre-receive');
      const message =
        kind === 'protected-branch'
          ? 'error: GH006: Protected branch update failed for refs/heads/main.'
          : 'error: GH001: Large files detected. You may want to try Git Large File Storage.';
      writeFileSync(hook, kind === null ? '#!/bin/sh\nexit 0\n' : `#!/bin/sh\necho "${message}" >&2\nexit 1\n`);
      chmodSync(hook, 0o755);
    },
    branchTip(owner, name, branch) {
      try {
        return execFileSync(
          git,
          ['--git-dir', fake.repo(owner, name).dir, 'rev-parse', '--verify', `refs/heads/${branch}`],
          {
            encoding: 'utf8',
            env: { ...process.env, ...PLAIN_ENV },
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        ).trim();
      } catch {
        return null;
      }
    },
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
  return fake;
}
