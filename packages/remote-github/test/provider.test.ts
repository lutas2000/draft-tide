import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DtError } from '@draft-tide/contracts';
import type { RemoteProvider } from '@draft-tide/core';
import { startFakeGitHub, type FakeGitHub } from '../../../fixtures/fake-github.ts';
import {
  GITHUB_ENDPOINTS,
  StoredGrant,
  createGitHubProvider,
  createHttp,
  createMemoryVault,
  isAllowedUrl,
  parseTestEndpoints,
  type TokenVault,
} from '../src/index.ts';

let gh: FakeGitHub;
let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'dt-gh-'));
  gh = await startFakeGitHub({ rootDir: root });
  gh.createRepo('designer', 'site', { private: true });
  gh.createRepo('designer', 'other', { private: true, installed: false });
  gh.createRepo('designer', 'public-uninstalled', { private: false, installed: false });
});

afterAll(async () => {
  await gh.close();
  rmSync(root, { recursive: true, force: true });
});

function provider(
  vault: TokenVault | null = createMemoryVault(),
  now?: () => number,
  fetchImpl?: typeof fetch,
): RemoteProvider {
  return createGitHubProvider({
    clientId: 'Iv23-test',
    appSlug: 'draft-tide-test',
    endpoints: parseTestEndpoints(gh.env),
    vault,
    userAgent: 'DraftTide/test',
    ...(now ? { now } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

async function codeOf(p: Promise<unknown>): Promise<{ code: string; reason: unknown }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DtError) return { code: e.code, reason: e.details['reason'] };
    throw e;
  }
  throw new Error('expected a failure');
}

async function signIn(p: RemoteProvider) {
  const login = await p.beginLogin();
  for (let i = 0; i < 10; i++) {
    const r = await p.pollLogin(login.handle);
    if (r.status !== 'pending') return r;
  }
  throw new Error('login never completed');
}

const refreshes = () => gh.requests.filter((r) => r.path === '/login/oauth/access_token').length;

describe('where the token may go', () => {
  it('allows only the endpoints, compared on the parsed URL', () => {
    expect(isAllowedUrl(GITHUB_ENDPOINTS, 'https://api.github.com/user')).toBe(true);
    expect(isAllowedUrl(GITHUB_ENDPOINTS, 'https://github.com/login/device/code')).toBe(true);
    for (const bad of [
      'http://api.github.com/user',
      'https://api.github.com.evil.example/user',
      'https://github.com@evil.example/',
      'https://x:y@api.github.com/user',
      'https://gist.github.com/',
      'https://evil.example/https://api.github.com/',
      'not a url',
    ]) {
      expect(isAllowedUrl(GITHUB_ENDPOINTS, bad), bad).toBe(false);
    }
    const test = parseTestEndpoints(gh.env);
    expect(isAllowedUrl(test, `${gh.url}/api/user`)).toBe(true);
    expect(isAllowedUrl(test, 'http://127.0.0.1:1/api/user')).toBe(false);
    expect(isAllowedUrl({ ...test, web: 'http://127.0.0.1:1' }, `${gh.url}/apix/user`)).toBe(false);
  });

  it('takes a test GitHub only on loopback http', () => {
    for (const bad of [
      '{"web":"https://github.com","api":"http://127.0.0.1:1","git":"http://127.0.0.1:1"}',
      '{"web":"http://10.0.0.1:1","api":"http://127.0.0.1:1","git":"http://127.0.0.1:1"}',
      '{"web":"http://a:b@127.0.0.1:1","api":"http://127.0.0.1:1","git":"http://127.0.0.1:1"}',
      '{"web":"http://127.0.0.1:1"}',
      'nope',
    ]) {
      expect(() => parseTestEndpoints(bad), bad).toThrow(DtError);
    }
  });

  it('refuses a request outside GitHub before anything is sent', async () => {
    let called = false;
    const http = createHttp({
      endpoints: GITHUB_ENDPOINTS,
      userAgent: 't',
      fetch: () => {
        called = true;
        return Promise.resolve(new Response('{}'));
      },
    });
    await expect(http({ method: 'GET', url: 'https://evil.example/', token: 'ghu_x' })).rejects.toThrow(DtError);
    expect(called).toBe(false);
  });

  it('says why GitHub could not be reached, as a retryable code', async () => {
    const http = createHttp({ endpoints: parseTestEndpoints(gh.env), userAgent: 't', timeoutMs: 2000 });
    const dead = createHttp({
      endpoints: parseTestEndpoints(
        '{"web":"http://127.0.0.1:9","api":"http://127.0.0.1:9","git":"http://127.0.0.1:9"}',
      ),
      userAgent: 't',
    });
    expect(await codeOf(dead({ method: 'GET', url: 'http://127.0.0.1:9/user' }))).toEqual({
      code: 'NETWORK_UNAVAILABLE',
      reason: 'unreachable',
    });
    expect((await http({ method: 'GET', url: `${gh.url}/api/nothing` })).status).toBe(401);
  });
});

describe('signing in with the device flow', () => {
  it('signs in with the client ID only and keeps the grant in the vault', async () => {
    const vault = createMemoryVault();
    const p = provider(vault);
    expect(await p.account()).toEqual({ state: 'signed-out' });
    gh.login.approveAfterPolls = 2;
    const login = await p.beginLogin();
    expect(login.userCode).toMatch(/^[A-Z0-9-]+$/);
    expect(login.verificationUri).toBe(`${gh.url}/login/device`);
    expect(await p.pollLogin(login.handle)).toMatchObject({ status: 'pending' });
    const done = await p.pollLogin(login.handle);
    expect(done).toEqual({ status: 'completed', user: gh.user });
    expect(await p.account()).toEqual({ state: 'signed-in', user: gh.user });
    const stored = StoredGrant.parse(JSON.parse(Buffer.from((await vault.read()) as Uint8Array).toString('utf8')));
    expect(stored.user).toEqual(gh.user);
    expect(gh.tokens).toContain(stored.tokens?.access);
    expect(gh.tokens).toContain(stored.tokens?.refresh);
    expect(gh.clientIds).toEqual(new Set(['Iv23-test']));
    gh.login.approveAfterPolls = 1;
  });

  it('ends a denied or expired login without signing in', async () => {
    const p = provider();
    gh.login.deny = true;
    expect(await signIn(p)).toEqual({ status: 'denied' });
    gh.login.deny = false;
    gh.login.expired = true;
    expect(await signIn(p)).toEqual({ status: 'expired' });
    gh.login.expired = false;
    expect(await p.account()).toEqual({ state: 'signed-out' });
  });

  it('reads an unreadable or refused vault as signed out', async () => {
    const garbage: TokenVault = {
      ...createMemoryVault(),
      read: () => Promise.resolve(new TextEncoder().encode('{"x":1}')),
    };
    expect(await provider(garbage).account()).toEqual({ state: 'signed-out' });
    const refusing: TokenVault = { ...createMemoryVault(), read: () => Promise.reject(new Error('errSecAuthFailed')) };
    expect(await provider(refusing).account()).toEqual({ state: 'signed-out' });
  });

  it('is unavailable without a client ID or a vault', async () => {
    const none = createGitHubProvider({
      clientId: null,
      appSlug: null,
      endpoints: GITHUB_ENDPOINTS,
      vault: createMemoryVault(),
      userAgent: 't',
    });
    expect(none.unavailable).toBe('no-client-id');
    expect(await codeOf(none.beginLogin())).toEqual({ code: 'AUTH_REQUIRED', reason: 'unavailable' });
    expect(provider(null).unavailable).toBe('no-keychain');
  });
});

describe('tokens', () => {
  it('refreshes before a Git operation, once for concurrent callers, writing the vault first', async () => {
    const writes: string[] = [];
    const inner = createMemoryVault();
    const vault: TokenVault = {
      ...inner,
      async write(bytes) {
        writes.push(Buffer.from(bytes).toString('utf8'));
        await inner.write(bytes);
      },
    };
    let clock = Date.now();
    const p = provider(vault, () => clock);
    await signIn(p);
    const first = (await p.gitAccess({ owner: 'designer', name: 'site' })).credential?.reveal();
    expect(first).toMatch(/^ghu_/);
    // Eight hours later the token is about to expire.
    clock += 8 * 60 * 60 * 1000;
    const before = refreshes();
    const [a, b] = await Promise.all([
      p.gitAccess({ owner: 'designer', name: 'site' }),
      p.gitAccess({ owner: 'designer', name: 'site' }),
    ]);
    expect(refreshes() - before).toBe(1);
    expect(a.credential?.reveal()).toBe(b.credential?.reveal());
    expect(a.credential?.reveal()).not.toBe(first);
    const last = StoredGrant.parse(JSON.parse(writes.at(-1) as string));
    expect(last.tokens?.access).toBe(a.credential?.reveal());
    expect(a.url).toBe(`${gh.url}/git/designer/site.git`);
    expect(a.allowHttp).toBe(true);
  });

  it('keeps the user but drops the tokens when the sign-in is revoked', async () => {
    const vault = createMemoryVault();
    const p = provider(vault);
    await signIn(p);
    gh.revokeAll();
    expect(await codeOf(p.listRepos())).toEqual({ code: 'AUTH_REQUIRED', reason: 'expired' });
    expect(await p.account()).toEqual({ state: 'expired', user: gh.user });
    const stored = StoredGrant.parse(JSON.parse(Buffer.from((await vault.read()) as Uint8Array).toString('utf8')));
    expect(stored.tokens).toBeNull();
    await p.signOut();
    expect(await p.account()).toEqual({ state: 'signed-out' });
    expect(await vault.read()).toBeNull();
  });

  it('retries an API call once after GitHub refuses an access token it still had', async () => {
    const p = provider();
    await signIn(p);
    gh.expireAccessTokens();
    const list = await p.listRepos();
    expect(list.repos.map((r) => r.name)).toContain('site');
  });

  it('never signs the user back in when they sign out while a refresh is running', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    let holding = false;
    const slowRefresh: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === 'string' ? init.body : '';
      if (url.endsWith('/login/oauth/access_token') && body.includes('refresh_token=')) {
        holding = true;
        await held;
      }
      return fetch(input, init);
    };
    const vault = createMemoryVault();
    let clock = Date.now();
    const p = provider(vault, () => clock, slowRefresh);
    await signIn(p);
    clock += 8 * 60 * 60 * 1000;
    const pending = p.gitAccess({ owner: 'designer', name: 'site' });
    await expect.poll(() => holding).toBe(true);
    await p.signOut();
    release();
    expect(await codeOf(pending)).toEqual({ code: 'AUTH_REQUIRED', reason: 'signed-out' });
    expect(await p.account()).toEqual({ state: 'signed-out' });
    expect(await vault.read()).toBeNull();
  });

  it('refreshes a token Git refused, once, if it is still the current one', async () => {
    const p = provider();
    await signIn(p);
    const first = await p.gitAccess({ owner: 'designer', name: 'site' });
    const before = refreshes();
    const second = await p.gitAccess({ owner: 'designer', name: 'site' }, undefined, first);
    expect(refreshes() - before).toBe(1);
    expect(second.credential?.reveal()).not.toBe(first.credential?.reveal());
    // The refused token is no longer the current one: no second refresh.
    const third = await p.gitAccess({ owner: 'designer', name: 'site' }, undefined, first);
    expect(refreshes() - before).toBe(1);
    expect(third.credential?.reveal()).toBe(second.credential?.reveal());
  });

  it('asks for a sign-in when nobody is signed in', async () => {
    expect(await codeOf(provider().gitAccess({ owner: 'designer', name: 'site' }))).toEqual({
      code: 'AUTH_REQUIRED',
      reason: 'signed-out',
    });
  });
});

describe('repositories', () => {
  it('lists the repositories the app is installed on', async () => {
    const p = provider();
    await signIn(p);
    const list = await p.listRepos();
    expect(list.installations).toBe(1);
    expect(list.repos.map((r) => `${r.owner}/${r.name}`)).toEqual(['designer/site']);
    expect(list.repos[0]).toMatchObject({
      visibility: 'private',
      defaultBranch: 'main',
      htmlUrl: `${gh.url}/designer/site`,
    });
  });

  it('checks push access against the installations, not the repository alone', async () => {
    const p = provider();
    await signIn(p);
    expect(await p.getRepo({ owner: 'designer', name: 'site' }, 'push')).toMatchObject({ name: 'site' });
    expect(await codeOf(p.getRepo({ owner: 'designer', name: 'other' }, 'push'))).toEqual({
      code: 'REMOTE_REJECTED',
      reason: 'app-not-installed',
    });
    // A public repository without the app: neither pushed to nor opened (only
    // the user's own synced repositories are written into folders).
    expect(await codeOf(p.getRepo({ owner: 'designer', name: 'public-uninstalled' }, 'open'))).toEqual({
      code: 'REMOTE_REJECTED',
      reason: 'app-not-installed',
    });
    expect(await p.getRepo({ owner: 'designer', name: 'site' }, 'open')).toMatchObject({ name: 'site' });
    expect(await codeOf(p.getRepo({ owner: 'designer', name: 'public-uninstalled' }, 'push'))).toEqual({
      code: 'REMOTE_REJECTED',
      reason: 'app-not-installed',
    });
  });
});
