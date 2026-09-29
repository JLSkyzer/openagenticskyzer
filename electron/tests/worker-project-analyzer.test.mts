import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
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

test('worker::init-project writes a real OPENAGENT.md from a real project scan', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-initproject-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  await writeFile(join(project, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.0.0' } }));
  await writeFile(join(project, 'index.ts'), 'export {};');

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home },
  });
  t.after(() => worker.terminate());

  const result = await callWorker(worker, 'init-project', { folder: project, overwrite: false });
  assert.equal(result.success, true);
  const content = await readFile(join(project, 'OPENAGENT.md'), 'utf8');
  assert.match(content, /TypeScript/);
  assert.match(content, /Vue/);

  const refused = await callWorker(worker, 'init-project', { folder: project, overwrite: false });
  assert.equal(refused.success, false);
  assert.match(refused.message, /existe déjà/);

  const overwritten = await callWorker(worker, 'init-project', { folder: project, overwrite: true });
  assert.equal(overwritten.success, true);
});
