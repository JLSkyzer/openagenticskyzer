// One model engine (local-only lot, Task 2): the worker reads active_local_model itself, refuses a send or a
// compaction when no .gguf is active, and reports the engine's window through model-status and the 'model' event.
// Every worker here is built WITHOUT the test seam: only the real local engine can answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';
import { NO_LOCAL_MODEL, LOCAL_MODEL_MISSING } from '../core/active-model.mts';
import { withTrainContext } from './support/gguf-fixture.mts';

/** What the tests drive: a worker thread, or one living in its own process (processWorker). */
interface WorkerPort {
  on(event: 'message', listener: (message: any) => void): unknown;
  off(event: 'message', listener: (message: any) => void): unknown;
  postMessage(message: unknown): void;
  terminate(): Promise<unknown>;
}

/**
 * worker.mjs as a worker thread of a separate Node process, its messages relayed over IPC. For a worker that must
 * load another llama.cpp backend than the one this test process already loaded: two backends' binaries in one
 * process once killed the whole tests/all.mts run, silently (2026-10-18). The app never mixes them.
 */
function processWorker(env: NodeJS.ProcessEnv): WorkerPort {
  const workerUrl = new URL('../worker.mjs', import.meta.url).href;
  // The thread gets its own execArgv: inheriting this process's --input-type would refuse a file entry point.
  const relay = `
    import { Worker } from 'node:worker_threads';
    const worker = new Worker(new URL(${JSON.stringify(workerUrl)}), { execArgv: ['--experimental-strip-types'] });
    worker.on('message', message => process.send(message));
    worker.on('error', error => { console.error(error); process.exit(1); });
    process.on('message', message => worker.postMessage(message));
    process.on('disconnect', () => process.exit(0));`;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', relay], {
    env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced',
  });
  return {
    on: (event, listener) => child.on(event, listener),
    off: (event, listener) => child.off(event, listener),
    postMessage: message => { child.send(message as any); },
    terminate: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    },
  };
}

function callWorker(worker: WorkerPort, op: string, payload?: unknown): Promise<any> {
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

/** `ownProcessEnv`: extra environment for a worker run in its own process (processWorker); none = a worker thread. */
async function setup(t: { after(fn: () => unknown): void }, config?: Record<string, unknown>, ownProcessEnv?: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-model-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const folder = join(root, 'projet');
  await Promise.all([mkdir(home), mkdir(folder)]);
  if (config) await writeFile(join(home, 'config.json'), JSON.stringify(config));
  const model = join(root, 'stories260K.gguf');
  await copyFile(fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url)), model);
  const worker: WorkerPort = ownProcessEnv
    ? processWorker({ ...process.env, ...ownProcessEnv, OPENAGENT_HOME: home })
    : new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);
  const agentEvents: any[] = [];
  const modelEvents: any[] = [];
  worker.on('message', (message: any) => {
    if (message?.type !== 'event') return;
    if (message.event === 'agent') agentEvents.push(message);
    if (message.event === 'model') modelEvents.push(message);
  });
  return { worker, folder, model, root, agentEvents, modelEvents };
}

/** A copy of stories260K whose train context reads 131 072, in the test's temp dir. */
async function patchedModel(root: string): Promise<string> {
  const patched = join(root, 'stories-131072.gguf');
  await withTrainContext(fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url)), patched, 131072);
  return patched;
}

/** Sends one message and resolves with the run's last agent event once it has ended. */
async function turn(worker: WorkerPort, folder: string, text = 'Once upon a time'): Promise<any> {
  let runId: string | undefined;
  const early: any[] = [];
  const ended = new Promise<any>(resolve => {
    const listener = (message: any) => {
      if (message?.type !== 'event' || message.event !== 'agent' || !['done', 'error', 'stopped'].includes(message.kind)) return;
      if (runId === undefined) { early.push(message); return; }
      if (message.runId === runId) { worker.off('message', listener); resolve(message); }
    };
    worker.on('message', listener);
  });
  runId = (await callWorker(worker, 'send', { folder, branchId: 'main', text })).runId;
  const already = early.find(message => message.runId === runId);
  return already ?? ended;
}

/** Resolves with the last agent event of `runId` once that run has ended. */
function turnEnd(worker: WorkerPort, runId: string): Promise<any> {
  return new Promise(resolve => {
    const listener = (message: any) => {
      if (message?.type === 'event' && message.event === 'agent' && message.runId === runId && ['done', 'error', 'stopped'].includes(message.kind)) {
        worker.off('message', listener); resolve(message);
      }
    };
    worker.on('message', listener);
  });
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

test('i. local_context 65536 on a model trained for 131072: the turn runs with 65536; set to max, the next turn reloads at 131072', { timeout: 300000 }, async t => {
  const { worker, folder, root, agentEvents, modelEvents } = await setup(t);
  const entry = await callWorker(worker, 'gguf-add', { path: await patchedModel(root) });
  await callWorker(worker, 'save-global-settings', { patch: { active_local_model: entry.id, local_context: 65536 } });
  assert.equal((await turn(worker, folder)).kind, 'done', JSON.stringify(agentEvents.find(e => e.kind === 'error')));
  assert.equal(modelEvents.at(-1).contextWindow, 65536);
  await callWorker(worker, 'save-global-settings', { patch: { local_context: 'max' } });
  assert.equal((await turn(worker, folder)).kind, 'done', JSON.stringify(agentEvents.find(e => e.kind === 'error')));
  assert.equal(modelEvents.length, 2);
  assert.equal(modelEvents.at(-1).contextWindow, 131072, 'the changed setting reloaded the engine at the next message');
});

// Ruling F6: max_tokens caps the request window (effectiveWindow), never the engine context.
test('j. max_tokens leaves the engine context alone: local_context 65536 with max_tokens 24576 still loads 65536', { timeout: 180000 }, async t => {
  const { worker, folder, root, agentEvents, modelEvents } = await setup(t);
  const entry = await callWorker(worker, 'gguf-add', { path: await patchedModel(root) });
  await callWorker(worker, 'save-global-settings', { patch: { active_local_model: entry.id, local_context: 65536, max_tokens: 24576 } });
  assert.equal((await turn(worker, folder)).kind, 'done', JSON.stringify(agentEvents.find(e => e.kind === 'error')));
  assert.equal(modelEvents.at(-1).contextWindow, 65536);
});

// The processor-only variant: the worker lives in a process of its own (see processWorker), so its cpu binary never
// sits beside the backend this test process may already have loaded. The turn is stopped once the answer has started:
// stories260K never stops by itself and runs to the 8 192-token output cap, which on the processor took 481 s
// (measured 2026-10-18 in the agent shell: first token after 10 s, then about 17 tokens per second).
test('k. with NODE_LLAMA_CPP_GPU=false the model loads on the processor and answers', { timeout: 180000 }, async t => {
  const { worker, folder, model, agentEvents } = await setup(t, undefined, { NODE_LLAMA_CPP_GPU: 'false' });
  assert.equal((await callWorker(worker, 'hardware-info')).backend, 'cpu');
  const entry = await callWorker(worker, 'gguf-add', { path: model });
  await callWorker(worker, 'save-global-settings', { patch: { active_local_model: entry.id } });
  const answered = new Promise<any>(resolve => {
    const listener = (message: any) => {
      if (message?.type !== 'event' || message.event !== 'agent') return;
      if ((message.kind === 'delta' && message.text.trim()) || ['done', 'error', 'stopped'].includes(message.kind)) { worker.off('message', listener); resolve(message); }
    };
    worker.on('message', listener);
  });
  const { runId } = await callWorker(worker, 'send', { folder, branchId: 'main', text: 'Once upon a time' });
  const first = await answered;
  assert.equal(first.kind, 'delta', `the processor answered: ${JSON.stringify(first)}`);
  assert.equal(first.runId, runId);
  const ended = turnEnd(worker, runId);
  await callWorker(worker, 'stop', { runId });
  assert.equal((await ended).kind, 'stopped', JSON.stringify(agentEvents.find(e => e.kind === 'error')));
});

test('l. model-status before any load reports the planned window, not MIN_LOCAL_CONTEXT', { timeout: 30000 }, async t => {
  const { worker, model, root } = await setup(t);
  const patched = await callWorker(worker, 'gguf-add', { path: await patchedModel(root) });
  await callWorker(worker, 'save-global-settings', { patch: { active_local_model: patched.id } });
  const planned = await callWorker(worker, 'model-status', {});
  assert.equal(planned.contextWindow, 32768, 'the 32 768 default, capped by nothing on a model trained for 131 072');
  assert.equal(planned.loaded, false);
  const small = await callWorker(worker, 'gguf-add', { path: model });
  await callWorker(worker, 'save-global-settings', { patch: { active_local_model: small.id } });
  assert.deepEqual(await callWorker(worker, 'model-status', {}), { id: small.id, name: 'stories260K.gguf', missing: false, contextWindow: 16384, loaded: false });
});
