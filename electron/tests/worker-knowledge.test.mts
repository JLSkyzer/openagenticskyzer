import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function callWorker(worker: Worker, op: string, payload: unknown = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `kb-${Math.random()}`;
    const listener = (message: any) => {
      if (message.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}

test('worker::knowledge-list/add/remove manage the real global knowledge base through the real worker', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-knowledge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home);
  const filePath = join(root, 'notes.md');
  await writeFile(filePath, '# Notes\n\nUn vrai fichier ajouté via le vrai worker.');

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  t.after(() => worker.terminate());

  assert.deepEqual(await callWorker(worker, 'knowledge-list'), []);
  const added = await callWorker(worker, 'knowledge-add', { filePath });
  assert.equal(added.source, 'notes.md');
  assert.ok(added.chunks >= 1);
  assert.deepEqual(await callWorker(worker, 'knowledge-list'), ['notes.md']);

  await callWorker(worker, 'knowledge-remove', { source: 'notes.md' });
  assert.deepEqual(await callWorker(worker, 'knowledge-list'), []);
});

test('worker::knowledge-add refuses a non .txt/.md file, with no partial write', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-knowledge-reject-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home);
  const filePath = join(root, 'binaire.exe');
  await writeFile(filePath, 'peu importe');

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  t.after(() => worker.terminate());

  await assert.rejects(callWorker(worker, 'knowledge-add', { filePath }));
  assert.deepEqual(await callWorker(worker, 'knowledge-list'), []);
});
