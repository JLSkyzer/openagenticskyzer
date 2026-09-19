import { spawn, type ChildProcess } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout: number;
  signal?: AbortSignal;
  /** Per stream; anything beyond is drained and dropped so the child never blocks on a full pipe. */
  maxBytes?: number;
  shell?: boolean;
}
export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  truncated: boolean;
}

/**
 * Kills a process and every process it started. Killing only the direct child (a shell, git's
 * ssh helper, a dev server's workers) leaves the rest running and holding the pipes.
 */
export function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise(resolve => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { try { child.kill(); } catch { /* already gone */ } resolve(); });
      killer.on('close', () => resolve());
    });
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  return Promise.resolve();
}

/**
 * Runs a command to completion. A non-zero exit is a result, not an error; a missing command
 * (ENOENT) and an abort reject. The whole process tree is killed on timeout and on abort.
 */
export function runProcess(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  const { cwd, env, timeout, signal, maxBytes = 1024 * 1024, shell = false } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const child = spawn(command, args, {
      cwd, env, shell, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let truncated = false;
    const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const room = maxBytes - sizes[stream];
      if (room <= 0) { truncated = true; return; }
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (kept.length < chunk.length) truncated = true;
      chunks[stream].push(kept);
      sizes[stream] += kept.length;
    };
    child.stdout!.on('data', collect('stdout'));
    child.stderr!.on('data', collect('stderr'));

    let timedOut = false;
    let aborted = false;
    let finished = false;
    const finish = (settle: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      settle();
    };
    const result = (code: number | null): RunResult => ({
      stdout: Buffer.concat(chunks.stdout).toString('utf8'),
      stderr: Buffer.concat(chunks.stderr).toString('utf8'),
      code, timedOut, truncated,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      void killTree(child);
      // A grandchild that kept a pipe open must not keep us waiting for 'close' forever.
      setTimeout(() => finish(() => resolve(result(null))), 3000).unref();
    }, timeout);
    const onAbort = () => {
      aborted = true;
      void killTree(child);
      setTimeout(() => finish(() => reject(signal!.reason)), 3000).unref();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', error => finish(() => reject(error)));
    child.on('close', code => finish(() => (aborted ? reject(signal!.reason) : resolve(result(code)))));
  });
}
