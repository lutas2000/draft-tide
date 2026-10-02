import { DtError } from '@draft-tide/contracts';
import { isAllowedUrl, type GitHubEndpoints } from './endpoints.ts';

// One request to GitHub. The URL is checked against the endpoints before
// anything is sent (the token goes nowhere else), redirects are never
// followed (a redirect must not carry the token to another place), the body
// is bounded, and failures become stable codes:
//
//   no answer, refused, DNS        NETWORK_UNAVAILABLE unreachable
//   no answer in time              NETWORK_UNAVAILABLE timeout
//   certificate or TLS failure     NETWORK_UNAVAILABLE tls
//   429, or 403 out of rate limit  NETWORK_UNAVAILABLE rate-limited
//   5xx                            NETWORK_UNAVAILABLE server-error
//
// Anything else (401, 404, another 403) is the caller's to interpret.

export interface HttpResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  // Sent as `Authorization: Bearer`; only to an allowed URL.
  token?: string;
  // application/x-www-form-urlencoded (GitHub's OAuth endpoints).
  form?: Record<string, string>;
  signal?: AbortSignal | undefined;
  // Instead of the client's default.
  timeoutMs?: number;
}

export interface HttpOptions {
  endpoints: GitHubEndpoints;
  userAgent: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

function causeCode(e: unknown): string {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur instanceof Error; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return '';
}

function messages(e: unknown): string {
  const out: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur instanceof Error; i++) {
    out.push(cur.name, cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out.join(' ');
}

function transportError(e: unknown): DtError {
  const text = `${causeCode(e)} ${messages(e)}`;
  if (/TIMEOUT|TimeoutError|timed out/i.test(text)) {
    return new DtError('NETWORK_UNAVAILABLE', "GitHub didn't answer in time; your versions are safe here", {
      reason: 'timeout',
    });
  }
  if (/CERT|SSL|TLS|self.signed|certificate/i.test(text)) {
    return new DtError('NETWORK_UNAVAILABLE', "the connection to GitHub couldn't be verified", { reason: 'tls' });
  }
  return new DtError('NETWORK_UNAVAILABLE', "GitHub couldn't be reached; your versions are safe here", {
    reason: 'unreachable',
  });
}

async function readBounded(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new DtError('RESOURCE_BUDGET_EXCEEDED', 'GitHub sent more than expected', {
        budget: 'github-response',
        limitBytes: MAX_BODY_BYTES,
      });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createHttp(options: HttpOptions): (req: HttpRequest) => Promise<HttpResponse> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (req) => {
    if (!isAllowedUrl(options.endpoints, req.url)) {
      throw new DtError('INTERNAL_ERROR', 'refusing a request outside GitHub');
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': options.userAgent,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (req.token !== undefined) {
      if (!/^[A-Za-z0-9_]{1,1024}$/.test(req.token)) throw new DtError('INTERNAL_ERROR', 'malformed token');
      headers['Authorization'] = `Bearer ${req.token}`;
    }
    let body: string | undefined;
    if (req.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(req.form).toString();
    }
    const timeout = AbortSignal.timeout(req.timeoutMs ?? timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let res: Response;
    let text: string;
    try {
      res = await doFetch(req.url, {
        method: req.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: 'manual',
        signal,
      });
      text = await readBounded(res);
    } catch (e) {
      if (req.signal?.aborted) throw req.signal.reason;
      if (e instanceof DtError) throw e;
      throw transportError(e);
    }
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (res.status === 429 || (res.status === 403 && (remaining === '0' || res.headers.has('retry-after')))) {
      throw new DtError('NETWORK_UNAVAILABLE', 'GitHub asked to wait; it is tried again later', {
        reason: 'rate-limited',
      });
    }
    if (res.status >= 500) {
      throw new DtError('NETWORK_UNAVAILABLE', 'GitHub failed to answer; it is tried again later', {
        reason: 'server-error',
        status: res.status,
      });
    }
    let parsed: unknown = null;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new DtError('NETWORK_UNAVAILABLE', 'GitHub sent an answer Draft Tide could not read', {
          reason: 'server-error',
          status: res.status,
        });
      }
    }
    return { status: res.status, headers: res.headers, body: parsed };
  };
}
