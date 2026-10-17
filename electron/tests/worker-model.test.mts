// One model engine (local-only lot, Task 2): the worker reads active_local_model itself, refuses a send or a
// compaction when no .gguf is active, and reports the engine's window through model-status and the 'model' event.
// Every worker here is built WITHOUT the test seam: only the real local engine can answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';
import { NO_LOCAL_MODEL, LOCAL_MODEL_MISSING } from '../core/active-model.mts';

function callWorker(worker: Worker, op: string, payload?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `model-${Math.random()}`;
    const listener = (message: any) => {
      if (message.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}

async function setup(t: { after(fn: () => unknown): void }, config?: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-model-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const folder = join(root, 'projet');
  await Promise.all([mkdir(home), mkdir(folder)]);
  if (config) await writeFile(join(home, 'config.json'), JSON.stringify(config));
  const model = join(root, 'stories260K.gguf');
  await copyFile(fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url)), model);
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);
  const agentEvents: any[] = [];
  const modelEvents: any[] = [];
  worker.on('message', (message: any) => {
    if (message?.type !== 'event') return;
    if (message.event === 'agent') agentEvents.push(message);
    if (message.event === 'model') modelEvents.push(message);
  });
  return { worker, folder, model, agentEvents, modelEvents };
}

const exchanges = (count: number) => Array.from({ length: count * 2 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `message ${i}` }));

test('a. send with no active .gguf is refused before anything starts', { timeout: 30000 }, async t => {
  // Old data from an online provider: it loads, and no stored provider is used.
  const { worker, folder, agentEvents } = await setup(t, { current_provider: 'groq', current_model: 'llama', hf_token: 'hf_x' });
  await assert.rejects(callWorker(worker, 'send', { folder, branchId: 'main', text: 'x' }), { message: NO_LOCAL_MODEL });
  assert.deepEqual(await callWorker(worker, 'messages', { folder, branchId: 'main' }), []);
  assert.equal(agentEvents.length, 0);
});

test('b. compact with no active .gguf is refused, the transcript unchanged', { timeout: 30000 }, async t => {
  const { worker, folder, agentEvents } = await setup(t);
  const history = exchanges(3);
  await callWorker(worker, 'save-messages', { folder, branchId: 'main', messages: history });
  await assert.rejects(callWorker(worker, 'compact', { folder, branchId: 'main' }), { message: NO_LOCAL_MODEL });
  assert.deepEqual(await callWorker(worker, 'messages', { folder, branchId: 'main' }), history);
  assert.equal(agentEvents.length, 0);
});

test('c. the worker reads active_local_model itself: a localModel id in the payload is ignored', { timeout: 30000 }, async t => {
  const { worker, folder, model, agentEvents } = await setup(t);
  const entry = await callWorker(worker, 'gguf-add', { path: model });
  assert.equal((await callWorker(worker, 'global-settings')).active_local_model, '');
  await assert.rejects(callWorker(worker, 'send', { folder, branchId: 'main', text: 'x', localModel: entry.id }), { message: NO_LOCAL_MODEL });
  assert.deepEqual(await callWorker(worker, 'messages', { folder, branchId: 'main' }), []);
  assert.equal(agentEvents.length, 0);
});

test('d. an active model whose file is gone is refused with LOCAL_MODEL_MISSING', { timeout: 30000 }, async t => {
  const { worker, folder, model, agentEvents } = await setup(t);
  const entry = await callWorker(worker, 'gguf-add', { path: model });
  await callWorker(worker, 'save-global-settings', { patch: { active_local_model: entry.id } });
  await rm(model);
  await assert.rejects(callWorker(worker, 'send', { folder, branchId: 'main', text: 'x' }), { message: LOCAL_MODEL_MISSING });
  assert.deepEqual(await callWorker(worker, 'messages', { folder, branchId: 'main' }), []);
  assert.equal(agentEvents.length, 0);
});

test('e. model-status before any load: the active name, MIN_LOCAL_CONTEXT, not loaded', { timeout: 30000 }, async t => {
  const { worker, model } = await setup(t);
  const entry = await callWorker(worker, 'gguf-add', { path: model });
  await callWorker(worker, 'save-global-settings', { patch: { active_local_model: entry.id } });
  assert.deepEqual(await callWorker(worker, 'model-status', {}), { id: entry.id, name: 'stories260K.gguf', missing: false, contextWindow: 16384, loaded: false });
});

test('f. after a real turn on stories260K, model-status and the model event give the engine\'s real window', { timeout: 180000 }, async t => {
  const { worker, folder, model, agentEvents, modelEvents } = await setup(t);
  const entry = await callWorker(worker, 'gguf-add', { path: model });
  await callWorker(worker, 'save-global-settings', { patch: { active_local_model: entry.id } });
  const { runId } = await callWorker(worker, 'send', { folder, branchId: 'main', text: 'Once upon a time' });
  await new Promise<void>(resolve => {
    const listener = (message: any) => {
      if (message?.type === 'event' && message.event === 'agent' && message.runId === runId && ['done', 'error', 'stopped'].includes(message.kind)) {
        worker.off('message', listener); resolve();
      }
    };
    worker.on('message', listener);
  });
  assert.equal(agentEvents.at(-1).kind, 'done', JSON.stringify(agentEvents.find(e => e.kind === 'error')));
  assert.equal(modelEvents.length, 1, 'one model event per turn');
  const status = await callWorker(worker, 'model-status', {});
  assert.equal(status.loaded, true);
  assert.equal(status.id, entry.id);
  assert.equal(status.name, 'stories260K.gguf');
  assert.equal(status.contextWindow, modelEvents[0].contextWindow);
  assert.equal(modelEvents[0].loaded, true, 'posted once the engine has loaded');
  assert.ok(status.contextWindow >= 16384, `the engine runs with at least the floor, got ${status.contextWindow}`);
});

test('g. model-status with none active, and with a missing file', { timeout: 30000 }, async t => {
  const { worker, model } = await setup(t);
  const none = await callWorker(worker, 'model-status', {});
  assert.deepEqual(none, { id: '', name: null, missing: false, contextWindow: 16384, loaded: false });
  const entry = await callWorker(worker, 'gguf-add', { path: model });
  await callWorker(worker, 'save-global-settings', { patch: { active_local_model: entry.id } });
  await rm(model);
  const missing = await callWorker(worker, 'model-status', {});
  assert.equal(missing.missing, true);
  assert.equal(missing.name, null);
  assert.equal(missing.id, entry.id);
  assert.equal(missing.loaded, false);
});

test('h. the model event names the model the turn actually used, even when the setting changes during the turn', { timeout: 180000 }, async t => {
  const { worker, folder, model, agentEvents, modelEvents } = await setup(t);
  const entry = await callWorker(worker, 'gguf-add', { path: model });
  await callWorker(worker, 'save-global-settings', { patch: { active_local_model: entry.id } });
  const ended = new Promise<void>(resolve => {
    const listener = (message: any) => {
      if (message?.type === 'event' && message.event === 'agent' && ['done', 'error', 'stopped'].includes(message.kind)) {
        worker.off('message', listener); resolve();
      }
    };
    worker.on('message', listener);
  });
  await callWorker(worker, 'send', { folder, branchId: 'main', text: 'Once upon a time' });
  // The turn has its model; the user now deselects it. The event still describes the model this turn runs on,
  // never a fresh read of the setting.
  await callWorker(worker, 'save-global-settings', { patch: { active_local_model: '' } });
  await ended;
  assert.equal(agentEvents.at(-1).kind, 'done', JSON.stringify(agentEvents.find(e => e.kind === 'error')));
  assert.equal(modelEvents.length, 1);
  const { type, event, ...status } = modelEvents[0];
  assert.equal(status.id, entry.id);
  assert.equal(status.name, 'stories260K.gguf');
  assert.equal(status.missing, false);
  assert.equal(status.loaded, true);
  assert.ok(status.contextWindow >= 16384);
});
