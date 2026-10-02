// M1-00: GitHub App user token through the device flow. Run it yourself; it
// needs a person to enter the code in a browser and writes to real remotes.
//
//   DT_APP_CLIENT_ID=<GitHub App client id> \
//   DT_APP_REPO=<owner>/<repo the app is installed on (must have a default branch)> \
//   DT_APP_OTHER_REPO=<owner>/<repo the app is NOT installed on> \
//   node src/github-app-check.ts
//
// What it does (and only this):
//   1. device flow with the client id only (no secret): prints a code, polls
//   2. reads /user (commit identity), /user/installations and the repo's visibility
//   3. push / fetch / clone / delete of a NEW dt-app-<random> branch in DT_APP_REPO
//   4. expects DT_APP_OTHER_REPO to be invisible and refuse a push
//   5. refreshes the token without a client secret, then reuses the old refresh token
// Tokens stay in this process's memory. Git gets them only through the spike's
// askpass file; every printed line is scrubbed of them.
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGitRuntime } from './git.ts';
import { DesignRepo } from './repo.ts';
import { cloneFromRemote, deleteRemoteBranch, fetchRemote, pushBranch, type Credential } from './sync.ts';

const clientId = process.env['DT_APP_CLIENT_ID'];
const repoName = process.env['DT_APP_REPO'];
const otherName = process.env['DT_APP_OTHER_REPO'];
if (!clientId || !repoName || !otherName) {
  console.error('set DT_APP_CLIENT_ID, DT_APP_REPO and DT_APP_OTHER_REPO; see the header of this file');
  process.exit(2);
}

const secrets = new Set<string>();
const scrub = (s: string): string => {
  let out = s;
  for (const t of secrets) if (t) out = out.split(t).join('<redacted>');
  return out;
};
const say = (m: string) => console.log(scrub(m));
const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail = '') => {
  results.push({ check, ok, detail: scrub(detail) });
  say(`${ok ? 'PASS' : 'FAIL'}  ${check}${detail ? ` — ${detail}` : ''}`);
};
const errText = (e: unknown) => {
  const err = e as { code?: string; message?: string };
  return `${err.code ?? ''} ${err.message ?? String(e)}`.trim();
};

type Json = Record<string, unknown>;
async function form(url: string, body: Record<string, string>): Promise<Json> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  return (await res.json()) as Json;
}
async function api(token: string, path: string): Promise<{ status: number; body: Json; headers: Headers }> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
  });
  const text = await res.text();
  let body: Json = {};
  try {
    body = JSON.parse(text) as Json;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body, headers: res.headers };
}
const remember = (j: Json) => {
  for (const k of ['access_token', 'refresh_token', 'device_code']) if (typeof j[k] === 'string') secrets.add(j[k] as string);
};

// 1. Device flow
const code = await form('https://github.com/login/device/code', { client_id: clientId });
remember(code);
if (typeof code['user_code'] !== 'string') {
  record('device code issued with client id only', false, JSON.stringify(code));
  process.exit(1);
}
record('device code issued with client id only', true, `expires in ${String(code['expires_in'])} s, interval ${String(code['interval'])} s`);
say(`\n>>> Open ${String(code['verification_uri'])} and enter: ${String(code['user_code'])}\n`);

let interval = Number(code['interval'] ?? 5);
const deadline = Date.now() + Number(code['expires_in'] ?? 900) * 1000;
let tok: Json | null = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, interval * 1000));
  const j = await form('https://github.com/login/oauth/access_token', {
    client_id: clientId,
    device_code: String(code['device_code']),
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  remember(j);
  if (typeof j['access_token'] === 'string') {
    tok = j;
    break;
  }
  if (j['error'] === 'authorization_pending') continue;
  if (j['error'] === 'slow_down') {
    interval = Number(j['interval'] ?? interval + 5);
    continue;
  }
  record('device flow token', false, String(j['error'] ?? JSON.stringify(j)));
  process.exit(1);
}
if (!tok) {
  record('device flow token', false, 'timed out');
  process.exit(1);
}
const access = String(tok['access_token']);
const refresh = typeof tok['refresh_token'] === 'string' ? tok['refresh_token'] : null;
record(
  'device flow token without a client secret',
  true,
  `prefix ${access.slice(0, 4)}, scope "${String(tok['scope'] ?? '')}", expires_in ${String(tok['expires_in'] ?? 'none')}, refresh token ${refresh ? `yes (prefix ${refresh.slice(0, 4)}, expires_in ${String(tok['refresh_token_expires_in'])})` : 'no'}`,
);

const work = mkdtempSync(join(tmpdir(), 'dt-github-app-check-'));
const branch = `dt-app-${randomBytes(4).toString('hex')}`;
let pushedBranch = false;
try {
  // 2. Identity, installations, visibility
  const user = await api(access, '/user');
  const id = user.body['id'];
  const login = user.body['login'];
  record('GET /user', user.status === 200, `login ${String(login)}, id ${String(id)}, name ${user.body['name'] ? 'set' : 'empty'}, noreply ${String(id)}+${String(login)}@users.noreply.github.com`);
  say(`      token expiry header: ${user.headers.get('github-authentication-token-expiration') ?? 'none'}; x-oauth-scopes: ${user.headers.get('x-oauth-scopes') ?? 'absent'}`);

  const inst = await api(access, '/user/installations');
  const list = (inst.body['installations'] as Json[] | undefined) ?? [];
  record('GET /user/installations', inst.status === 200, list.map((i) => `${String(i['app_slug'])}#${String(i['id'])} on ${String((i['account'] as Json)['login'])} (${String(i['repository_selection'])})`).join('; ') || 'none');
  for (const i of list) {
    const repos = await api(access, `/user/installations/${String(i['id'])}/repositories`);
    const names = ((repos.body['repositories'] as Json[] | undefined) ?? []).map((r) => String(r['full_name']));
    record(`installation #${String(i['id'])} repositories`, repos.status === 200, names.join(', '));
  }

  const repo = await api(access, `/repos/${repoName}`);
  const perms = repo.body['permissions'] as Json | undefined;
  record(
    `GET /repos/${repoName} (visibility)`,
    repo.status === 200 && typeof repo.body['visibility'] === 'string',
    `visibility ${String(repo.body['visibility'])}, private ${String(repo.body['private'])}, default ${String(repo.body['default_branch'])}, permissions ${perms ? JSON.stringify(perms) : 'absent'}`,
  );

  const other = await api(access, `/repos/${otherName}`);
  record(`GET /repos/${otherName} is hidden (not installed)`, other.status === 404, `HTTP ${other.status}`);

  // 3. Git over https with the user token
  const rt = resolveGitRuntime(join(work, 'git-home'));
  const cred: Credential = { username: 'x-access-token', token: access };
  const root = join(work, 'design');
  mkdirSync(root);
  writeFileSync(join(root, 'index.html'), '<h1>draft tide github app check</h1>\n');
  const design = await DesignRepo.adopt(rt, join(work, 'data'), root, { name: 'GitHub App check', entryFiles: ['index.html'] });
  const saved = await design.save({ name: 'check' });
  const binding = { url: `https://github.com/${repoName}.git`, branch };
  try {
    const pushed = await pushBranch(design, binding, cred);
    pushedBranch = true;
    record('push a new branch with the user token', pushed.created, branch);
    const tip = await fetchRemote(design, binding, cred);
    record('fetch it back', tip === saved.commit, tip?.slice(0, 8) ?? 'none');
    const clone = await cloneFromRemote(rt, join(work, 'data-b'), join(work, 'clone'), binding, cred);
    record('open from the remote', (await clone.history()).length === 1);
    await deleteRemoteBranch(design, binding, cred);
    pushedBranch = false;
    record('delete the branch', true);
  } catch (e) {
    record('git round trip with the user token', false, errText(e));
  }

  // 4. A repo the app is not installed on
  const otherBinding = { url: `https://github.com/${otherName}.git`, branch };
  try {
    await pushBranch(design, otherBinding, cred);
    record(`push to ${otherName} is refused`, false, 'the push SUCCEEDED; delete the branch by hand');
  } catch (e) {
    record(`push to ${otherName} is refused`, true, errText(e));
  }

  // 5. Refresh without a client secret
  if (refresh) {
    const r = await form('https://github.com/login/oauth/access_token', { client_id: clientId, grant_type: 'refresh_token', refresh_token: refresh });
    remember(r);
    if (typeof r['access_token'] === 'string') {
      const fresh = String(r['access_token']);
      const again = await api(fresh, '/user');
      record('refresh without a client secret', again.status === 200, `new refresh token ${r['refresh_token'] && r['refresh_token'] !== refresh ? 'rotated' : 'same or none'}`);
      const oldAccess = await api(access, '/user');
      say(`      old access token after refresh: HTTP ${oldAccess.status}`);
      const reuse = await form('https://github.com/login/oauth/access_token', { client_id: clientId, grant_type: 'refresh_token', refresh_token: refresh });
      remember(reuse);
      record('old refresh token is single-use', typeof reuse['access_token'] !== 'string', String(reuse['error'] ?? 'it worked again'));
    } else {
      record('refresh without a client secret', false, String(r['error'] ?? JSON.stringify(r)));
    }
  } else {
    say('      no refresh token: token expiration is off for this app');
  }
} catch (e) {
  record('unexpected error', false, errText(e));
} finally {
  if (pushedBranch) say(`(branch ${branch} may be left on ${repoName}; delete it by hand)`);
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
say(`\n${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed ? 1 : 0;
