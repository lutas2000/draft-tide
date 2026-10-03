import { spawn } from 'node:child_process';
import { DtError } from '@draft-tide/contracts';
import { gitEnvironment, type GitRuntime } from './runtime.ts';

export interface RunOptions {
  input?: string | Uint8Array;
  signal?: AbortSignal | undefined;
  // A hung Git must not hang the Engine. Commands whose run time grows with
  // the project (listings, writing objects) pass null, or stream, and rely on
  // the signal instead.
  timeoutMs?: number | null | undefined;
  // Buffered output is for small metadata; streaming output has no budget
  // because it is proportional to the project (no fixed quotas).
  maxOutputBytes?: number;
  // Records, delivered as they arrive instead of buffered: NUL-terminated, or
  // newline-terminated with recordSeparator 10.
  onRecord?: (record: Buffer) => void;
  recordSeparator?: 0 | 10;
  // Raw output chunks, for protocols that carry their own framing.
  onChunk?: (chunk: Buffer) => void;
  okExitCodes?: readonly number[];
  env?: Readonly<Record<string, string>>;
}

export interface GitOutput {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;

// Test instrumentation: every argv this process passes to Git.
export const gitTrace: { enabled: boolean; argv: string[][] } = { enabled: false, argv: [] };

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

// The first argument that names the Git command, for messages.
function subcommand(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '-c') {
      i++;
      continue;
    }
    if (!a.startsWith('-')) return a;
  }
  return 'git';
}

// spawn() with an argument array (no shell), an environment built from
// scratch, and bounded output.
export function runGit(
  rt: GitRuntime,
  argv: readonly string[],
  cwd: string,
  options: RunOptions = {},
): Promise<GitOutput> {
  const ok = new Set([0, ...(options.okExitCodes ?? [])]);
  const maxOut = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const streaming = options.onRecord !== undefined || options.onChunk !== undefined;
  const timeoutMs =
    options.timeoutMs === null ? undefined : (options.timeoutMs ?? (streaming ? undefined : DEFAULT_TIMEOUT_MS));
  const separator = options.recordSeparator ?? 0;
  const cmd = subcommand(argv);
  if (gitTrace.enabled) gitTrace.argv.push([rt.gitPath, ...argv]);

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(asError(options.signal.reason));
      return;
    }
    const child = spawn(rt.gitPath, [...argv], {
      cwd,
      env: gitEnvironment(rt, options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let pending: Buffer = Buffer.alloc(0);
    let stderr = '';
    let settled = false;
    let failure: Error | null = null;

    const fail = (err: unknown) => {
      failure ??= asError(err);
      child.kill('SIGKILL');
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => fail(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer =
      timeoutMs === undefined
        ? null
        : setTimeout(
            () => fail(new DtError('GIT_FAILED', `git ${cmd} did not finish in time`, { reason: 'timeout' }, true)),
            timeoutMs,
          );

    child.stdout.on('data', (chunk: Buffer) => {
      if (failure !== null) return;
      if (options.onChunk) {
        try {
          options.onChunk(chunk);
        } catch (e) {
          fail(e);
        }
        return;
      }
      if (options.onRecord) {
        let buf = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
        let end = buf.indexOf(separator);
        while (end !== -1) {
          try {
            options.onRecord(buf.subarray(0, end));
          } catch (e) {
            fail(e);
            return;
          }
          buf = buf.subarray(end + 1);
          end = buf.indexOf(separator);
        }
        pending = Buffer.from(buf);
        return;
      }
      outBytes += chunk.length;
      if (outBytes > maxOut) {
        fail(
          new DtError('RESOURCE_BUDGET_EXCEEDED', `git ${cmd} produced more output than expected`, {
            budget: 'git-metadata-output',
            limitBytes: maxOut,
          }),
        );
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8').slice(0, MAX_STDERR - stderr.length);
    });
    // Git may exit before reading all input (it failed early); that shows up
    // as the exit code, not as an EPIPE crash.
    child.stdin.on('error', () => undefined);
    child.on('error', (e: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          new DtError('GIT_FAILED', `Git could not be started: ${e.message}`, {
            reason: e.code === 'ENOENT' ? 'git-unavailable' : 'spawn-failed',
          }),
        ),
      );
    });
    child.on('close', (code) => {
      finish(() => {
        if (failure !== null) {
          reject(failure);
          return;
        }
        if (options.onRecord && pending.length > 0) {
          try {
            options.onRecord(pending);
          } catch (e) {
            reject(asError(e));
            return;
          }
        }
        const exitCode = code ?? -1;
        if (!ok.has(exitCode)) {
          const detail = stderr.trim().split('\n').slice(0, 5).join(' / ').slice(0, 600);
          reject(
            new DtError('GIT_FAILED', `git ${cmd} failed (exit ${exitCode})${detail ? `: ${detail}` : ''}`, {
              subcommand: cmd,
              exitCode,
            }),
          );
          return;
        }
        resolve({ stdout: Buffer.concat(out), stderr, exitCode });
      });
    });
    child.stdin.end(options.input ?? '');
  });
}

// Streams stdout with backpressure: Git is read only as fast as the caller
// iterates, and ending the iteration early (break, an exception) stops Git.
// A failing exit is thrown after the last chunk. No timeout: the size is the
// object's, not a budget (no fixed quotas); the signal cancels.
export async function* streamGit(
  rt: GitRuntime,
  argv: readonly string[],
  cwd: string,
  options: { signal?: AbortSignal | undefined; env?: Readonly<Record<string, string>> } = {},
): AsyncGenerator<Buffer, void, undefined> {
  const { signal } = options;
  signal?.throwIfAborted();
  const cmd = subcommand(argv);
  if (gitTrace.enabled) gitTrace.argv.push([rt.gitPath, ...argv]);
  const child = spawn(rt.gitPath, [...argv], {
    cwd,
    env: gitEnvironment(rt, options.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8').slice(0, MAX_STDERR - stderr.length);
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.on('error', (e: NodeJS.ErrnoException) =>
      reject(
        new DtError('GIT_FAILED', `Git could not be started: ${e.message}`, {
          reason: e.code === 'ENOENT' ? 'git-unavailable' : 'spawn-failed',
        }),
      ),
    );
    child.on('close', (code) => resolve(code ?? -1));
  });
  // Observed below, or deliberately dropped when the caller stops early.
  exited.catch(() => undefined);
  const onAbort = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', onAbort, { once: true });
  let finished = false;
  try {
    for await (const chunk of child.stdout) yield chunk as Buffer;
    const code = await exited;
    signal?.throwIfAborted();
    if (code !== 0) {
      const detail = stderr.trim().split('\n').slice(0, 5).join(' / ').slice(0, 600);
      throw new DtError('GIT_FAILED', `git ${cmd} failed (exit ${code})${detail ? `: ${detail}` : ''}`, {
        subcommand: cmd,
        exitCode: code,
      });
    }
    finished = true;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!finished && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

// The version of the Git this runtime runs ("2.53.0"), for diagnostics; null
// when it can't be started or says something else.
export async function gitVersion(rt: GitRuntime): Promise<string | null> {
  try {
    const r = await runGit(rt, ['--version'], rt.homeDir, { maxOutputBytes: 4096, timeoutMs: 10_000 });
    return /^git version (\d+\.\d+\.\d+)/.exec(r.stdout.toString('utf8'))?.[1] ?? null;
  } catch {
    return null;
  }
}
