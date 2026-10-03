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

/** Resolves with the first 'index' event that ends the background indexing of `folder` (ready or error). */
function indexingSettled(worker: Worker, folder: string): Promise<any> {
  return new Promise(resolve => {
    const listener = (message: any) => {
      if (message.type !== 'event' || message.event !== 'index' || message.folder !== folder) return;
      if (message.state !== 'ready' && message.state !== 'error') return;
      worker.off('message', listener);
      resolve(message);
    };
    worker.on('message', listener);
  });
}

test('worker::activate_folder records the folder in history and returns it with the chat history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-folders-'));
  let worker: Worker | undefined;
  // One hook, worker first: after-hooks run in registration order and a throwing one skips the
  // rest, so a separate rm hook that failed (ENOTEMPTY while the worker was still writing the
  // index into project/.openagent) left the worker alive and the whole test run never exited.
  t.after(async () => {
    try { await worker?.terminate(); } finally { await rm(root, { recursive: true, force: true }); }
  });
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);

  // OPENAGENT_HOME keeps this test from ever touching the real developer's
  // ~/.openagent — see worker.mjs.
  worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home },
  });

  // activate_folder also starts indexing the folder in the background (it writes
  // project/.openagent/index/codebase.json after replying): wait for it to end, so nothing
  // still writes into the temp dir when the test cleans it up.
  const indexed = indexingSettled(worker, project);
  const activated = await callWorker(worker, 'activate_folder', { folder: project });
  assert.deepEqual(activated.history, []);
  assert.equal(activated.folders.length, 1);
  assert.equal(activated.folders[0].name, 'project');

  const listed = await callWorker(worker, 'list_folders', {});
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'project');

  assert.equal((await indexed).state, 'ready');
});
