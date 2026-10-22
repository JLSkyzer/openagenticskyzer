// The worker's background estimate (hardware and offload, Task 5): ops estimate-model / estimate-cancel and the
// 'estimate' event, on the real worker.mjs with a temp OPENAGENT_HOME and stories260K.gguf. No test seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, copyFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';
import { NO_LOCAL_MODEL } from '../core/active-model.mts';
import { ESTIMATE_BUSY } from '../core/offload-estimate.mts';

function callWorker(worker: Worker, op: string, payload?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `estimate-${Math.random()}`;
    const listener = (message: any) => {
      if (message.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}

async function setup(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-estimate-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const folder = join(root, 'projet');
  await Promise.all([mkdir(home), mkdir(folder)]);
  const model = join(root, 'stories260K.gguf');
  await copyFile(fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url)), model);
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);
  const estimateEvents: any[] = [];
  worker.on('message', (message: any) => { if (message?.type === 'event' && message.event === 'estimate') estimateEvents.push(message); });
  return { worker, home, folder, model, estimateEvents };
}

async function activate(worker: Worker, model: string): Promise<string> {
  const entry = await callWorker(worker, 'gguf-add', { path: model });
  await callWorker(worker, 'save-global-settings', { patch: { active_local_model: entry.id } });
  return entry.id;
}

function nextEstimateEvent(worker: Worker): Promise<any> {
  return new Promise(resolve => {
    const listener = (message: any) => {
      if (message?.type === 'event' && message.event === 'estimate') { worker.off('message', listener); resolve(message); }
    };
    worker.on('message', listener);
  });
}

test('estimate-model for the active model answers at once, then an estimate event; the second call is a cache hit', { timeout: 120000 }, async t => {
  const { worker, home, model, estimateEvents } = await setup(t);
  const modelId = await activate(worker, model);
  const event = nextEstimateEvent(worker);
  const r1 = await callWorker(worker, 'estimate-model', {});
  assert.equal(typeof r1.estimateId, 'string');
  assert.equal(r1.estimate, null);
  const ended = await event;
  assert.equal(ended.state, 'done', JSON.stringify(ended));
  assert.equal(ended.estimateId, r1.estimateId);
  assert.equal(ended.modelId, modelId);
  assert.equal(ended.estimate.contextSize, 16384);
  assert.equal(ended.estimate.source, 'estimate');
  const r2 = await callWorker(worker, 'estimate-model', { modelId });
  assert.equal(r2.estimateId, null);
  assert.deepEqual(r2.estimate, ended.estimate);
  assert.equal(estimateEvents.length, 1, 'a cache hit posts no event');
  await access(join(home, 'estimates.v3.json'));
});

// An expected refusal, not a failure (M-2, final review): answered as a normal result, so main never logs it as a
// handler error. The renderer's bridge turns it back into the same message for the user.
test('estimate-model during a turn answers { busy: true, message: ESTIMATE_BUSY } (a result, not an error)', { timeout: 120000 }, async t => {
  const { worker, folder, model } = await setup(t);
  await activate(worker, model);
  const { runId } = await callWorker(worker, 'send', { folder, branchId: 'main', text: 'Once upon a time' });
  const end = new Promise<void>(resolve => {
    const listener = (message: any) => {
      if (message?.type === 'event' && message.event === 'agent' && message.runId === runId && ['done', 'error', 'stopped'].includes(message.kind)) {
        worker.off('message', listener); resolve();
      }
    };
    worker.on('message', listener);
  });
  assert.deepEqual(await callWorker(worker, 'estimate-model', {}), { busy: true, message: ESTIMATE_BUSY, estimateId: null, estimate: null });
  await callWorker(worker, 'stop', { runId });
  await end;
});

test('estimate-cancel of an unknown id answers { cancelled: false }', { timeout: 30000 }, async t => {
  const { worker } = await setup(t);
  assert.deepEqual(await callWorker(worker, 'estimate-cancel', { estimateId: 'inconnu' }), { cancelled: false });
});

test('estimate-model with no active model is refused with NO_LOCAL_MODEL', { timeout: 30000 }, async t => {
  const { worker, estimateEvents } = await setup(t);
  await assert.rejects(callWorker(worker, 'estimate-model', {}), { message: NO_LOCAL_MODEL });
  assert.equal(estimateEvents.length, 0);
});
