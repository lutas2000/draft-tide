import { z } from 'zod';
import {
  BranchName,
  DtError,
  GitHubLogin,
  GitHubRepoName,
  GitHubUser,
  IsoTimestamp,
  type GitHubLinks,
  type GitHubRepo,
  type RemoteRepoList,
  type RepoRef,
} from '@draft-tide/contracts';
import type { AccountState, DeviceLogin, GitAccess, LoginPoll, RemoteProvider } from '@draft-tide/core';
import { repoGitUrl, type GitHubEndpoints } from './endpoints.ts';
import { createHttp, type HttpRequest, type HttpResponse } from './http.ts';

// The Engine's GitHub (M1 plan §10.1–10.2): a GitHub App's device flow with
// the public client ID only (no client secret, no private key), expiring user
// tokens with refresh, and the app's installations as the list of
// repositories the user can connect.
//
// The token never leaves this module except as a GitCredential for one Git
// operation (git-backend writes it into a 0600 askpass file). Core gets the
// account and repositories.
//
// Refresh (S15): every refresh voids the old access token and the old refresh
// token. So one refresh runs at a time, the new grant is written to the vault
// before the new access token is used (a crash before the write only means
// signing in again), and a Git operation gets a token refreshed before it
// starts, never during it.

// ---- What the vault holds (one keychain item per data store)

const Token = z.string().regex(/^[A-Za-z0-9_]{1,1024}$/);

export const StoredGrant = z.strictObject({
  version: z.literal(1),
  user: GitHubUser,
  // null: the sign-in expired or was revoked. The user stays (the commit
  // identity) until they sign out.
  tokens: z
    .strictObject({
      access: Token,
      // null: the token doesn't expire (an app without expiring tokens).
      accessExpiresAt: IsoTimestamp.nullable(),
      refresh: Token.nullable(),
      refreshExpiresAt: IsoTimestamp.nullable(),
    })
    .nullable(),
});
export type StoredGrant = z.infer<typeof StoredGrant>;

// Where the grant lives: the OS keychain in the Engine, memory in tests.
export interface TokenVault {
  readonly kind: 'keychain' | 'memory';
  // null when there is no item. Throws when the keychain refuses.
  read(): Promise<Uint8Array | null>;
  write(bytes: Uint8Array): Promise<void>;
  clear(): Promise<void>;
}

export function createMemoryVault(): TokenVault {
  let held: Uint8Array | null = null;
  return {
    kind: 'memory',
    read: () => Promise.resolve(held && new Uint8Array(held)),
    write: (bytes) => {
      held = new Uint8Array(bytes);
      return Promise.resolve();
    },
    clear: () => {
      held = null;
      return Promise.resolve();
    },
  };
}

// ---- GitHub's answers

const DeviceCodeResponse = z.object({
  device_code: z.string().min(1).max(512),
  user_code: z.string().regex(/^[A-Z0-9-]{4,16}$/),
  verification_uri: z.string().max(200),
  expires_in: z.number().int().positive().max(3600),
  interval: z.number().int().positive().max(60),
});

const TokenResponse = z.object({
  access_token: Token,
  expires_in: z.number().int().positive().optional(),
  refresh_token: Token.optional(),
  refresh_token_expires_in: z.number().int().positive().optional(),
});

const OAuthError = z.object({ error: z.string().max(100), interval: z.number().int().positive().max(120).optional() });

const UserResponse = z.object({ id: z.number().int().positive(), login: GitHubLogin, name: z.string().nullable() });

const RepoResponse = z.object({
  id: z.number().int().positive(),
  name: GitHubRepoName,
  owner: z.object({ login: GitHubLogin }),
  private: z.boolean(),
  visibility: z.enum(['private', 'public', 'internal']).optional(),
  default_branch: z.string().nullable().optional(),
  html_url: z.string().max(300),
  permissions: z.object({ push: z.boolean().optional() }).partial().optional(),
});
type RepoResponse = z.infer<typeof RepoResponse>;

const InstallationsResponse = z.object({
  installations: z.array(z.object({ id: z.number().int().positive() })),
});
const InstallationReposResponse = z.object({ repositories: z.array(z.unknown()) });

// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/gu;

function displayName(name: string | null): string | null {
  if (name === null) return null;
  const clean = Array.from(name.replace(CONTROLS, '').trim()).slice(0, 255).join('');
  return clean === '' ? null : clean;
}

function toRepo(r: RepoResponse): GitHubRepo {
  const branch = BranchName.safeParse(r.default_branch ?? null);
  return {
    id: r.id,
    owner: r.owner.login,
    name: r.name,
    visibility: r.visibility ?? (r.private ? 'private' : 'public'),
    defaultBranch: branch.success ? branch.data : null,
    htmlUrl: r.html_url.slice(0, 300),
  };
}

export interface GitHubProviderOptions {
  // The GitHub App's public client ID, compiled into the build; null: none.
  clientId: string | null;
  // The app's URL name (for its install page).
  appSlug: string | null;
  endpoints: GitHubEndpoints;
  // null: no keychain on this computer.
  vault: TokenVault | null;
  userAgent: string;
  now?: () => number;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

// Refresh this long before the access token expires, so a Git operation
// never starts with a token that runs out part-way.
const REFRESH_MARGIN_MS = 10 * 60_000;
const REFRESH_TIMEOUT_MS = 120_000;
const MAX_REPOS = 1000;
const REPO_LIST_TTL_MS = 30_000;

const signedOut = () =>
  new DtError('AUTH_REQUIRED', 'sign in to GitHub in the Draft Tide app first', { reason: 'signed-out' });
const expired = () =>
  new DtError('AUTH_REQUIRED', 'the GitHub sign-in expired; sign in again in the Draft Tide app', {
    reason: 'expired',
  });

export function createGitHubProvider(options: GitHubProviderOptions): RemoteProvider {
  const { endpoints, vault, clientId } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const http = createHttp({
    endpoints,
    userAgent: options.userAgent,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const unavailable = clientId === null ? 'no-client-id' : vault === null ? 'no-keychain' : null;
  const iso = (ms: number) => new Date(ms).toISOString();

  // The grant as last read or written; undefined until first needed.
  let grant: StoredGrant | null | undefined;
  // Bumped by signing out and by a new sign-in. A refresh or expiry that
  // began under another epoch never writes: a refresh still running when
  // the user signs out must not sign them back in.
  let epoch = 0;
  let refreshing: Promise<StoredGrant> | null = null;
  const logins = new Map<string, { deviceCode: string; expiresAt: number }>();
  let repoCache: { at: number; list: RemoteRepoList; raw: Map<number, RepoResponse> } | null = null;

  function requireAvailable(): { clientId: string; vault: TokenVault } {
    if (clientId === null || vault === null) {
      throw new DtError('AUTH_REQUIRED', "this copy of Draft Tide can't sign in to GitHub", {
        reason: 'unavailable',
        why: unavailable,
      });
    }
    return { clientId, vault };
  }

  async function load(): Promise<StoredGrant | null> {
    if (grant !== undefined) return grant;
    if (vault === null) return (grant = null);
    let bytes: Uint8Array | null;
    try {
      bytes = await vault.read();
    } catch (e) {
      // The keychain refused (another build's item, a locked keychain): as
      // signed out. Never ask the user from here.
      log(`keychain read failed: ${e instanceof Error ? e.message : String(e)}`);
      return (grant = null);
    }
    if (bytes === null) return (grant = null);
    try {
      grant = StoredGrant.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
    } catch {
      log('the stored GitHub sign-in could not be read; treating as signed out');
      grant = null;
    }
    return grant;
  }

  // Writes the grant, unless the sign-in it belongs to was replaced or
  // signed out meanwhile (then nothing is written: signed-out).
  async function save(next: StoredGrant, at: number): Promise<void> {
    const { vault: v } = requireAvailable();
    if (at !== epoch) throw signedOut();
    await v.write(Buffer.from(JSON.stringify(next), 'utf8'));
    grant = next;
  }

  // The sign-in stopped working: keep the user (identity), drop the tokens.
  async function markExpired(g: StoredGrant, at: number): Promise<void> {
    repoCache = null;
    if (at !== epoch) return;
    try {
      await save({ ...g, tokens: null }, at);
    } catch (e) {
      log(`could not record the expired sign-in: ${e instanceof Error ? e.message : String(e)}`);
      grant = { ...g, tokens: null };
    }
  }

  function grantFrom(body: z.infer<typeof TokenResponse>, user: GitHubUser): StoredGrant {
    const t = now();
    return {
      version: 1,
      user,
      tokens: {
        access: body.access_token,
        accessExpiresAt: body.expires_in ? iso(t + body.expires_in * 1000) : null,
        refresh: body.refresh_token ?? null,
        refreshExpiresAt:
          body.refresh_token && body.refresh_token_expires_in ? iso(t + body.refresh_token_expires_in * 1000) : null,
      },
    };
  }

  const oauth = (form: Record<string, string>, signal?: AbortSignal, timeoutMs?: number) =>
    http({
      method: 'POST',
      url: `${endpoints.web}/login/oauth/access_token`,
      form,
      signal,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });

  // Never cancelled: once GitHub has rotated the tokens, dropping its answer
  // would lose the only valid refresh token.
  async function refresh(g: StoredGrant): Promise<StoredGrant> {
    const at = epoch;
    const tokens = g.tokens;
    if (!tokens?.refresh) {
      await markExpired(g, at);
      throw expired();
    }
    if (tokens.refreshExpiresAt !== null && Date.parse(tokens.refreshExpiresAt) <= now()) {
      await markExpired(g, at);
      throw expired();
    }
    const { clientId: id } = requireAvailable();
    // A generous timeout, not the API's: an answer that arrives late still
    // carries the only valid refresh token.
    const res = await oauth(
      { client_id: id, grant_type: 'refresh_token', refresh_token: tokens.refresh },
      undefined,
      REFRESH_TIMEOUT_MS,
    );
    if (at !== epoch) throw signedOut();
    const ok = TokenResponse.safeParse(res.body);
    if (res.status !== 200 || !ok.success) {
      const err = OAuthError.safeParse(res.body);
      log(`token refresh refused: ${err.success ? err.data.error : `status ${res.status}`}`);
      await markExpired(g, at);
      throw expired();
    }
    const next = grantFrom(ok.data, g.user);
    // Written before the new access token is used: the old refresh token is
    // void now, so this grant is the only way back in.
    try {
      await save(next, at);
    } catch (e) {
      if (e instanceof DtError && e.code === 'AUTH_REQUIRED') throw e;
      log(`could not store the refreshed sign-in: ${e instanceof Error ? e.message : String(e)}`);
      grant = { ...g, tokens: null };
      throw expired();
    }
    return next;
  }

  // A usable access token: refreshed first when it expires within the margin,
  // or when GitHub just refused `refused` and it is still the current one.
  // One refresh at a time; callers share it.
  async function fresh(refused?: string): Promise<StoredGrant> {
    requireAvailable();
    if (refreshing) return refreshing;
    const g = await load();
    if (g === null) throw signedOut();
    if (g.tokens === null) throw expired();
    const exp = g.tokens.accessExpiresAt;
    const due =
      refused !== undefined
        ? g.tokens.access === refused
        : exp !== null && Date.parse(exp) - now() <= REFRESH_MARGIN_MS;
    if (!due) return g;
    refreshing ??= refresh(g).finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  // An API call with the user's token; refused once with 401, the token is
  // refreshed and the call made again.
  async function api(path: string, signal?: AbortSignal): Promise<HttpResponse> {
    let g = await fresh();
    const req = (token: string): HttpRequest => ({ method: 'GET', url: `${endpoints.api}${path}`, token, signal });
    const first = (g.tokens as NonNullable<StoredGrant['tokens']>).access;
    let res = await http(req(first));
    if (res.status === 401) {
      g = await fresh(first);
      res = await http(req((g.tokens as NonNullable<StoredGrant['tokens']>).access));
      if (res.status === 401) {
        await markExpired(g, epoch);
        throw expired();
      }
    }
    return res;
  }

  // fresh: the user just created a repository or installed the app; the
  // list they asked for must show it. The push-access check reuses a recent
  // list, and asks again before refusing.
  async function listAll(signal?: AbortSignal, fresh = false): Promise<NonNullable<typeof repoCache>> {
    if (!fresh && repoCache && now() - repoCache.at < REPO_LIST_TTL_MS) return repoCache;
    const installations: number[] = [];
    for (let page = 1; page <= 10; page++) {
      const res = await api(`/user/installations?per_page=100&page=${page}`, signal);
      if (res.status !== 200)
        throw new DtError('NETWORK_UNAVAILABLE', 'GitHub failed to list installations', {
          reason: 'server-error',
          status: res.status,
        });
      const body = InstallationsResponse.parse(res.body);
      installations.push(...body.installations.map((i) => i.id));
      if (body.installations.length < 100) break;
    }
    const raw = new Map<number, RepoResponse>();
    let truncated = false;
    outer: for (const id of installations) {
      for (let page = 1; page <= 20; page++) {
        const res = await api(`/user/installations/${id}/repositories?per_page=100&page=${page}`, signal);
        if (res.status === 404) break;
        if (res.status !== 200)
          throw new DtError('NETWORK_UNAVAILABLE', 'GitHub failed to list repositories', {
            reason: 'server-error',
            status: res.status,
          });
        const body = InstallationReposResponse.parse(res.body);
        for (const item of body.repositories) {
          const r = RepoResponse.safeParse(item);
          if (!r.success) continue;
          if (raw.size >= MAX_REPOS) {
            truncated = true;
            break outer;
          }
          raw.set(r.data.id, r.data);
        }
        if (body.repositories.length < 100) break;
      }
    }
    const repos = [...raw.values()]
      .map(toRepo)
      .sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`));
    repoCache = { at: now(), list: { repos, installations: installations.length, truncated }, raw };
    return repoCache;
  }

  const links: GitHubLinks | null =
    options.appSlug === null
      ? null
      : {
          newRepo: `${endpoints.web}/new`,
          installApp: `${endpoints.web}/apps/${encodeURIComponent(options.appSlug)}/installations/new`,
          authorizedApps: `${endpoints.web}/settings/apps/authorizations`,
        };

  return {
    unavailable,
    links,

    async account(): Promise<AccountState> {
      if (unavailable !== null) return { state: 'signed-out' };
      const g = await load();
      if (g === null) return { state: 'signed-out' };
      const t = g.tokens;
      const dead =
        t === null ||
        (t.accessExpiresAt !== null &&
          Date.parse(t.accessExpiresAt) <= now() &&
          (t.refresh === null || (t.refreshExpiresAt !== null && Date.parse(t.refreshExpiresAt) <= now())));
      return { state: dead ? 'expired' : 'signed-in', user: g.user };
    },

    async beginLogin(signal): Promise<DeviceLogin> {
      const { clientId: id } = requireAvailable();
      const res = await http({
        method: 'POST',
        url: `${endpoints.web}/login/device/code`,
        form: { client_id: id },
        signal,
      });
      const body = DeviceCodeResponse.safeParse(res.body);
      if (res.status !== 200 || !body.success) {
        const err = OAuthError.safeParse(res.body);
        throw new DtError('AUTH_REQUIRED', "GitHub didn't start the sign-in", {
          reason: 'unavailable',
          why: err.success ? err.data.error : `status ${res.status}`,
        });
      }
      const handle = crypto.randomUUID();
      const expiresAt = now() + body.data.expires_in * 1000;
      logins.set(handle, { deviceCode: body.data.device_code, expiresAt });
      return {
        handle,
        userCode: body.data.user_code,
        verificationUri: body.data.verification_uri,
        expiresAt: iso(expiresAt),
        intervalMs: body.data.interval * 1000,
      };
    },

    async pollLogin(handle, signal): Promise<LoginPoll> {
      const { clientId: id } = requireAvailable();
      const login = logins.get(handle);
      if (!login || login.expiresAt <= now()) {
        logins.delete(handle);
        return { status: 'expired' };
      }
      const res = await oauth(
        { client_id: id, device_code: login.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
        signal,
      );
      const token = TokenResponse.safeParse(res.body);
      if (res.status === 200 && token.success) {
        logins.delete(handle);
        const userRes = await http({
          method: 'GET',
          url: `${endpoints.api}/user`,
          token: token.data.access_token,
          signal,
        });
        const user = UserResponse.safeParse(userRes.body);
        if (userRes.status !== 200 || !user.success) {
          throw new DtError('NETWORK_UNAVAILABLE', "GitHub didn't say who signed in; try again", {
            reason: 'server-error',
          });
        }
        const profile: GitHubUser = { id: user.data.id, login: user.data.login, name: displayName(user.data.name) };
        // A new sign-in: whatever the previous one was doing never writes.
        epoch++;
        await save(grantFrom(token.data, profile), epoch);
        repoCache = null;
        return { status: 'completed', user: profile };
      }
      const err = OAuthError.safeParse(res.body);
      const code = err.success ? err.data.error : '';
      if (code === 'authorization_pending') return { status: 'pending', intervalMs: (err.data?.interval ?? 5) * 1000 };
      if (code === 'slow_down') return { status: 'pending', intervalMs: (err.data?.interval ?? 10) * 1000 };
      logins.delete(handle);
      if (code === 'access_denied') return { status: 'denied' };
      if (code === 'expired_token' || code === 'incorrect_device_code') return { status: 'expired' };
      throw new DtError('AUTH_REQUIRED', "GitHub couldn't complete the sign-in", {
        reason: 'unavailable',
        why: code || `status ${res.status}`,
      });
    },

    forgetLogin(handle) {
      logins.delete(handle);
    },

    async signOut() {
      epoch++;
      repoCache = null;
      grant = null;
      if (vault !== null) await vault.clear();
    },

    async listRepos(signal) {
      return (await listAll(signal, true)).list;
    },

    async getRepo(ref: RepoRef, purpose, signal): Promise<GitHubRepo> {
      const res = await api(`/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`, signal);
      if (res.status === 404 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
        throw new DtError(
          'REMOTE_REJECTED',
          "this repository wasn't found: install Draft Tide's GitHub App on it, or check its name",
          { reason: 'app-not-installed' },
        );
      }
      const parsed = RepoResponse.safeParse(res.body);
      if (res.status !== 200 || !parsed.success) {
        throw new DtError('NETWORK_UNAVAILABLE', 'GitHub sent an answer Draft Tide could not read', {
          reason: 'server-error',
          status: res.status,
        });
      }
      {
        // The app must be installed on it (a user token reaches only those):
        // for pushing, and for opening too, so that only the user's own
        // synced repositories (never any public one) can be written into a
        // folder. Pushing also needs the user's own role to allow it; the
        // repository's `permissions` alone says nothing about the app.
        let installed = (await listAll(signal)).raw.get(parsed.data.id);
        if (!installed) {
          repoCache = null;
          installed = (await listAll(signal)).raw.get(parsed.data.id);
        }
        if (!installed) {
          throw new DtError(
            'REMOTE_REJECTED',
            "Draft Tide's GitHub App isn't installed on this repository: install it, then try again",
            { reason: 'app-not-installed' },
          );
        }
        if (purpose === 'push' && (parsed.data.permissions?.push === false || installed.permissions?.push === false)) {
          throw new DtError('REMOTE_REJECTED', "your GitHub account can't push to this repository", {
            reason: 'no-push-access',
          });
        }
      }
      return toRepo(parsed.data);
    },

    async gitAccess(ref, _signal, refused): Promise<GitAccess> {
      const g = await fresh(refused?.credential?.reveal());
      const token = (g.tokens as NonNullable<StoredGrant['tokens']>).access;
      return {
        url: repoGitUrl(endpoints, ref.owner, ref.name),
        credential: { username: 'x-access-token', reveal: () => token },
        allowHttp: endpoints.allowHttp,
      };
    },
  };
}
