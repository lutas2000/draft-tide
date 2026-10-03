// The release Engine's environment allowlist (CLAUDE.md "Engine environment",
// token-custody spike L8–L10). Anyone can start the real Engine, and Node
// honors variables such as NODE_EXTRA_CA_CERTS, NODE_TLS_REJECT_UNAUTHORIZED
// and NODE_USE_ENV_PROXY, which would let the starter intercept GitHub
// traffic. A denylist misses variables nobody has listed yet, so the Engine
// compares its whole environment with this list and refuses to run with
// anything else. Launchers build its environment from scratch
// (engine-client's engineEnvironment).
const OS_BASICS = [
  'HOME',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  // CoreFoundation adds it to every process, even one started with an empty
  // environment.
  '__CF_USER_TEXT_ENCODING',
];

// The Draft Tide variables a release build honors. The development knobs
// (DRAFT_TIDE_GIT, the Preview Host, the test GitHub, crash points) are not
// among them, so their presence is refused rather than ignored.
const RELEASE_VARIABLES = ['DRAFT_TIDE_DATA_DIR', 'DRAFT_TIDE_ENGINE_IDLE_MS'];

export const RELEASE_ENGINE_ENV: ReadonlySet<string> = new Set([...OS_BASICS, ...RELEASE_VARIABLES]);

// The names (never the values) of the variables outside the allowlist.
export function unexpectedVariables(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((name) => !RELEASE_ENGINE_ENV.has(name))
    .sort();
}
