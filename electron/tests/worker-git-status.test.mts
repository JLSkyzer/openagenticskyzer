import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const sh = async (args: string[], cwd: string) => (await run('git', args, { cwd, env: { ...process.env, LC_ALL: 'C' } })).stdout.trim();

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

test('worker::git-status returns the real branch and dirty state of the active project', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-git-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  await Promise.all([mkdir(home), mkdir(repo)]);
  await sh(['init', '-b', 'main'], repo);
  await sh(['config', 'user.name', 'Test'], repo);
  await sh(['config', 'user.email', 'test@example.com'], repo);
  await sh(['config', 'commit.gpgsign', 'false'], repo);
  await writeFile(join(repo, 'README.md'), '# Test\n');
  await sh(['add', 'README.md'], repo);
  await sh(['commit', '-m', 'initial'], repo);

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home },
  });
  t.after(() => worker.terminate());

  const clean = await callWorker(worker, 'git-status', { folder: repo });
  assert.deepEqual(clean, { branch: 'main', dirty: false });

  await writeFile(join(repo, 'README.md'), '# Test\n\nchangé\n');
  const dirty = await callWorker(worker, 'git-status', { folder: repo });
  assert.deepEqual(dirty, { branch: 'main', dirty: true });
});

test('worker::git-status resolves to null (not an error) for a project that is not a git repo', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-git-status-none-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home },
  });
  t.after(() => worker.terminate());

  const result = await callWorker(worker, 'git-status', { folder: project });
  assert.equal(result, null);
});
