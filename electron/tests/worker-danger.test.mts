import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm, readFile, stat } from 'node:fs/promises';
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

async function setup(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-danger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home },
  });
  t.after(() => worker.terminate());
  return { home, project, worker };
}

test('clear-history empties every branch of the folder and reports how many messages went', async t => {
  const { project, worker } = await setup(t);
  await callWorker(worker, 'save-messages', {
    folder: project,
    messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }],
  });
  await callWorker(worker, 'fork', { folder: project, source: 'main', count: 2, label: 'essai' });
  assert.equal((await callWorker(worker, 'list-branches', { folder: project })).length, 2);

  const result = await callWorker(worker, 'clear-history', { folder: project });
  assert.equal(result.removed_messages, 4, 'main (2) + the fork copy (2)');

  assert.deepEqual(await callWorker(worker, 'messages', { folder: project, branchId: 'main' }), []);
  const branches = await callWorker(worker, 'list-branches', { folder: project });
  assert.equal(branches.length, 1, 'forks are gone, only the main branch remains');
  assert.equal(branches[0].id, 'main');
  assert.equal(branches[0].message_count, 0);
});

test('clear-history refuses a relative folder', async t => {
  const { worker } = await setup(t);
  await assert.rejects(callWorker(worker, 'clear-history', { folder: 'relatif' }), /absolu/i);
});

test('remove-folder drops the history entry but never touches the files', async t => {
  const { project, worker } = await setup(t);
  await callWorker(worker, 'activate_folder', { folder: project });
  assert.equal((await callWorker(worker, 'list_folders', {})).length, 1);

  const remaining = await callWorker(worker, 'remove-folder', { folder: project });
  assert.deepEqual(remaining, []);
  assert.deepEqual(await callWorker(worker, 'list_folders', {}), []);
  assert.ok((await stat(project)).isDirectory(), 'the project directory is untouched');
});

test('remove-folder on an unknown folder is a harmless no-op', async t => {
  const { project, worker } = await setup(t);
  await callWorker(worker, 'activate_folder', { folder: project });
  const other = join(project, 'jamais-ouvert');
  const remaining = await callWorker(worker, 'remove-folder', { folder: other });
  assert.equal(remaining.length, 1, 'the known folder is still listed');
});

test('reset-global-settings restores every default, secrets included, and returns the public view', async t => {
  const { home, worker } = await setup(t);
  await callWorker(worker, 'save-global-settings', { patch: { theme: 'light', animations: false, hf_token: 'hf_SECRET-TEST' } });

  const reset = await callWorker(worker, 'reset-global-settings', {});
  assert.equal(reset.theme, 'dark');
  assert.equal(reset.animations, true);
  assert.equal(reset.hf_token_configured, false);
  assert.equal(JSON.stringify(reset).includes('hf_SECRET-TEST'), false);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')), {}, 'nothing custom is left on disk');
});
