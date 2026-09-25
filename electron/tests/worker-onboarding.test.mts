import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function callWorker(worker: Worker, op: string, payload?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `onb-${Math.random()}`;
    const listener = (message: any) => {
      if (message.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}

async function setup(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-onboarding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home);
  // A machine running the tests may have the neutralising variable set: every case sets it itself.
  const { OPENAGENT_SKIP_ONBOARDING: _ignored, ...inherited } = process.env;
  const start = (skip: boolean) => {
    const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
      env: { ...inherited, OPENAGENT_HOME: home, ...(skip ? { OPENAGENT_SKIP_ONBOARDING: '1' } : {}) },
    });
    t.after(() => worker.terminate());
    return worker;
  };
  return { start };
}

test('a fresh data directory has not completed the wizard', async t => {
  const { start } = await setup(t);
  assert.equal((await callWorker(start(false), 'global-settings')).onboarding_done, false);
});

test('completing the wizard is saved for good: a new process still reads it as done', async t => {
  const { start } = await setup(t);
  const first = start(false);
  const saved = await callWorker(first, 'save-global-settings', { patch: { onboarding_done: true } });
  assert.equal(saved.onboarding_done, true);
  await first.terminate();
  assert.equal((await callWorker(start(false), 'global-settings')).onboarding_done, true);
});

test('resetting the global settings brings the wizard back (as Python re-read the config)', async t => {
  const { start } = await setup(t);
  const worker = start(false);
  await callWorker(worker, 'save-global-settings', { patch: { onboarding_done: true } });
  await callWorker(worker, 'reset-global-settings');
  assert.equal((await callWorker(worker, 'global-settings')).onboarding_done, false);
});

test('OPENAGENT_SKIP_ONBOARDING=1 reports the wizard as done WITHOUT writing anything', async t => {
  const { start } = await setup(t);
  assert.equal((await callWorker(start(true), 'global-settings')).onboarding_done, true);
  assert.equal((await callWorker(start(false), 'global-settings')).onboarding_done, false, 'nothing was saved by the skip');
});

test('the skip variable only ever means "done": any other value is ignored', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-onboarding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home);
  for (const value of ['0', 'false', '', 'yes']) {
    const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home, OPENAGENT_SKIP_ONBOARDING: value } });
    t.after(() => worker.terminate());
    assert.equal((await callWorker(worker, 'global-settings')).onboarding_done, false, `value ${JSON.stringify(value)}`);
  }
});
