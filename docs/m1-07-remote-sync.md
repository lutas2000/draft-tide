# M1-07: remote sync

Date: 2026-10-03 · Machine: macOS 27.0.1, Apple Silicon (arm64), Node 24.18.1, Electron 44.5.1, Apple Git 2.54.0 · Work package: M1-07 ([M1 plan §12](../.ref/M1_IMPLEMENTATION_PLAN.md))

M1-07 gives every project an off-site copy on GitHub, on the designer's terms:
- **Sign-in.** The designer signs in with GitHub's device flow in the app (a code to type on github.com, with a copy button), or skips it. Signed out or offline, everything local works and saving never waits.
- **Connecting.** The app guides them to create an empty repository and install Draft Tide's GitHub App on it. It then lists the repositories the app is installed on, reviews what the first push sends (versions, files, size, the largest files, files over GitHub's limits, names and contents that look like secrets, the repository's visibility), and connects.
- **Pushing.** After that, every save is pushed in the background. The project page shows the sync state: 已同步, 等待推送, 推送中…, GitHub 有新版本, 兩邊都有新版本, 需要登入, 被 GitHub 拒絕, 離線.
- **Getting updates.** This is a plan the designer confirms. It only fast-forwards, and refuses with unsaved changes.
- **Other folders.** A project opens from GitHub into an empty folder with its whole history, on another computer or after a lost folder.
- **Divergence.** When both sides have new versions, nothing changes on either side.
- **Agents.** With agent access on, the CLI and MCP check the sync state, push, pull, and open from GitHub. They can only ask the user to sign in or to connect a repository, and they never see a token.

M1-07 depends on M1-00 (done 2026-10-03: real GitHub round trip, GitHub App sign-in, bundled Git, token custody) and M1-05 (done).

## What was built

| Module | Contents |
|---|---|
| `packages/contracts` | `remote.ts`:<br>• **GitHub names:** `GitHubLogin`, `GitHubRepoName`, `RepoRef`, `parseRepoRef` (owner/name or a github.com address only), `BranchName`<br>• **Sign-in:** `AuthStatus`, `AuthState`, `LoginOutcome`, `GitHubUser`, `GitHubLinks`, `commitIdentityFor` / `normalizeIdentityName`<br>• **Repositories and sync:** `GitHubRepo`, `RemoteRepoList`, `RemoteBinding`, `SyncState`, `SyncStatus`, `SyncError`<br>• **Constants:** `TEST_GITHUB_ENV`, and the stable reasons of `AUTH_REQUIRED`, `REMOTE_REJECTED`, `REMOTE_DIVERGED`, `NETWORK_UNAVAILABLE`<br>`sync.ts`: the connect plan and result with `PushReview`, `PushResult`, the pull plan and result, the open plan and result, `SyncProgress`.<br>Journal kinds `pull`, `open`, `login-request`, `remote-connect-request`; plan records `remote-connect`, `pull`, `open`; activities `pulling`, `opening`. Events `auth.changed`, `remote.changed`. Fifteen catalog operations (below). No new error codes |
| `packages/remote-github` (new) | The GitHub App client:<br>• **Sign-in:** the device flow and token refresh: one at a time, never cancelled, the new grant written to the vault before the new access token is used<br>• **API:** `/user`, the installations and their repositories, `/repos/{owner}/{name}`<br>• **Host allowlist:** checked on the parsed URL before every request; redirects never followed; responses bounded; failures mapped to stable codes<br>• **The grant format** (`StoredGrant`), the `TokenVault` port and a memory vault |
| `packages/git-backend` | `network.ts`:<br>• **Ephemeral git dir:** fetch, push and ls-remote run in it, with `GIT_OBJECT_DIRECTORY` borrowing the project's objects, `GIT_ALLOW_PROTOCOL=https`, credentials through a 0600 askpass file, no credential helper or redirects<br>• **Outcomes:** push read from `--porcelain`, transport failures from Git's stderr<br>• **Leftovers:** a sweep of dirs a killed Engine left<br>In the repo: `GitRemote` (`remoteHeads`, `fetchBranch`, `pushBranch`, `trackingTip`, `objectsToPush`, `commitsBetween`, `mergeBase`, `readOrigin`, `setOrigin`). `init` takes a branch. `detectExecPath` sets `GIT_EXEC_PATH` for a Git that can't find `git-remote-https` |
| `packages/adapter-filesystem` | `destination.ts`: a destination for opening from GitHub (absent with an existing parent, or empty; `.DS_Store` ignored), creating it, and undoing a fresh repo |
| `packages/local-store` | Migration 4: `remote_bindings`, `sync_queue`. The plans table is rebuilt so a plan may have no project. Plus the store's own id, which names its keychain item |
| `packages/core` | `auth.ts`: status, the device-login poll loop, sign-out.<br>`sync.ts`: status, the connect plan and apply, the first-push review, pushes, the background queue.<br>`pull.ts`: the pull plan and apply, and `recordFastForward`.<br>`open.ts`: the open plan and apply.<br>Recovery extended to pulls (finish while the branch is at the base, or rollback) and opens (finish). Requests: login and remote-connect. The commit identity follows the account. Ports: `RemoteProvider`, `GitRemote`, the new host and store methods |
| `apps/companion` | `native/keychain.c`: an in-process `SecItem*` addon whose reads and updates never show UI. `engine/github.ts`: the keychain vault and the provider (dev app compiled into development builds; test GitHub in development only). The Engine sweeps network dirs at start and stays up while a push is due. CLI: `auth status`, `auth login request`, `remote status [--refresh]`, `remote connect request`, `remote open plan/apply`, `sync push`, `sync pull plan/apply`. The MCP instructions cover sync |
| `apps/desktop` | **Main:** `openExternal` (only `https://github.com/` pages), `copyText` (the sign-in code), and the picked-folder rule for opening from GitHub.<br>**GUI:**<br>• 帳號與同步: sign-in with the device code, sign-out (with where to revoke), every project's sync state<br>• The project page's GitHub 同步 card: state, 立即推送, 取得更新…, 檢查 GitHub, 在 GitHub 查看, 停止同步<br>• The connect wizard: create the repo, install the app, pick it, the first-push review<br>• The pull dialog<br>• 從 GitHub 開啟 on the home screen<br>• Banners and settings rows for the new requests, notices for agents' pulls<br>• The recovery card names pulls and opens; copy for the new codes and reasons |
| `fixtures/fake-github.ts` (new) | A fake GitHub on loopback for tests and the E2E: the device flow (approve, deny, expire), token rotation, revocation, installations, the API, and smart-HTTP Git through `git http-backend` with Basic auth. Pre-receive refusals with GitHub's wording. Every request and token is recorded |

### Operations added to the catalog

| Operation | Desktop | Tool channel (CLI, MCP) | Effect |
|---|---|---|---|
| `auth.status` | yes | with agent access (never the device code) | read |
| `auth.loginStart`, `auth.loginCancel`, `auth.logout` | yes | not offered | write |
| `auth.loginRequest` | no | with agent access (`CONFIRMATION_REQUIRED`) | write |
| `remote.repos` | yes | not offered | read |
| `remote.status` | yes | with agent access | read |
| `remote.connectPlan` | yes | not offered | read |
| `remote.connectApply` | yes | not offered | write |
| `remote.connectRequest` | no | with agent access (`CONFIRMATION_REQUIRED`) | write |
| `remote.disconnect` | yes | not offered | write |
| `sync.push` | yes | with agent access | write |
| `sync.pullPlan` | yes | with agent access | read |
| `sync.pullApply` | yes | with agent access | destructive |
| `remote.openPlan` | yes | with agent access | read |
| `remote.openApply` | yes | with agent access | write |

Events:
- `auth.changed` (with how a device login ended) and `remote.changed`.
- `operation.progress` and `operation.settled` also for `remote.connectApply`, `sync.push`, `sync.pullApply` and `remote.openApply`.
- `project.changed` adds `pulled`.

## How it works

1. **Signing in** (app only). `auth.loginStart` asks GitHub for a device code with the public client ID only. The app shows the code with a copy button and a button that opens the verification page. The Engine polls at the interval GitHub asks for (`slow_down` raises it), riding out network trouble until the code expires. On success it reads `/user`, writes the grant to the vault (the user's login, name, id, the access token, the refresh token, their expiry) and sends `auth.changed`. Waiting login requests from agents are answered, and pushes waiting for a sign-in run.
2. **Connecting** (app only).
   - **The plan.** The repository must be among the app's installations, and the user's own role must allow pushing (else `REMOTE_REJECTED`, `app-not-installed` or `no-push-access`). Its branches are listed. The relation is:
     - `empty`: nothing there;
     - `unrelated`: a history the folder doesn't share, such as a README GitHub created; this is `REMOTE_DIVERGED` (`unrelated-history`);
     - otherwise the project's branch is fetched and classified as `same`, `ahead`, `behind` or `diverged`.
   - **The review.** It lists what a push sends.
   - **Blockers.** The plan is blocked by divergence, by an empty project, or by a file over 100 MiB.
   - **The apply.** It checks the repository, the branch tip and the remote tip again (`PLAN_STALE`), records the binding, optionally sets `remote.origin`, then makes the first push. A failed first push leaves the project connected, with the failure in its status and a retry queued where one helps.
3. **Pushing.** A save, a restore (even one that stopped after its protection version) and a recovery queue a push of a connected project. The queue runs in the Engine:
   - **Under the sync guard,** never the write guard, so a slow push never holds up a save.
   - **Fast-forward only.** It fetches, refuses anything but a fast-forward (`REMOTE_DIVERGED`), pushes the branch tip without `+` or force, and records what GitHub has.
   - **Retries.** `NETWORK_UNAVAILABLE` is retried after 5 s, 15 s, 30 s, 1, 2, 5 and 10 minutes. `AUTH_REQUIRED` waits for a sign-in. `REMOTE_DIVERGED` and `REMOTE_REJECTED` wait for the user.
   - **A token Git refuses** (revoked, or rotated by a refresh elsewhere) is refreshed once, if it is still the current one, and the operation runs again; a refresh that fails marks the sign-in expired.
   - **The Engine stays up** while a push is due within two minutes. Later ones run at the next start.
4. **Getting updates** (plan → apply; the tool channel with agent access too).
   - **The plan** fetches and classifies. Only `behind` applies; `equal`, `ahead` and `no-remote-branch` are no-ops, and `diverged` refuses.
   - **Reasons applying would refuse**, in the order apply checks them: a decision pending in recovery, unsaved changes (`UNSAVED_CHANGES`), a remote version that can't be written back, remote settings that don't name this project (`CONFIG_INVALID`, `remote-settings`), files in the way, disk space.
   - **The apply** runs under the write guard, like a restore: it captures the folder, refuses unsaved changes, recomputes the fingerprint, journals the file changes, writes them one at a time, reads them back, then moves the branch to the remote commit lock-first. It creates no new commit.
5. **Opening from GitHub** (plan → apply; the tool channel with agent access too).
   - **Only the user's own repositories.** The repository must be one the app is installed on (`REMOTE_REJECTED`, `app-not-installed` otherwise), even when it is public.
   - **The destination** must not exist (its parent must) or must be empty, and must not be inside a connected project (checked again by the apply). Hidden folders anywhere on the path and, on macOS, `~/Library` are refused (`INVALID_ARGUMENT`, `destination-not-allowed`).
   - **Before the first file** the apply initializes the repository on the remote's branch, fetches, and checks that the newest version's `.drafttide.json` parses. A project already connected to a folder that still holds it refuses (`PROJECT_ALREADY_BOUND`). The apply then connects the project and its remote, and journals an `open`. A failure here undoes everything: the new `.git`, the folder if the open created it, the bindings.
   - **Disk space** for every file is checked before anything is connected.
   - **Then** it writes every file expecting nothing there, reads them back, creates the branch lock-first, and sets `remote.origin`. A failure on the first file is still undone; an Engine that stops before the first file has its open undone the same way at the next start.
6. **Recovery.** A pull or open that stopped after its first file shows on the project's recovery card.
   - **A pull** finishes (while the branch is still at the base) or rolls back.
   - **An open** only finishes: its folder was empty, so there is nothing to put back.

## Decisions taken here

- **Core never holds a token.** `RemoteProvider` (remote-github) owns sign-in and the vault. A Git network operation gets a `GitAccess` whose credential only git-backend reveals, into the operation's 0600 askpass file. The repository's address is built from owner and name by the provider, never taken from a binding as a URL. Owner and name are validated by the contracts' patterns when SQLite is read back.
- **One keychain item per data store.** Service `dev.drafttide.github` (`app.drafttide.github` in release builds), account = the store's id from SQLite, holding the whole grant with the user's profile. Two data stores never share a refresh token (every refresh voids the old one). An item this program isn't trusted for is replaced on the next write.
- **Development builds.**
  - **macOS** uses the same keychain addon. The item then trusts the development Node, so any script on that Node could read it; the SEA closes this in release (M1-09).
  - **Elsewhere, and with the test GitHub,** a memory vault keeps the sign-in only as long as the Engine.
  - **Test GitHub.** `DRAFT_TIDE_TEST_GITHUB` (loopback http only) points the Engine at a fake GitHub. Launchers forward it in development builds; release builds ignore it.
- **The development GitHub App is compiled into development builds** (`draft-tide-dev-lutas2000`, client ID `Iv23lisc6TyzrEU07Wt4`). Release builds take `DT_GITHUB_CLIENT_ID` and `DT_GITHUB_APP_SLUG` at build time; without them sign-in is `unavailable` (`no-client-id`).
- **Refresh is never cancelled.** Once GitHub has rotated the tokens, dropping its answer would lose the only valid refresh token. A forced refresh after a 401 happens only if the refused token is still the current one, so two parallel calls never rotate twice.
- **The repository list is always fresh.** The user has just created a repository or installed the app; a cached list hid it (found by the E2E). The push-access check reuses a list up to 30 s old and asks again before refusing.
- **The bound branch is synced, not HEAD.** Pushes push the branch recorded at connect time. Pulling needs HEAD on it (`INVALID_ARGUMENT`, `branch-changed`). Branch names outside `[A-Za-z0-9._/-]` can't be connected (`branch-name`).
- **Pushes never take the write guard.** They write only objects and `refs/remotes/draft-tide/<branch>`. Push progress never makes the project look busy to the save button.
- **A push that a save overtook pushes again.** After a push, the queue keeps the project queued if the branch has moved on.
- **The first-push review lists what is sent.** It covers every object the remote lacks (`rev-list --objects` against the remote's tip), not only the newest version:
  - **Sizes and limits:** commits, Draft Tide versions, distinct file contents and their size, the ten largest, those over 100 MiB (blocking: GitHub would refuse) and over 50 MiB.
  - **Names that look like secrets:** `.env*`, key files, `id_*`, credential files, `.npmrc`/`.netrc`.
  - **Contents that look like secrets** (files up to 1 MiB, 64 MiB in all, images and fonts skipped): private keys, GitHub, AWS, Slack, OpenAI/Anthropic and Google keys.
  - **Its limits:** it is a help and says when the content scan stopped at its budget.
- **`remote.origin` is opt-in at connect time** (checked by default when there is none, or it already names the repository). Opening from GitHub always sets it.
- **Network hardening beyond the spike.** No credential helper, `core.askPass=`, `http.followRedirects=false` (a redirect must never carry the token elsewhere), `http.sslVerify=true`, and a stalled transfer aborts (under 1 KiB/s for a minute) instead of a total timeout. Ref-level outcomes come from `push --porcelain` without `--quiet`, which would drop the very lines read.
- **Errors keep their codes.** Reasons added:
  - `AUTH_REQUIRED`: `signed-out`, `expired`, `unavailable`.
  - `REMOTE_REJECTED`: `app-not-installed`, `no-push-access`, `protected-branch`, `file-too-large`, `empty-repository`, `rejected`.
  - `REMOTE_DIVERGED`: `diverged`, `unrelated-history`.
  - `NETWORK_UNAVAILABLE`: `unreachable`, `timeout`, `tls`, `rate-limited`, `server-error`.
  - `UNTRACKED_FILES`: `destination-not-empty`.
  - `CONFIG_INVALID`: `remote-settings`.
  - `INVALID_ARGUMENT`: `not-connected`, `branch-changed`, `branch-name`, `already-signed-in`.
- **Opening writes only the user's own synced repositories, never into config folders** (found in review). An agent with agent access may open from GitHub; without these limits, a prompt-injected agent could have opened any public repository into an empty `~/.ssh` or `~/Library/LaunchAgents`. So the repository must be one the app is installed on, hidden folders and `~/Library` are refused, and an agent's open shows as a notice in the app like its restores and pulls.
- **Signing out wins over a running refresh** (found in review). A sign-in epoch is bumped by signing out and by a new sign-in; a refresh or expiry that began under another epoch writes nothing. The refresh request gets 120 s, not the API's 20 s: a late answer still carries the only valid refresh token.
- **The keychain item is replaced only when this program isn't trusted for it** (`errSecAuthFailed` and kin), never on a locked keychain; adding an item runs with user interaction off too (found in review).
- **The tracking ref follows the repository.** It is cleared when a fetch finds no such branch, when another repository is connected and on disconnect, so a new empty repository is never taken for synced (found in review).
- **Login requests are refused while signed in** (`INVALID_ARGUMENT`, `already-signed-in`): asking the user to do what is done would only confuse them.

## How to run

```bash
corepack pnpm run check                                                    # everything
corepack pnpm exec vitest run packages/remote-github                         # sign-in, refresh, allowlist, repositories
corepack pnpm exec vitest run packages/git-backend/test/network.test.ts      # push, fetch, hostile config, token hygiene
corepack pnpm exec vitest run apps/companion/test/sync.test.ts               # two computers, in-process
corepack pnpm exec vitest run apps/companion/test/sync-engine.test.ts        # two Engines and the CLI
corepack pnpm --filter @draft-tide/desktop run test:e2e                     # the app against the fake GitHub
corepack pnpm run desktop                                                  # try it with the real development app
```

With agent access on (設定與診斷):

```bash
node apps/companion/dist/cli.mjs auth status
node apps/companion/dist/cli.mjs --project <id> remote status --refresh
node apps/companion/dist/cli.mjs --project <id> sync push
node apps/companion/dist/cli.mjs --project <id> sync pull plan
node apps/companion/dist/cli.mjs --project <id> sync pull apply <plan-id>
node apps/companion/dist/cli.mjs remote open plan --url designer/site --destination ~/Designs/site
node apps/companion/dist/cli.mjs remote open apply <plan-id>
```

## Results (this machine)

`corepack pnpm run check`: format, lint, typecheck and build clean; **548 passed, 3 skipped** (the same Linux-only skips). M1-06 had 495. Desktop E2E: **32/32** (5 new).

An independent review of the change found nine problems before it was committed; all are fixed and covered: the open's reach (installed repositories only, refused destinations, the nested-project check in apply, undo before the first file, a space check, notices), sign-out racing a refresh, the refresh timeout, a stale tracking ref after reconnecting, a queued push that could be dropped, a token Git refused, and the keychain replacement.

| Suite | Tests | What they show |
|---|---|---|
| Contracts | 9 new | **Names:** only owner/name or github.com addresses; only refspec-safe branch names.<br>**Identity:** the display name with the noreply address, normalized, with the login as fallback; any GitHub user yields an identity Git records exactly (property).<br>**Catalog:** sign-in and connecting stay in the app; the tool channel can only ask. Inputs are strict, no status carries a token, journals and plans are read back strictly |
| remote-github | 16 new | **Allowlist:** only the endpoints, compared on the parsed URL (look-alike hosts, userinfo, other schemes refused); a request outside them is refused before anything is sent; the test GitHub only on loopback http.<br>**Sign-in:** the device flow with the client ID only (no secret), and the grant in the vault; denied and expired logins; an unreadable or refusing vault reads as signed out; unavailable without a client ID or vault.<br>**Refresh:** once for concurrent callers, the vault written before the new token is used; a 401 retried once.<br>**Revocation:** keeps the user and drops the tokens.<br>**Signing out during a refresh:** nothing is written back, the user stays signed out.<br>**A token Git refused:** refreshed once if still current, not again once replaced.<br>**Repositories:** the installations' repositories; pushing and opening need the app installed, even on a public repository |
| git-backend | 11 new | **Push and fetch:** into an empty repository, then into another clone; the same commit again is up to date.<br>**Refusals:** a non-fast-forward is `REMOTE_DIVERGED` with GitHub unchanged; GitHub's protected-branch and large-file refusals; a bad token, a missing app and an unreachable host told apart; only plain https (or loopback http for tests).<br>**Hostile repo config:** `url.*.insteadOf`, `http.proxy`, `http.extraHeader`, `credential.helper`, `core.sshCommand` in the repo's config are ignored while a control (the user's own Git with that config) goes to the trap.<br>**Push contents:** objects listed with paths and sizes; merge bases tell diverged from unrelated.<br>**`remote.origin`:** set and read from the config file only.<br>**Leftovers:** ephemeral dirs removed even when the operation throws, and swept at start.<br>**Token hygiene:** not in argv, `.git`, or the tmp dir.<br>**Classification:** Git's porcelain and stderr read into stable codes |
| Local store | 4 new | **Bindings:** a binding and what was seen of the remote across reopen; connecting another repository starts over.<br>**The queue:** one push per project, deferred, forgotten with the binding.<br>**Strictness:** an unreadable binding refused (state, not cache).<br>**Migration 4:** plans survive it and may have no project |
| Companion: sync, in-process (real Git, SQLite, fake GitHub) | 10 new | **Sign-in:** through the device flow; new versions carry the user; a login request is answered; the tool channel never sees the code; sign-out goes back to Draft Tide's identity.<br>**Connecting:** the first push into an empty repository with the review (a token-looking string found); the origin set; a background push after a save; an engineer's plain clone has the whole history and a clean folder.<br>**Refusals:** a repository with its own README refused with nothing changed; the app uninstalled (refused, then pushed after reinstalling); signed out (saving works, the push waits, then runs after sign-in).<br>**Two computers:** open into a new folder, push, pull with a plan, unsaved changes refused, divergence with nothing changed on either side.<br>**Opening:** only into an empty folder, and not a project connected here.<br>**Recovery:** an open finished, a pull finished, a pull rolled back.<br>**Token hygiene:** no token in the data dir (SQLite included), `.git` or events.<br>**Review fixes:** a token GitHub stopped honouring refreshed and the push retried; a new empty repository after disconnecting gets the whole history; an uninstalled public repository, a hidden folder and a folder inside another project refused for opening; an open stopped before its first file undone (bindings, `.git`, the folder) and the folder free again |
| Companion: the keychain addon (macOS) | 1 new | A throwaway item: absent, written, updated in place, read back and removed, in-process with no dialog |
| Companion: two Engines and the CLI | 1 new | Sign-in and connecting in the app; `auth status`, `auth login request`, `remote connect request`, `remote status`, `snapshot` (pushed in the background), `sync push`, `remote open plan/apply` (with a github.com address), `sync pull plan/apply`, and a refused push after divergence. No token in either data dir, either `.git`, or anything the CLI printed |
| Desktop E2E (fake GitHub) | 5 new | Sign-in with the device code; the connect wizard, the first-push review and the first push; a save pushed in the background; another computer's commit fetched with the pull dialog (shown as 外部變更); opening a project from GitHub into an empty folder; no token in the data dir |

## Known limits and follow-ups

- **The Engine environment allowlist is M1-09's.** It belongs to the SEA Engine (token-custody spike L8–L10): today's Engine is a script on a Node, and release builds have no Git, so they can't sync until then.
- **The release GitHub App** is created before M1-09; release builds can't sign in without it.
- **A real GitHub round trip through the product is a manual step.** The pieces were verified against real GitHub in M1-00 (Findings 8, 9); here everything runs against the fake. Run it with `corepack pnpm run desktop`: sign in, connect a new empty repository with the development app installed, save, open it in another folder, pull.
- **No transfer progress.** A push or fetch reports its stage, not bytes.
- **Renamed repositories aren't followed.** With redirects off, a repository renamed on GitHub must be connected again.
- **An open that stopped part-way only finishes.** If someone commits to its branch meanwhile, finishing refuses (`HISTORY_CHANGED`) and the folder stays as it is.
- **Windows and Linux.** The sync tests run on CI there with the fake GitHub; askpass through Git for Windows and a keychain (Credential Manager, Secret Service) are unverified, so development builds there keep the sign-in in memory and release builds can't sign in.
- **Divergence is reported, never resolved** (M4).
