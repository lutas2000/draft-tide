import { z } from 'zod';
import { ErrorCodeSchema } from './errors.ts';
import { GitObjectId } from './history.ts';
import { IsoTimestamp, ProjectId } from './ids.ts';
import { CommitIdentity, DRAFT_TIDE_IDENTITY } from './snapshot.ts';

// GitHub sign-in and remote sync (M1 plan §10). Saving never waits for any of
// this: pushing and pulling are separate operations, and everything local
// works signed out or offline. The token never crosses the process boundary:
// nothing here carries it, and no operation returns it.

const Count = z.number().int().nonnegative();

// Development builds only (release builds ignore it): JSON
// {"web": "...", "api": "...", "git": "..."}, each an http URL on loopback,
// where a fake GitHub serves the device flow, the API and smart-HTTP Git.
// Tests and the desktop E2E use it; launchers forward it in development.
export const TEST_GITHUB_ENV = 'DRAFT_TIDE_TEST_GITHUB';

// ---- GitHub names

// A user or organization login.
export const GitHubLogin = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/, 'must be a GitHub account name');
export type GitHubLogin = z.infer<typeof GitHubLogin>;

// A repository name as GitHub spells it (never with a `.git` suffix).
export const GitHubRepoName = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/, 'must be a GitHub repository name')
  .refine((n) => n !== '.' && n !== '..' && !n.toLowerCase().endsWith('.git'), 'must be a GitHub repository name');
export type GitHubRepoName = z.infer<typeof GitHubRepoName>;

export const RepoRef = z.strictObject({ owner: GitHubLogin, name: GitHubRepoName });
export type RepoRef = z.infer<typeof RepoRef>;

// `owner/name`, or the repository's address on github.com (with or without
// `.git`). Nothing else: the token only ever goes to github.com.
export function parseRepoRef(text: string): RepoRef | null {
  const trimmed = text.trim();
  const url = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  const short = /^([^/\s]+)\/([^/\s]+)$/.exec(trimmed);
  const m = url ?? short;
  if (!m) return null;
  const parsed = RepoRef.safeParse({ owner: m[1], name: m[2] });
  return parsed.success ? parsed.data : null;
}

// The branch a project syncs. Only names that are safe in a refspec as they
// are; a project on any other branch can't be connected (INVALID_ARGUMENT,
// branch-name).
export const BranchName = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'must be a plain branch name')
  .refine(
    (b) => !b.includes('..') && !b.includes('//') && !b.endsWith('/') && !b.endsWith('.') && !b.endsWith('.lock'),
    'must be a plain branch name',
  );
export type BranchName = z.infer<typeof BranchName>;

// ---- Sign-in (M1 plan §10.1): a GitHub App's device flow

export const GitHubUser = z.strictObject({
  id: z.number().int().positive(),
  login: GitHubLogin,
  // The display name on GitHub, made printable; null when the user set none.
  name: z.string().max(255).nullable(),
});
export type GitHubUser = z.infer<typeof GitHubUser>;

// The commit identity of a signed-in user (M1 plan §6.1): their display name
// with GitHub's noreply address, never a private email. Git would silently
// rewrite a name with `<`, `>`, line breaks or leading and trailing
// punctuation, and CommitIdentity refuses such names, so the display name is
// normalized first: control and bidirectional characters, `<` and `>` go,
// runs of spaces become one, Git's trimmed characters go from both ends. The
// login stands in when nothing is left (or no name was set).
const IDENT_TRIM = /^[\s.,:;"'\\]+|[\s.,:;"'\\]+$/gu;
// eslint-disable-next-line no-control-regex
const IDENT_DROP = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069<>]/gu;

export function normalizeIdentityName(name: string | null): string | null {
  if (name === null) return null;
  let out = name.replace(IDENT_DROP, '').replace(/\s+/gu, ' ').replace(IDENT_TRIM, '');
  if ([...out].length > 200) out = [...out].slice(0, 200).join('').replace(IDENT_TRIM, '');
  return CommitIdentity.shape.name.safeParse(out).success ? out : null;
}

export function commitIdentityFor(user: GitHubUser | null): CommitIdentity {
  if (user === null) return DRAFT_TIDE_IDENTITY;
  return {
    name: normalizeIdentityName(user.name) ?? user.login,
    email: `${user.id}+${user.login}@users.noreply.github.com`,
  };
}

//   unavailable  this build or computer can't sign in (see unavailableReason)
//   signed-out   not signed in (or signed out)
//   signing-in   a device code is waiting for the user on github.com
//   signed-in    signed in; the token is in the keychain
//   expired      the sign-in no longer works (expired or revoked): sign in
//                again. New versions still carry this user's identity.
export const AUTH_STATES = ['unavailable', 'signed-out', 'signing-in', 'signed-in', 'expired'] as const;
export const AuthState = z.enum(AUTH_STATES);
export type AuthState = z.infer<typeof AuthState>;

//   no-client-id  the build has no GitHub App (release builds before M1-09)
//   no-keychain   there is no keychain Draft Tide can keep the token in here
export const AUTH_UNAVAILABLE_REASONS = ['no-client-id', 'no-keychain'] as const;

// Where the user goes on github.com. All fixed by the build.
export const GitHubLinks = z.strictObject({
  // Create a repository (the user creates the empty repo themselves, M1).
  newRepo: z.string().max(200),
  // Install Draft Tide's GitHub App on a repository.
  installApp: z.string().max(200),
  // Where a signed-in user revokes Draft Tide's access.
  authorizedApps: z.string().max(200),
});
export type GitHubLinks = z.infer<typeof GitHubLinks>;

export const AuthStatus = z.strictObject({
  state: AuthState,
  unavailableReason: z.enum(AUTH_UNAVAILABLE_REASONS).nullable(),
  // signed-in or expired.
  user: GitHubUser.nullable(),
  // The author and committer of new versions.
  identity: CommitIdentity,
  // While signing in, for the app only (the tool channel gets null): the code
  // the user types at verificationUri.
  login: z
    .strictObject({
      userCode: z.string().regex(/^[A-Z0-9-]{4,16}$/),
      verificationUri: z.string().max(200),
      expiresAt: IsoTimestamp,
    })
    .nullable(),
  links: GitHubLinks.nullable(),
});
export type AuthStatus = z.infer<typeof AuthStatus>;

// How a device login ended (event auth.changed).
//   completed  signed in
//   expired    the code expired before the user entered it
//   denied     the user declined on github.com
//   cancelled  the app cancelled it
//   failed     GitHub or the network failed (see the status's state)
export const LOGIN_OUTCOMES = ['completed', 'expired', 'denied', 'cancelled', 'failed'] as const;
export const LoginOutcome = z.enum(LOGIN_OUTCOMES);
export type LoginOutcome = z.infer<typeof LoginOutcome>;

// ---- Repositories the user can connect

export const REPO_VISIBILITIES = ['private', 'public', 'internal'] as const;
export const RepoVisibility = z.enum(REPO_VISIBILITIES);
export type RepoVisibility = z.infer<typeof RepoVisibility>;

export const GitHubRepo = z.strictObject({
  id: z.number().int().positive(),
  owner: GitHubLogin,
  name: GitHubRepoName,
  visibility: RepoVisibility,
  // GitHub's default branch setting (an empty repository has one too).
  defaultBranch: BranchName.nullable(),
  // https://github.com/<owner>/<name>
  htmlUrl: z.string().max(300),
});
export type GitHubRepo = z.infer<typeof GitHubRepo>;

// Repositories Draft Tide's GitHub App is installed on and the user can
// reach, from every installation (M1 plan §10.2).
export const RemoteRepoList = z.strictObject({
  repos: z.array(GitHubRepo).max(1000),
  installations: Count,
  // More than fit: the rest are not listed.
  truncated: z.boolean(),
});
export type RemoteRepoList = z.infer<typeof RemoteRepoList>;

// ---- A project's remote (M1 plan §10.2)

export const RemoteBinding = z.strictObject({
  provider: z.literal('github'),
  repoId: z.number().int().positive(),
  owner: GitHubLogin,
  name: GitHubRepoName,
  visibility: RepoVisibility,
  // The project's branch; the remote branch has the same name.
  branch: BranchName,
  connectedAt: IsoTimestamp,
});
export type RemoteBinding = z.infer<typeof RemoteBinding>;

//   not-connected  the project has no remote
//   synced         the remote holds exactly the newest commit
//   pending        versions wait to be pushed (ahead says how many)
//   pushing        a push is running
//   behind         the remote has versions the folder doesn't (取得更新)
//   diverged       both sides have new versions; nothing changes on either
//   needs-sign-in  signed out, or the sign-in expired
//   rejected       GitHub refused (lastError says why)
//   offline        the last attempt couldn't reach GitHub; it is retried
export const SYNC_STATES = [
  'not-connected',
  'synced',
  'pending',
  'pushing',
  'behind',
  'diverged',
  'needs-sign-in',
  'rejected',
  'offline',
] as const;
export const SyncState = z.enum(SYNC_STATES);
export type SyncState = z.infer<typeof SyncState>;

export const SyncError = z.strictObject({
  code: ErrorCodeSchema,
  reason: z.string().max(64).nullable(),
  message: z.string().max(1000),
  at: IsoTimestamp,
});
export type SyncError = z.infer<typeof SyncError>;

export const SyncStatus = z.strictObject({
  projectId: ProjectId,
  remote: RemoteBinding.nullable(),
  state: SyncState,
  // The branch's newest commit here, and on the remote as last seen.
  localTip: GitObjectId.nullable(),
  remoteTip: GitObjectId.nullable(),
  // Commits here the remote doesn't have, and the other way round, as of the
  // last check; null when unknown.
  ahead: Count.nullable(),
  behind: Count.nullable(),
  lastPushAt: IsoTimestamp.nullable(),
  lastCheckAt: IsoTimestamp.nullable(),
  // The last failure, until something succeeds.
  lastError: SyncError.nullable(),
  // When a waiting push is tried again.
  nextAttemptAt: IsoTimestamp.nullable(),
});
export type SyncStatus = z.infer<typeof SyncStatus>;

export const RemoteStatusInput = z.strictObject({
  projectId: ProjectId,
  // Ask GitHub now (fetch) instead of reporting the last check.
  refresh: z.boolean().optional(),
});

// ---- Stable reasons (details.reason), defined once for GUI copy.

// AUTH_REQUIRED
//   signed-out   nobody is signed in
//   expired      the sign-in expired or was revoked on GitHub
//   unavailable  this build or computer can't sign in
export const AUTH_REQUIRED_REASONS = ['signed-out', 'expired', 'unavailable'] as const;

// REMOTE_REJECTED
//   app-not-installed  Draft Tide's GitHub App isn't installed on the repo
//                      (any more)
//   not-found          no such repository, or no access to it
//   no-push-access     the app or the user may read but not push
//   protected-branch   a branch rule refused the push
//   file-too-large     a file is over GitHub's 100 MiB limit
//   empty-repository   there is nothing to open in it
//   rejected           GitHub refused for another reason (see the message)
export const REMOTE_REJECTED_REASONS = [
  'app-not-installed',
  'not-found',
  'no-push-access',
  'protected-branch',
  'file-too-large',
  'empty-repository',
  'rejected',
] as const;

// REMOTE_DIVERGED
export const REMOTE_DIVERGED_REASONS = ['diverged', 'unrelated-history'] as const;

// NETWORK_UNAVAILABLE (retryable)
//   unreachable   no connection to GitHub
//   timeout       GitHub didn't answer in time
//   tls           the connection's certificate didn't check out
//   rate-limited  GitHub asked to wait
//   server-error  GitHub failed (5xx)
export const NETWORK_UNAVAILABLE_REASONS = ['unreachable', 'timeout', 'tls', 'rate-limited', 'server-error'] as const;
