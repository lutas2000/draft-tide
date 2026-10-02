import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AuthStatus,
  BranchName,
  CommitIdentity,
  OPERATIONS,
  OperationJournal,
  PlanRecord,
  RemoteConnectApplyInput,
  RepoRef,
  commitIdentityFor,
  normalizeIdentityName,
  parseRepoRef,
} from '../src/index.ts';

describe('GitHub names', () => {
  it('reads owner/name or a github.com address, nothing else', () => {
    expect(parseRepoRef('designer/site')).toEqual({ owner: 'designer', name: 'site' });
    expect(parseRepoRef(' https://github.com/designer/site.git ')).toEqual({ owner: 'designer', name: 'site' });
    expect(parseRepoRef('https://github.com/designer/site/')).toEqual({ owner: 'designer', name: 'site' });
    for (const bad of [
      'https://gitlab.com/designer/site',
      'http://github.com/designer/site',
      'https://github.com.evil.example/designer/site',
      'git@github.com:designer/site.git',
      'designer/site/extra',
      'designer/..',
      '../site',
      '-flag/site',
      'designer/site.git',
      '',
    ]) {
      expect(parseRepoRef(bad), bad).toBeNull();
    }
  });

  it('takes only branch names that are safe in a refspec as they are', () => {
    for (const ok of ['main', 'design/v2', 'release-1.0', 'a_b'])
      expect(BranchName.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['', '-x', 'a..b', 'a//b', 'a/', 'a.', 'x.lock', 'a b', 'a:b', '+main', 'é', 'a~1', 'a^']) {
      expect(BranchName.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('commit identity of a GitHub user', () => {
  it('uses the display name with the noreply address, never a private email', () => {
    expect(commitIdentityFor({ id: 42, login: 'dee', name: 'Dee Signer' })).toEqual({
      name: 'Dee Signer',
      email: '42+dee@users.noreply.github.com',
    });
    expect(commitIdentityFor(null)).toEqual({ name: 'Draft Tide', email: 'draft-tide@localhost' });
  });

  it('normalizes what Git would rewrite, and falls back to the login', () => {
    expect(normalizeIdentityName('  "Dee <dee@x>"  ')).toBe('Dee dee@x');
    expect(normalizeIdentityName('Dee\nSigner')).toBe('DeeSigner');
    expect(normalizeIdentityName('...;')).toBeNull();
    expect(normalizeIdentityName(null)).toBeNull();
    expect(normalizeIdentityName('‮evil')).toBe('evil');
    expect(commitIdentityFor({ id: 1, login: 'dee', name: '<>' }).name).toBe('dee');
    expect(commitIdentityFor({ id: 1, login: 'dee', name: null }).name).toBe('dee');
  });

  it('always yields an identity Git records exactly (property)', () => {
    fc.assert(
      fc.property(
        fc.option(fc.string({ maxLength: 300, unit: 'grapheme' }), { nil: null }),
        fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
        fc.integer({ min: 1, max: 2 ** 31 }),
        (name, login, id) => {
          expect(CommitIdentity.safeParse(commitIdentityFor({ id, login, name })).success).toBe(true);
        },
      ),
    );
  });
});

describe('sync in the catalog', () => {
  it('keeps sign-in and connecting a repository in the app; the tool channel can only ask', () => {
    for (const op of [
      'auth.loginStart',
      'auth.loginCancel',
      'auth.logout',
      'remote.repos',
      'remote.connectPlan',
      'remote.connectApply',
      'remote.disconnect',
    ] as const) {
      expect(OPERATIONS[op].tool, op).toBe('none');
      expect(OPERATIONS[op].desktop, op).toBe(true);
    }
    for (const op of ['auth.loginRequest', 'remote.connectRequest'] as const) {
      expect(OPERATIONS[op].desktop, op).toBe(false);
      expect(OPERATIONS[op].tool, op).toBe('agent-access');
    }
    for (const op of [
      'auth.status',
      'remote.status',
      'sync.push',
      'sync.pullPlan',
      'sync.pullApply',
      'remote.openPlan',
      'remote.openApply',
    ] as const) {
      expect(OPERATIONS[op].tool, op).toBe('agent-access');
    }
  });

  it('refuses self-asserted flags and anything but owner and name', () => {
    expect(RepoRef.safeParse({ owner: 'a', name: 'b', id: 1 }).success).toBe(false);
    expect(
      RemoteConnectApplyInput.safeParse({
        projectId: '00000000-0000-4000-8000-000000000000',
        planId: '00000000-0000-4000-8000-000000000001',
        setOrigin: true,
        confirmed: true,
      }).success,
    ).toBe(false);
  });

  it('never carries a token in what crosses the boundary', () => {
    const status = AuthStatus.safeParse({
      state: 'signed-in',
      unavailableReason: null,
      user: { id: 1, login: 'dee', name: null },
      identity: { name: 'dee', email: '1+dee@users.noreply.github.com' },
      login: null,
      links: null,
      token: 'ghu_x',
    });
    expect(status.success).toBe(false);
  });

  it('reads back pull and open journals and plans strictly', () => {
    const commit = 'a'.repeat(40);
    expect(
      OperationJournal.safeParse({
        kind: 'pull',
        planId: 'p',
        ref: 'refs/heads/main',
        remote: { owner: 'dee', name: 'site' },
        base: { commit, snapshotId: null },
        target: { commit, snapshotId: null },
        targetTree: commit,
        publish: null,
        reason: null,
        conflicts: { count: 0, sample: [] },
        error: null,
      }).success,
    ).toBe(true);
    expect(
      PlanRecord.safeParse({
        kind: 'open',
        repo: { id: 1, owner: 'dee', name: 'site', visibility: 'private', defaultBranch: 'main', htmlUrl: 'x' },
        branch: 'main',
        tip: commit,
        destination: '/tmp/x',
        existed: false,
        extra: 1,
      }).success,
    ).toBe(false);
  });
});
