import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';
import { testWorkerOptions } from './support/test-model-provider.mts';
import { callWorker, recordAgentEvents } from './support/worker-events.mts';

async function fakeProviderRoot(t: any) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'Réponse rapide.' }, finish_reason: 'stop' }] }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  const port = (server.address() as { port: number }).port;
  return { base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model' };
}

test('a real turn finishing above OPENAGENT_LONG_RUN_MS is flagged longRunning with a summary', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-longrun-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const testModel = await fakeProviderRoot(t);

  // 1ms threshold: even this fast, fully real (not mocked) HTTP round-trip clears it.
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), testWorkerOptions(home, { OPENAGENT_LONG_RUN_MS: '1' }));
  terminateAtEnd(t, worker);

  const rec = recordAgentEvents(worker);
  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'bonjour', testModel });
  const events = await rec.until(runId);
  rec.stop();

  const done = events.find(e => e.kind === 'done');
  assert.ok(done, 'the turn completed');
  assert.equal(done.longRunning, true);
  assert.equal(done.summary, 'Réponse rapide.');
  assert.ok(typeof done.durationMs === 'number' && done.durationMs >= 0);
});

test('the same fast turn is NOT flagged longRunning under the real 10s default threshold', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-longrun-default-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const testModel = await fakeProviderRoot(t);

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), testWorkerOptions(home));
  terminateAtEnd(t, worker);

  const rec = recordAgentEvents(worker);
  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'bonjour', testModel });
  const events = await rec.until(runId);
  rec.stop();

  const done = events.find(e => e.kind === 'done');
  assert.ok(done);
  assert.equal(done.longRunning, undefined, 'a normal fast turn never carries the flag');
});

test('a Stop is never flagged longRunning, even past the threshold — the user is already at the app', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-longrun-stop-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);

  let started!: () => void;
  const providerCalled = new Promise<void>(resolve => { started = resolve; });
  const server = createServer(() => { started(); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  const port = (server.address() as { port: number }).port;
  const testModel = { base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model' };

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), testWorkerOptions(home, { OPENAGENT_LONG_RUN_MS: '1' }));
  terminateAtEnd(t, worker);

  const rec = recordAgentEvents(worker);
  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'bonjour', testModel });
  await providerCalled;
  await callWorker(worker, 'stop', { runId });

  const events = await rec.until(runId);
  rec.stop();
  const stopped = events.find(e => e.kind === 'stopped');
  assert.ok(stopped);
  assert.equal(stopped.longRunning, undefined);
});
