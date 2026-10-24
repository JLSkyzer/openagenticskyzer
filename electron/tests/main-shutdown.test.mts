import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';
import { callWorker } from './support/worker-events.mts';

// main.cjs only registers IPC and the app lifecycle when it is the Electron entry point, so it
// can be required as a library (its exported helpers are what is tested here).
const { stopWorker, hideForQuit } = createRequire(import.meta.url)('../main.cjs');

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
