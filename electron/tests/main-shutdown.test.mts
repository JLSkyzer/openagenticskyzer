import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// main.cjs only registers IPC and the app lifecycle when it is the Electron entry point, so it
// can be required as a library (its exported helpers are what is tested here).
const { stopWorker } = createRequire(import.meta.url)('../main.cjs');

class FakeWorker extends EventEmitter {
  calls: string[] = [];
  answers: boolean;
  constructor(answers: boolean) { super(); this.answers = answers; }
  postMessage(message: any) {
    this.calls.push(`post:${message.op}`);
    if (this.answers) setImmediate(() => this.emit('message', { id: message.id, ok: true, result: { stopped: true } }));
  }
  async terminate() { this.calls.push('terminate'); }
}

test('stopWorker asks the worker to shut down, waits for its answer, then terminates it', async () => {
  const worker = new FakeWorker(true);
  await stopWorker(worker as any, 1000);
  assert.deepEqual(worker.calls, ['post:shutdown', 'terminate']);
});

test('stopWorker still terminates a worker that never answers, after the grace period', async () => {
  const worker = new FakeWorker(false);
  const started = Date.now();
  await stopWorker(worker as any, 200);
  assert.deepEqual(worker.calls, ['post:shutdown', 'terminate']);
  assert.ok(Date.now() - started >= 180 && Date.now() - started < 3000, 'it waited for the grace period, not forever');
});

test('stopWorker on a real worker leaves it terminated', async t => {
  const home = await mkdtemp(join(tmpdir(), 'openagent-main-shutdown-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  await stopWorker(worker, 3000);
  assert.equal(worker.threadId, -1, 'the worker thread is gone');
});

test('stopWorker tolerates no worker at all', async () => {
  await stopWorker(undefined as any, 100);
});
