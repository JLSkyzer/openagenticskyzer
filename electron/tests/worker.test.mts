import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('worker rejects unknown IPC operations instead of exposing a generic command bridge', async t => {
  // Isolated OPENAGENT_HOME: since Tâche 94, a worker with restore_last_folder on (the default)
  // indexes the real last-used folder from folders.json at startup — without this, the test ran
  // against the real developer's ~/.openagent and could trigger a real indexing side effect.
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-unknown-op-'));
  const home = join(root, 'home');
  await mkdir(home);
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  t.after(() => worker.terminate());
  const result = await new Promise<any>(resolve => {
    const listener = (message: any) => { if (message.id === 'x') { worker.off('message', listener); resolve(message); } };
    worker.on('message', listener);
    worker.postMessage({ id: 'x', op: 'shell', payload: { command: 'whoami' } });
  });
  assert.equal(result.ok, false); assert.match(result.error, /inconnue/);
});
