import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

test('worker rejects unknown IPC operations instead of exposing a generic command bridge', async t => {
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)));
  t.after(() => worker.terminate());
  const result = await new Promise<any>(resolve => { worker.once('message', resolve); worker.postMessage({ id: 'x', op: 'shell', payload: { command: 'whoami' } }); });
  assert.equal(result.ok, false); assert.match(result.error, /inconnue/);
});
