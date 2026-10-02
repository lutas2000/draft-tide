import { DtError, commitIdentityFor, type AuthStatus, type GitHubUser, type LoginOutcome } from '@draft-tide/contracts';
import type { ProjectContext } from './context.ts';
import type { DeviceLogin } from './ports.ts';

// GitHub sign-in (M1 plan §10.1), only from the trusted app. The device flow
// runs in the Engine: the app asks for a code, shows it, and the Engine polls
// GitHub at the interval GitHub asks for until the user has entered it,
// declined, or the code expired. auth.changed says how it ended.

export interface AuthService {
  // forTool: the tool channel never sees the device code.
  status(forTool: boolean): Promise<AuthStatus>;
  // Starts a device login, or returns the one already waiting.
  loginStart(): Promise<AuthStatus>;
  loginCancel(): Promise<AuthStatus>;
  logout(): Promise<AuthStatus>;
  // Signed in now (signed-in, not expired): the user; else null.
  signedInUser(): Promise<GitHubUser | null>;
  // Stops a waiting login (Engine shutdown).
  stop(): void;
}

export interface AuthHooks {
  // Someone signed in: requests are answered, pushes waiting for sign-in run.
  onSignedIn(user: GitHubUser): void;
}

interface Pending {
  login: DeviceLogin;
  controller: AbortController;
}

export function createAuthService(ctx: ProjectContext, hooks: AuthHooks): AuthService {
  const remote = ctx.remote;
  let pending: Pending | null = null;

  const changed = (login: LoginOutcome | null) => ctx.publish({ name: 'auth.changed', login });

  async function status(forTool: boolean): Promise<AuthStatus> {
    if (!remote || remote.unavailable !== null) {
      return {
        state: 'unavailable',
        unavailableReason: remote?.unavailable ?? 'no-client-id',
        user: null,
        identity: await ctx.commitIdentity(),
        login: null,
        links: remote?.links ?? null,
      };
    }
    const account = await remote.account();
    const user = account.state === 'signed-out' ? null : account.user;
    const waiting = pending !== null && account.state !== 'signed-in';
    return {
      state: waiting ? 'signing-in' : account.state,
      unavailableReason: null,
      user,
      identity: commitIdentityFor(user),
      login:
        waiting && !forTool && pending
          ? {
              userCode: pending.login.userCode,
              verificationUri: pending.login.verificationUri,
              expiresAt: pending.login.expiresAt,
            }
          : null,
      links: remote.links,
    };
  }

  function finish(p: Pending, outcome: LoginOutcome): void {
    if (pending !== p) return;
    pending = null;
    remote?.forgetLogin(p.login.handle);
    changed(outcome);
  }

  // Polls until the login ends. Network trouble while polling is ridden out
  // until the code expires; anything else ends the login as failed.
  async function poll(p: Pending): Promise<void> {
    if (!remote) return;
    let interval = p.login.intervalMs;
    const expiresAt = Date.parse(p.login.expiresAt);
    for (;;) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, interval);
        p.controller.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      if (p.controller.signal.aborted) return;
      if (Date.now() >= expiresAt) {
        finish(p, 'expired');
        return;
      }
      let result;
      try {
        result = await remote.pollLogin(p.login.handle, p.controller.signal);
      } catch (e) {
        if (p.controller.signal.aborted) return;
        if (e instanceof DtError && e.code === 'NETWORK_UNAVAILABLE') continue;
        finish(p, 'failed');
        return;
      }
      if (p.controller.signal.aborted) return;
      switch (result.status) {
        case 'pending':
          interval = Math.max(interval, result.intervalMs);
          continue;
        case 'completed':
          finish(p, 'completed');
          hooks.onSignedIn(result.user);
          return;
        case 'expired':
          finish(p, 'expired');
          return;
        case 'denied':
          finish(p, 'denied');
          return;
      }
    }
  }

  function requireRemote() {
    if (!remote || remote.unavailable !== null) {
      throw new DtError('AUTH_REQUIRED', "this copy of Draft Tide can't sign in to GitHub", {
        reason: 'unavailable',
      });
    }
    return remote;
  }

  return {
    status,

    async loginStart() {
      const r = requireRemote();
      if (pending && Date.parse(pending.login.expiresAt) > Date.now()) return status(false);
      if (pending) finish(pending, 'expired');
      const login = await r.beginLogin();
      const p: Pending = { login, controller: new AbortController() };
      pending = p;
      changed(null);
      // poll ends the login itself; this only covers a bug in it.
      void poll(p).catch(() => finish(p, 'failed'));
      return status(false);
    },

    async loginCancel() {
      if (pending) {
        const p = pending;
        p.controller.abort();
        finish(p, 'cancelled');
      }
      return status(false);
    },

    async logout() {
      const r = requireRemote();
      if (pending) {
        pending.controller.abort();
        finish(pending, 'cancelled');
      }
      await r.signOut();
      changed(null);
      return status(false);
    },

    async signedInUser() {
      if (!remote || remote.unavailable !== null) return null;
      const account = await remote.account();
      return account.state === 'signed-in' ? account.user : null;
    },

    stop() {
      pending?.controller.abort();
      pending = null;
    },
  };
}
