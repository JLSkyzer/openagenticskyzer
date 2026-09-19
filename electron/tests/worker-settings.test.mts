import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
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

async function startWorker(t: any) {
  const home = await mkdtemp(join(tmpdir(), 'openagent-worker-settings-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home },
  });
  t.after(() => worker.terminate());
  return { home, worker };
}

const SECRET = 'hf_SECRET-TEST';

test('save-global-settings persists the HuggingFace token but never sends it back', async t => {
  const { home, worker } = await startWorker(t);

  const saved = await callWorker(worker, 'save-global-settings', { patch: { hf_token: SECRET, animations: false } });
  assert.equal(JSON.stringify(saved).includes(SECRET), false, 'the token must not appear anywhere in the reply');
  assert.equal('hf_token' in saved, false);
  assert.equal(saved.hf_token_configured, true);
  assert.equal(saved.animations, false, 'the other saved keys come back');

  const onDisk = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
  assert.equal(onDisk.hf_token, SECRET, 'the token really is persisted');

  const reread = await callWorker(worker, 'global-settings', {});
  assert.equal(JSON.stringify(reread).includes(SECRET), false);
  assert.equal(reread.hf_token_configured, true);
});

test('the legacy save_settings global path does not leak the token either', async t => {
  const { worker } = await startWorker(t);
  const saved = await callWorker(worker, 'save_settings', { settings: { hf_token: SECRET } });
  assert.equal(JSON.stringify(saved).includes(SECRET), false);
});

test('save-global-settings rejects reserved tokens that do not fit in the context limit', async t => {
  const { worker } = await startWorker(t);
  await assert.rejects(
    callWorker(worker, 'save-global-settings', { patch: { max_tokens: 4096, reserved_tokens: 8192 } }),
    /tokens réservés/,
  );
  const stillDefault = await callWorker(worker, 'global-settings', {});
  assert.equal(stillDefault.max_tokens, null, 'a rejected patch stores nothing');
});
