import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';

function callWorker(worker: Worker, op: string, payload?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `local-${Math.random()}`;
    const listener = (message: any) => {
      if (message.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}
async function waitDone(worker: Worker, runId: string, events: any[] = []) {
  await new Promise<void>(resolve => {
    const listener = (message: any) => {
      if (message?.type === 'event' && message.runId === runId) {
        events.push(message);
        if (['done', 'error', 'stopped'].includes(message.kind)) { worker.off('message', listener); resolve(); }
      }
    };
    worker.on('message', listener);
  });
}

async function setup(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-local-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const folder = join(root, 'projet');
  await Promise.all([mkdir(home), mkdir(folder)]);
  const model = join(root, 'stories260K.gguf');
  await copyFile(fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url)), model);
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);
  const entry = await callWorker(worker, 'gguf-add', { path: model });
  return { worker, folder, entry };
}

test('worker::send with `localModel` runs a real turn on the real .gguf, WITHOUT any connection at all, and saves it', { timeout: 180000 }, async t => {
  const { worker, folder, entry } = await setup(t);
  const { runId } = await callWorker(worker, 'send', { folder, branchId: 'main', text: 'Once upon a time', localModel: entry.id });
  const events: any[] = [];
  await waitDone(worker, runId, events);
  assert.equal(events.at(-1).kind, 'done', JSON.stringify(events.find(e => e.kind === 'error')));
  const saved = await callWorker(worker, 'messages', { folder, branchId: 'main' });
  assert.equal(saved[0].content, 'Once upon a time');
  assert.equal(saved[1].role, 'assistant');
  assert.ok(saved[1].content.length > 0, 'the real local model produced real text');
  assert.ok(saved[1].content.endsWith('[Réponse tronquée : limite de sortie atteinte]'), 'the toy model is stopped by the output cap: the saved reply says so');
  assert.equal(Object.hasOwn(saved[1], 'truncated'), false, 'the flag itself is never saved');
});

test('worker::send refuses an unknown/removed `localModel` id BEFORE anything starts — no run, nothing saved', { timeout: 20000 }, async t => {
  const { worker, folder, entry } = await setup(t);
  await callWorker(worker, 'gguf-remove', { id: entry.id });
  await assert.rejects(callWorker(worker, 'send', { folder, branchId: 'main', text: 'x', localModel: entry.id }), /introuvable/i);
  assert.deepEqual(await callWorker(worker, 'messages', { folder, branchId: 'main' }), []);
});

// The fixture is a toy model that never emits an end token: its summary always runs into the 8192-token output
// cap, which the engine reports as stopReason "maxTokens". compactMessages refuses a summary cut that way, so
// this is the end-to-end proof that (1) compaction really runs on the local engine, and (2) its truncation flag
// reaches the guard: the conversation is left untouched instead of losing its head to half a summary.
test('worker::compact with `localModel` really calls the local engine (not a remote provider); a summary cut at the output cap is refused and the transcript kept', { timeout: 180000 }, async t => {
  const { worker, folder, entry } = await setup(t);
  const history = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `message ${i}` }));
  await callWorker(worker, 'save-messages', { folder, branchId: 'main', messages: history });
  const { compactionId } = await callWorker(worker, 'compact', { folder, branchId: 'main', localModel: entry.id });
  const events: any[] = [];
  await new Promise<void>(resolve => {
    const listener = (message: any) => {
      if (message?.type === 'event' && message.runId === compactionId) { events.push(message); if (['compacted', 'compact-failed'].includes(message.kind)) { worker.off('message', listener); resolve(); } }
    };
    worker.on('message', listener);
  });
  assert.equal(events.at(-1).kind, 'compact-failed', JSON.stringify(events.at(-1)));
  assert.match(events.at(-1).message, /tronqué/);
  assert.deepEqual(await callWorker(worker, 'messages', { folder, branchId: 'main' }), history);
});
