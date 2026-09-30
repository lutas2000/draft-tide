// Tiny entry used by the suite to run an operation in a child process, so a
// crash point can SIGKILL it for real (SPIKE_CRASH_AT=<name>).
import { resolveGitRuntime } from './git.ts';
import { DesignRepo } from './repo.ts';
import { fastForwardOnly } from './cli-helpers.ts';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`missing --${name}`);
  return v;
}

const cmd = process.argv[2];
const rt = resolveGitRuntime(arg('home'));
const repo = new DesignRepo(rt, arg('data'), arg('root'));

try {
  let out: unknown;
  if (cmd === 'save') out = await repo.save({ origin: 'cli', indexLockWaitMs: 300 });
  else if (cmd === 'recover') out = await repo.recover();
  else if (cmd === 'restore') {
    const plan = await repo.planRestore(arg('target'));
    out = await repo.applyRestore(plan, 'cli');
  } else if (cmd === 'ff') out = await fastForwardOnly(repo, arg('target'));
  else throw new Error(`unknown command ${String(cmd)}`);
  process.stdout.write(JSON.stringify({ ok: true, data: out }));
} catch (e) {
  const err = e as { code?: string; message?: string };
  process.stdout.write(JSON.stringify({ ok: false, error: { code: err.code ?? 'STORAGE_IO_FAILED', message: err.message ?? String(e) } }));
  process.exitCode = 1;
}
