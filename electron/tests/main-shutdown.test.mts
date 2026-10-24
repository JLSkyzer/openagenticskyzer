import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';
import { callWorker } from './support/worker-events.mts';

// main.cjs only registers IPC and the app lifecycle when it is the Electron entry point, so it
// can be required as a library (its exported helpers are what is tested here).
const { stopWorker, hideForQuit, noteWorkerStopped, noteWorkerStarted, quitPath } = createRequire(import.meta.url)('../main.cjs');

// A worker that answers 'shutdown' and then ends its own thread, as worker.mjs does — or never does (a native call that
// would not return).
class FakeWorker extends EventEmitter {
  calls: string[] = [];
  ends: boolean;
  constructor(ends: boolean) { super(); this.ends = ends; }
  postMessage(message: any) {
    this.calls.push(`post:${message.op}`);
    if (this.ends) setImmediate(() => { this.emit('message', { id: message.id, ok: true, result: { stopped: true } }); this.emit('exit', 0); });
  }
  async terminate() { this.calls.push('terminate'); }
}

test('stopWorker asks the worker to shut down and waits for its thread to end by itself — it never terminates it', async () => {
  const worker = new FakeWorker(true);
  assert.equal(await stopWorker(worker as any, 1000), 'exited');
  assert.deepEqual(worker.calls, ['post:shutdown']);
});

test('a worker that does not end within the cap is left running, never terminated (a native call may be in flight)', async () => {
  const worker = new FakeWorker(false);
  const started = Date.now();
  assert.equal(await stopWorker(worker as any, 200), 'timeout');
  assert.deepEqual(worker.calls, ['post:shutdown'], 'Worker.terminate() during a native call crashes the process (0xC0000409)');
  assert.ok(Date.now() - started >= 180 && Date.now() - started < 3000, 'it waited for the cap, not forever');
  assert.equal(worker.listenerCount('exit') + worker.listenerCount('message'), 0, 'its listeners are removed');
});

/** The [quit] lines main writes while `run` runs (console.info), the rest of the console untouched. */
async function quitLines<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => { const line = args.map(String).join(' '); if (line.startsWith('[quit]')) lines.push(line); else original(...args); };
  try {
    return { result: await run(), lines };
  } finally {
    console.info = original;
  }
}

// A worker still busy at the cap: it reports what it waits for (type 'quit-wait', every QUIT_REPORT_MS in worker.mjs),
// or — its thread blocked in a synchronous native call — reports nothing at all.
class ReportingWorker extends FakeWorker {
  timers: NodeJS.Timeout[] = [];
  waiting: string[] | null;
  everyMs: number;
  single: boolean;
  constructor(waiting: string[] | null, everyMs: number, single = false) {
    super(false);
    this.waiting = waiting;
    this.everyMs = everyMs;
    this.single = single;
  }
  postMessage(message: any) {
    super.postMessage(message);
    if (this.waiting === null) return;
    const report = () => this.emit('message', { type: 'quit-wait', phase: 'travail en cours', waiting: this.waiting });
    this.timers.push(this.single ? setTimeout(report, this.everyMs) : setInterval(report, this.everyMs));
  }
  stop() { for (const timer of this.timers) clearInterval(timer); }
}

test('a worker still busy at the cap: the [quit] line names what it still waits for, from its last report', async () => {
  const worker = new ReportingWorker(['op hardware-info depuis 12 s', 'générations depuis 3 s'], 30);
  try {
    const { result, lines } = await quitLines(() => stopWorker(worker as any, 300));
    assert.equal(result, 'timeout');
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /n'a pas fini en 300 ms/);
    assert.match(lines[0], /attend encore : op hardware-info depuis 12 s, générations depuis 3 s/);
    assert.deepEqual(worker.calls, ['post:shutdown'], 'still never terminated');
  } finally { worker.stop(); }
});

test('a worker that reports nothing at all before the cap: the [quit] line says its thread is blocked in a native call', async () => {
  const worker = new ReportingWorker(null, 0);
  const { result, lines } = await quitLines(() => stopWorker(worker as any, 200));
  assert.equal(result, 'timeout');
  assert.match(lines[0], /aucune nouvelle du moteur depuis la demande d’arrêt/);
  assert.match(lines[0], /appel natif synchrone/);
});

test('a worker whose reports stopped long before the cap: the [quit] line says so, with its last report', async () => {
  const worker = new ReportingWorker(['op hardware-info depuis 1 s'], 10, true);
  try {
    const { result, lines } = await quitLines(() => stopWorker(worker as any, 400, 100));
    assert.equal(result, 'timeout');
    assert.match(lines[0], /aucune nouvelle du moteur depuis 0,\d s/);
    assert.match(lines[0], /appel natif synchrone/);
    assert.match(lines[0], /dernier état : op hardware-info depuis 1 s/);
  } finally { worker.stop(); }
});

test('a real worker quit while hardware-info waits for a slow engine start: it reports that op, the [quit] line names it, and the thread still ends by itself', { timeout: 120000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'openagent-main-shutdown-'));
  removeAtEnd(t, home);
  // The engine's creation held 8 s (test seam), longer than hardware-info's bounded wait (5 s) and than this cap.
  const worker = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home }, workerData: { testLlamaDelayMs: 8000 } }));
  const exited = new Promise<number>(resolve => worker.once('exit', resolve));
  const reports: any[] = [];
  worker.on('message', message => { if (message?.type === 'quit-wait') reports.push(message); });
  await callWorker(worker, 'global-settings');
  const info = callWorker(worker, 'hardware-info', { refresh: false });
  await new Promise(resolve => setTimeout(resolve, 200));
  const { result, lines } = await quitLines(() => stopWorker(worker, 3500));
  assert.equal(result, 'timeout', 'still waiting at 3.5 s: hardware-info waits up to 5 s for the engine');
  assert.match(lines[0], /attend encore : .*op hardware-info depuis \d+ s/, lines.join('\n'));
  assert.equal((await info).initializing, true, 'the op itself still answers');
  assert.equal(await exited, 0, 'the thread ended by itself once the engine was created and freed');
  assert.ok(reports.some(report => report.phase === 'libération du moteur'), `the dispose phase was reported too: ${JSON.stringify(reports.map(report => report.phase))}`);
});

test('stopWorker on a real worker: it answers, then its thread ends by itself; ops sent after the shutdown are refused', async t => {
  const home = await mkdtemp(join(tmpdir(), 'openagent-main-shutdown-'));
  removeAtEnd(t, home);
  const worker = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } }));
  let exitCode: number | null = null;
  worker.once('exit', code => { exitCode = code; });
  const answers: any[] = [];
  worker.on('message', message => { if (message?.type === 'response') answers.push(message); });
  await callWorker(worker, 'global-settings');
  const stopping = stopWorker(worker, 30000);
  worker.postMessage({ id: 'late', op: 'global-settings', payload: {} });
  assert.equal(await stopping, 'exited');
  assert.equal(exitCode, 0, 'ended by itself (process.exit(0)), not terminated (1)');
  assert.equal(worker.threadId, -1, 'the worker thread is gone');
  const late = answers.find(answer => answer.id === 'late');
  assert.equal(late?.ok, false);
  assert.equal(late?.error, 'L’app se ferme.');
  const shutdown = answers.find(answer => String(answer.id).startsWith('shutdown-'));
  assert.equal(shutdown?.ok, true);
  for (const step of ['servers', 'work', 'dispose', 'total']) assert.equal(typeof shutdown.result.steps[step], 'number', step);
  assert.equal(await stopWorker(worker, 100), 'exited', 'a worker already gone is not waited for');
});

test('stopWorker tolerates no worker at all', async () => {
  assert.equal(await stopWorker(undefined as any, 100), 'exited');
});

test('hideForQuit hides the window and removes the tray icon at once; a missing or destroyed one is skipped', () => {
  const calls: string[] = [];
  const window = { isDestroyed: () => false, hide: () => calls.push('hide') };
  const icon = { isDestroyed: () => false, destroy: () => calls.push('destroy') };
  hideForQuit(window, icon);
  assert.deepEqual(calls, ['hide', 'destroy']);
  hideForQuit({ isDestroyed: () => true, hide: () => calls.push('hide again') }, undefined);
  hideForQuit(undefined, { isDestroyed: () => true, destroy: () => calls.push('destroy again') });
  assert.deepEqual(calls, ['hide', 'destroy']);
});

test('after a stuck stop followed by a new start, a quit takes the normal path (not the last resort)', async () => {
  const idle = { hasWorker: false, stopping: false };
  noteWorkerStarted();
  assert.equal(quitPath(idle), 'normal');
  noteWorkerStopped('timeout');
  assert.equal(quitPath(idle), 'last-resort', 'a stuck worker still ends the process by the system');
  assert.equal(quitPath({ hasWorker: true, stopping: false }), 'wait', 'a worker running is stopped first');
  noteWorkerStarted(); // what startBackend does after a failed installer
  assert.equal(quitPath(idle), 'normal');
  noteWorkerStopped('exited');
  assert.equal(quitPath(idle), 'normal');
  // startBackend and the install path are wired as the tests above assume (main.cjs cannot run here).
  const source = readFileSync(fileURLToPath(new URL('../main.cjs', import.meta.url)), 'utf8');
  assert.ok(/function startBackend\(\) \{\s*noteWorkerStarted\(\);/.test(source), 'startBackend clears the stuck flag');
  assert.ok(source.includes('stop: () => { hideForQuit(); return stopBackend(); }'), 'the install path hides the window before stopping');
});
