import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
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

test('worker::migrate-data-dir moves the real settings/folders files to the new directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-datadir-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const newDir = join(root, 'new-data-home');
  await Promise.all([mkdir(home), mkdir(project)]);

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home },
  });
  t.after(() => worker.terminate());

  // Produce some real data first: a saved setting and a recorded folder.
  await callWorker(worker, 'save-global-settings', { patch: { theme: 'light' } });
  await callWorker(worker, 'activate_folder', { folder: project });

  const result = await callWorker(worker, 'migrate-data-dir', { newDir });
  assert.ok(result.moved >= 2, `expected at least config.json and folders.json to move, got ${result.moved}`);
  assert.deepEqual(result.errors, []);

  const config = JSON.parse(await readFile(join(newDir, 'config.json'), 'utf8'));
  assert.equal(config.theme, 'light', 'the real, previously-saved setting made it to the new location');
  const folders = JSON.parse(await readFile(join(newDir, 'folders.json'), 'utf8'));
  assert.equal(folders.length, 1);

  // OPENAGENT_HOME still points at the OLD home for this worker's env, but the migration itself
  // (matching the previous NiceGUI app's own "restart required" contract) does not hot-swap the
  // running worker's services — it only writes the redirect a FUTURE start will pick up.
  const { resolveDataHome } = await import('../core/data-dir.mts');
  assert.equal(await resolveDataHome(home), newDir);
});

test('worker::migrate-data-dir rejects a relative path with the real, precise error', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-datadir-bad-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home);

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home },
  });
  t.after(() => worker.terminate());

  await assert.rejects(callWorker(worker, 'migrate-data-dir', { newDir: 'not-absolute' }), /absolu/);
});
