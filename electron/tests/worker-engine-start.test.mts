// The engine's first start must never fail an op the page calls at start (final fix wave, item 3). In the packaged
// app with the CUDA pack, creating the Llama (node-llama-cpp's binary test in a child process, then the CUDA
// context) took more than 30 s: hardware-info waited for it, main's 30 s IPC cap fired, and the Matériel tab showed
// « Délai IPC dépassé ». A slow start is stood for by the test seam workerData.testLlamaDelayMs (never passed by
// main.cjs, tests/test-seam.test.mts). Real worker, real node-llama-cpp, stories260K only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';
import { callWorker } from './support/worker-events.mts';

const STORIES = fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url));
const WORKER = fileURLToPath(new URL('../worker.mjs', import.meta.url));
// Longer than the worker's bounded wait (HARDWARE_WAIT_MS, 5 s), far shorter than main's 30 s cap.
const DELAY_MS = 8000;

/** Resolves with the first {type:'event', event} message the worker posts from now on. */
function nextEvent(worker: Worker, event: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.off('message', listener); reject(new Error(`no '${event}' event in ${timeoutMs} ms`)); }, timeoutMs);
    const listener = (message: any) => {
      if (message?.type !== 'event' || message.event !== event) return;
      clearTimeout(timer);
      worker.off('message', listener);
      resolve(message);
    };
    worker.on('message', listener);
  });
}

test('a slow first engine start: hardware-info, model-status and estimate-model all answer well under the IPC cap, and the hardware follows as an event', { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-engine-start-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  await mkdir(home);
  const model = join(root, 'stories260K.gguf');
  await copyFile(STORIES, model);
  const worker = new Worker(WORKER, { env: { ...process.env, OPENAGENT_HOME: home }, workerData: { testLlamaDelayMs: DELAY_MS } });
  terminateAtEnd(t, worker);
  const entry = await callWorker(worker, 'gguf-add', { path: model });
  await callWorker(worker, 'save-global-settings', { patch: { active_local_model: entry.id } });

  const ready = nextEvent(worker, 'engine', 60000);
  ready.catch(() => {}); // awaited below; a failure before that must not be an unhandled rejection
  const asked = performance.now();
  const first = await callWorker(worker, 'hardware-info', { refresh: false });
  const firstMs = performance.now() - asked;
  assert.equal(first.initializing, true, `still initialising: ${JSON.stringify(first)}`);
  assert.ok(firstMs < DELAY_MS, `answered before the engine was ready (${Math.round(firstMs)} ms)`);
  assert.equal(typeof first.backendChoice, 'string', 'what does not need the engine is there at once');
  assert.equal(typeof first.restartRequired, 'boolean');
  assert.equal('backend' in first, false, 'no backend guessed before the engine says');

  const statusAsked = performance.now();
  const status = await callWorker(worker, 'model-status', {});
  assert.ok(performance.now() - statusAsked < 3000, 'model-status never waits for the engine');
  assert.equal(status.loaded, false);

  const estimateEnd = nextEvent(worker, 'estimate', 60000);
  estimateEnd.catch(() => {});
  const estimateAsked = performance.now();
  const started = await callWorker(worker, 'estimate-model', {});
  assert.ok(performance.now() - estimateAsked < 3000, 'estimate-model answers at once: its job waits for the engine, not the op');
  assert.ok(started.estimateId, JSON.stringify(started));

  const event = await ready;
  assert.equal(event.state, 'ready', JSON.stringify(event));
  const full = await callWorker(worker, 'hardware-info', { refresh: false });
  assert.equal(full.initializing, undefined);
  assert.ok(['cuda', 'vulkan', 'metal', 'cpu'].includes(full.backend), JSON.stringify(full));
  assert.equal(typeof full.ram.total, 'number');

  const estimated = await estimateEnd;
  assert.equal(estimated.state, 'done', JSON.stringify(estimated));
  assert.equal(estimated.estimateId, started.estimateId);
  assert.equal(estimated.estimate.source, 'estimate');
  // The estimate was remembered under the real hardware key: the model status reads it back.
  const after = await callWorker(worker, 'model-status', {});
  assert.deepEqual(after.placement, estimated.estimate);
});
