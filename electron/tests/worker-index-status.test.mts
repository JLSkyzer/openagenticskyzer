import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function callWorker(worker: Worker, op: string, payload: unknown = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `idx-${Math.random()}`;
    const listener = (message: any) => {
      if (message.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}

async function untilReady(worker: Worker, folder: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await callWorker(worker, 'index-status', { folder });
    if (status.state === 'ready' || status.state === 'error') return status;
    if (Date.now() > deadline) throw new Error(`timed out waiting for index-status, last: ${JSON.stringify(status)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('activate_folder triggers real automatic indexing, observable through index-status', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-index-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  await writeFile(join(project, 'a.py'), 'def a():\n    return 1\n');

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  t.after(() => worker.terminate());

  assert.deepEqual(await callWorker(worker, 'index-status', { folder: project }), { state: 'idle' });
  await callWorker(worker, 'activate_folder', { folder: project });
  const status = await untilReady(worker, project);
  assert.equal(status.state, 'ready', JSON.stringify(status));

  const { storePath } = await import('../core/semantic-index.mts');
  await access(await storePath(project)); // the real store was really written to disk
});

test('worker startup indexes the last-used folder automatically when restore_last_folder is on', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-index-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  await writeFile(join(project, 'a.py'), 'def a():\n    return 1\n');

  const first = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  await callWorker(first, 'activate_folder', { folder: project });
  await untilReady(first, project);
  await first.terminate();

  // A fresh worker on the SAME home, restore_last_folder still at its default (true) — must
  // index the last-used folder on its own, with no activate_folder call at all this time.
  const second = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  t.after(() => second.terminate());
  const status = await untilReady(second, project);
  assert.equal(status.state, 'ready', JSON.stringify(status));
});

test('worker startup does NOT index anything when restore_last_folder is off', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-index-norestore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  await writeFile(join(project, 'a.py'), 'def a():\n    return 1\n');

  const first = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  await callWorker(first, 'activate_folder', { folder: project });
  await untilReady(first, project);
  await callWorker(first, 'save-global-settings', { patch: { restore_last_folder: false } });
  await first.terminate();

  const { storePath } = await import('../core/semantic-index.mts');
  await rm(await storePath(project), { force: true }); // clear the store the first worker already built

  const second = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  t.after(() => second.terminate());
  await new Promise(resolve => setTimeout(resolve, 500)); // give a real (wrongly) triggered index a chance to start
  assert.deepEqual(await callWorker(second, 'index-status', { folder: project }), { state: 'idle' });
  await assert.rejects(access(await storePath(project)), 'the store must never have been rebuilt');
});

test('index-status for a folder that was never activated is idle, not an error', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-index-idle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home);
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  t.after(() => worker.terminate());

  assert.deepEqual(await callWorker(worker, 'index-status', { folder: join(root, 'never-touched') }), { state: 'idle' });
});
