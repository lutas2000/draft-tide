import { DtError, TEST_GITHUB_ENV } from '@draft-tide/contracts';

// Where the Engine may talk to GitHub (M1 plan §10.1 "只送往 GitHub"). The
// token is only ever sent to these, checked before every request: a remote
// binding in the (same-user writable) data store names a repository by owner
// and name, never by an address the token would follow.
export interface GitHubEndpoints {
  // Device flow, token exchange and the pages the user opens.
  web: string;
  // The REST API.
  api: string;
  // Repositories' Git addresses: <git>/<owner>/<name>.git
  git: string;
  // Plain http: only the test GitHub on loopback.
  allowHttp: boolean;
}

export const GITHUB_ENDPOINTS: GitHubEndpoints = Object.freeze({
  web: 'https://github.com',
  api: 'https://api.github.com',
  git: 'https://github.com',
  allowHttp: false,
});

export { TEST_GITHUB_ENV };

function loopbackBase(value: unknown): string {
  if (typeof value !== 'string') throw new Error('not a string');
  const url = new URL(value);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'http:' || !loopback || url.username || url.password || url.search || url.hash) {
    throw new Error('must be an http URL on loopback');
  }
  return url.href.replace(/\/+$/, '');
}

export function parseTestEndpoints(json: string): GitHubEndpoints {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    return {
      web: loopbackBase(raw['web']),
      api: loopbackBase(raw['api']),
      git: loopbackBase(raw['git']),
      allowHttp: true,
    };
  } catch (e) {
    throw new DtError('INVALID_ARGUMENT', `${TEST_GITHUB_ENV}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Whether a request URL is under one of the endpoints' bases (the token may
// be attached). Compared on the parsed URL, so `https://github.com.evil/` or
// `https://github.com@evil/` never match.
export function isAllowedUrl(endpoints: GitHubEndpoints, target: string): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol !== 'https:' && !(endpoints.allowHttp && url.protocol === 'http:')) return false;
  return [endpoints.web, endpoints.api].some((base) => {
    const b = new URL(base);
    if (b.origin !== url.origin) return false;
    const prefix = b.pathname.replace(/\/+$/, '');
    return prefix === '' || url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
  });
}

export function repoGitUrl(endpoints: GitHubEndpoints, owner: string, name: string): string {
  return `${endpoints.git}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}.git`;
}
