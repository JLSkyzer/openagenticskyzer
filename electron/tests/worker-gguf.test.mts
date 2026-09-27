import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function callWorker(worker: Worker, op: string, payload?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `gguf-${Math.random()}`;
    const listener = (message: any) => {
      if (message.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}

test('worker::gguf-add/gguf-list/gguf-remove manage the real library on disk through the ops main.cjs routes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-gguf-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const model = join(root, 'model.gguf');
  await Promise.all([mkdir(home), writeFile(model, Buffer.alloc(4096))]);
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  t.after(() => worker.terminate());

  assert.deepEqual(await callWorker(worker, 'gguf-list'), []);
  const added = await callWorker(worker, 'gguf-add', { path: model });
  assert.equal(added.name, 'model.gguf');
  assert.equal(added.size_bytes, 4096);
  assert.deepEqual((await callWorker(worker, 'gguf-list')).map((e: any) => e.id), [added.id]);
  await assert.rejects(callWorker(worker, 'gguf-add', { path: join(root, 'absent.gguf') }), /introuvable/i);
  const after = await callWorker(worker, 'gguf-remove', { id: added.id });
  assert.deepEqual(after, []);
});
