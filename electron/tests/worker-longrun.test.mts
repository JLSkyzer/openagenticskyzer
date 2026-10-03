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

function collectAgentEvents(worker: Worker, runId: string) {
  const events: any[] = [];
  const listener = (message: any) => {
    if (message?.type === 'event' && message.event === 'agent' && message.runId === runId) events.push(message);
  };
  worker.on('message', listener);
  return { events, stop: () => worker.off('message', listener) };
}

async function waitUntilDone(events: any[]) {
  while (!events.some(e => ['done', 'error', 'stopped'].includes(e.kind))) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fakeProviderRoot(t: any) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'Réponse rapide.' }, finish_reason: 'stop' }] }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  const port = (server.address() as { port: number }).port;
  return { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' };
}

test('a real turn finishing above OPENAGENT_LONG_RUN_MS is flagged longRunning with a summary', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-longrun-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const connection = await fakeProviderRoot(t);

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    // 1ms threshold: even this fast, fully real (not mocked) HTTP round-trip clears it.
    env: { ...process.env, OPENAGENT_HOME: home, OPENAGENT_LONG_RUN_MS: '1' },
  });
  terminateAtEnd(t, worker);

  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'bonjour', connection });
  const { events, stop } = collectAgentEvents(worker, runId);
  await waitUntilDone(events);
  stop();

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
  const connection = await fakeProviderRoot(t);

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home },
  });
  terminateAtEnd(t, worker);

  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'bonjour', connection });
  const { events, stop } = collectAgentEvents(worker, runId);
  await waitUntilDone(events);
  stop();

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
  const connection = { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' };

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home, OPENAGENT_LONG_RUN_MS: '1' },
  });
  terminateAtEnd(t, worker);

  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'bonjour', connection });
  await providerCalled;
  await callWorker(worker, 'stop', { runId });

  const { events, stop } = collectAgentEvents(worker, runId);
  await waitUntilDone(events);
  stop();
  const stopped = events.find(e => e.kind === 'stopped');
  assert.ok(stopped);
  assert.equal(stopped.longRunning, undefined);
});
