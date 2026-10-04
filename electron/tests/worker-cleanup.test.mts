import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';
import { expectedArchive } from './fs-helpers.mts';

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

function daysAgo(n: number) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

test('worker startup ARCHIVES (never deletes) the conversation data of a project unused beyond the configured retention', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-cleanup-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const old = join(root, 'old-project');
  await Promise.all([mkdir(home), mkdir(old)]);
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: old, last_used: daysAgo(400) }], null, 2));
  await mkdir(join(old, '.openagent'), { recursive: true });
  await writeFile(join(old, '.openagent', 'conversations.json'), JSON.stringify({ version: 1, branches: [{ id: 'main', label: 'Principale', messages: [{ role: 'user', content: 'vieux message' }], created_at: new Date().toISOString() }] }, null, 2));
  const original = await readFile(join(old, '.openagent', 'conversations.json'));

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home },
  });
  terminateAtEnd(t, worker);

  // The default retention is 30 days; a real op round-trip proves the worker has finished its
  // (awaited) startup cleanup before answering.
  const list = await callWorker(worker, 'list_folders', {});
  assert.equal(list.length, 1, 'the folder history entry itself must survive the cleanup');
  await assert.rejects(readFile(join(old, '.openagent', 'conversations.json')), /ENOENT/);
  const archived = join(await expectedArchive(home, old, new Date()), 'conversations.json');
  assert.deepEqual(await readFile(archived), original, 'moved into the archive of the data home, byte for byte');
});

test('worker startup leaves conversation data alone when session_retention_days is 0', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-cleanup-off-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const old = join(root, 'old-project');
  await Promise.all([mkdir(home), mkdir(old)]);
  await writeFile(join(home, 'config.json'), JSON.stringify({ session_retention_days: 0 }, null, 2));
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: old, last_used: daysAgo(4000) }], null, 2));
  await mkdir(join(old, '.openagent'), { recursive: true });
  await writeFile(join(old, '.openagent', 'conversations.json'), JSON.stringify({ version: 1, branches: [{ id: 'main', label: 'Principale', messages: [{ role: 'user', content: 'toujours là' }], created_at: new Date().toISOString() }] }, null, 2));

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home },
  });
  terminateAtEnd(t, worker);

  await callWorker(worker, 'list_folders', {});
  await assert.doesNotReject(readFile(join(old, '.openagent', 'conversations.json')));
});
