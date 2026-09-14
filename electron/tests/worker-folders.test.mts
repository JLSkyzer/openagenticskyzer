import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function callWorker(worker: Worker, op: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `test-${Math.random()}`;
    const listener = (message: any) => {
      if (message.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}

test('worker::activate_folder records the folder in history and returns it with the chat history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-folders-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);

  // OPENAGENT_HOME keeps this test from ever touching the real developer's
  // ~/.openagent — see worker.mjs.
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home },
  });
  t.after(() => worker.terminate());

  const activated = await callWorker(worker, 'activate_folder', { folder: project });
  assert.deepEqual(activated.history, []);
  assert.equal(activated.folders.length, 1);
  assert.equal(activated.folders[0].name, 'project');

  const listed = await callWorker(worker, 'list_folders', {});
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'project');
});
