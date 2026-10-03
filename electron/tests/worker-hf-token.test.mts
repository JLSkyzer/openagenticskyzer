import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';

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

async function fakeHf(t: any, handler: (request: any, response: any) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}/api/whoami-v2`;
}

test('worker::test-hf-token round-trips a real request to a valid token', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-hftoken-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  await mkdir(home);
  const endpoint = await fakeHf(t, (request, response) => {
    response.writeHead(request.headers.authorization === 'Bearer hf_good' ? 200 : 401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ name: 'killian-dev' }));
  });

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home, OPENAGENT_HF_ENDPOINT: endpoint },
  });
  terminateAtEnd(t, worker);

  const result = await callWorker(worker, 'test-hf-token', { token: 'hf_good' });
  assert.deepEqual(result, { name: 'killian-dev' });
});

test('worker::test-hf-token rejects a bad token with the real error, not a generic one', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-hftoken-bad-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  await mkdir(home);
  const endpoint = await fakeHf(t, (_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'bad token' }));
  });

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home, OPENAGENT_HF_ENDPOINT: endpoint },
  });
  terminateAtEnd(t, worker);

  await assert.rejects(callWorker(worker, 'test-hf-token', { token: 'hf_bad' }), /401/);
});
