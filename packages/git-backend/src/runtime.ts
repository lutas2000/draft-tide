import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

// Which Git runs, and the environment it runs in. Release builds use the
// bundled full Git (M1-09) and never consult PATH; development and tests use
// DRAFT_TIDE_GIT or the first `git` on PATH (findGitOnPath).
export interface GitRuntime {
  // Absolute path of the git executable.
  gitPath: string;
  // GIT_EXEC_PATH for a bundled Git; null lets a system Git find its own.
  execPath: string | null;
  // An empty private directory used as HOME, so nothing personal is read.
  homeDir: string;
}

export const GIT_PATH_ENV = 'DRAFT_TIDE_GIT';

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Development and tests only.
export function findGitOnPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const forced = env[GIT_PATH_ENV];
  if (forced) return isAbsolute(forced) && isExecutableFile(forced) ? forced : null;
  const names = process.platform === 'win32' ? ['git.exe'] : ['git'];
  for (const dir of (env['PATH'] ?? env['Path'] ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

// On every local invocation. Command-line settings outrank the repo's own
// config, so hooks, fsmonitor, external attribute and ignore files, line-ending
// conversion, signing and automatic GC can't be switched on by the repo
// (single-repo spike D1–D4, each checked against a control that fires).
// Commits are always UTF-8 without an encoding header, and Git refuses paths
// that some filesystem would take for `.git` on every platform, not only on
// the one it runs on (protectHFS is off by default outside macOS). Objects,
// refs and the index Git writes are fsynced. Network operations need more
// than this (an empty git dir, M1-07).
export const HARDENING: readonly string[] = [
  '--no-replace-objects',
  '--literal-pathspecs',
  '--no-pager',
  ...[
    'core.hooksPath=/dev/null',
    'core.attributesFile=/dev/null',
    'core.excludesFile=/dev/null',
    'core.fsmonitor=false',
    'core.autocrlf=false',
    'core.safecrlf=false',
    'core.untrackedCache=false',
    'core.splitIndex=false',
    'core.protectHFS=true',
    'core.protectNTFS=true',
    'core.fsync=objects,reference,index',
    'gc.auto=0',
    'maintenance.auto=false',
    'commit.gpgSign=false',
    'tag.gpgSign=false',
    'i18n.commitEncoding=UTF-8',
    'i18n.logOutputEncoding=UTF-8',
    'protocol.allow=never',
    'transfer.fsckObjects=true',
  ].flatMap((setting) => ['-c', setting]),
];

// Built from scratch: nothing from the Engine's own environment (GIT_DIR,
// GIT_CONFIG_*, GIT_INDEX_FILE, HOME…) reaches Git.
export function gitEnvironment(rt: GitRuntime, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const windows = process.platform === 'win32';
  const path = windows
    ? [dirname(rt.gitPath), join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')]
    : [dirname(rt.gitPath), '/usr/bin', '/bin'];
  const env: Record<string, string> = {
    PATH: path.join(delimiter),
    HOME: rt.homeDir,
    XDG_CONFIG_HOME: join(rt.homeDir, '.config'),
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    // --no-replace-objects leaves `.git/info/grafts` in force, and grafts
    // rewrite the parents Git reports. History is read from the objects.
    GIT_GRAFT_FILE: '/dev/null',
    // Set, so it wins over any protocol.*.allow in the repo's config; names no
    // real protocol, so local operations can't reach a transport at all.
    GIT_ALLOW_PROTOCOL: 'none',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_ADVICE: '0',
  };
  if (windows) {
    env['USERPROFILE'] = rt.homeDir;
    // Windows needs these to load system libraries.
    for (const key of ['SystemRoot', 'WINDIR']) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
  }
  if (rt.execPath) env['GIT_EXEC_PATH'] = rt.execPath;
  return { ...env, ...extra };
}
