import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

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
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('worker::send runs a real agent turn: streams events, executes create_file, and persists the transcript', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-send-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);

  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount++;
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      if (requestCount === 1) {
        response.end(JSON.stringify({
          choices: [{
            message: { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'create_file', arguments: JSON.stringify({ path: 'notes.md', content: 'salut' }) } }] },
            finish_reason: 'tool_calls',
          }],
        }));
      } else {
        response.end(JSON.stringify({ choices: [{ message: { content: 'Fichier créé.' }, finish_reason: 'stop' }] }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  const port = (server.address() as { port: number }).port;

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home },
  });
  t.after(() => worker.terminate());

  const connection = { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' };
  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'crée un fichier notes.md', connection });
  assert.match(runId, /.+/);

  const { events, stop } = collectAgentEvents(worker, runId);
  await waitUntilDone(events);
  stop();

  const kinds = events.map(e => e.kind);
  assert.equal(kinds.at(-1), 'done', `expected the run to finish with 'done', got: ${kinds.join(',')}`);
  const toolStart = events.find(e => e.kind === 'tool-start');
  assert.ok(toolStart, 'a tool-start event was emitted');
  assert.equal(toolStart.tool, 'create_file');
  assert.equal(toolStart.category, 'write', 'the worker enriches tool-start with the real tool category');

  const created = await readFile(join(project, 'notes.md'), 'utf8');
  assert.equal(created, 'salut', 'the tool actually wrote the file on disk');

  const persisted = await callWorker(worker, 'messages', { folder: project, branchId: 'main' });
  assert.equal(persisted.at(-1).content, 'Fichier créé.');
  assert.ok(persisted.some((m: any) => m.role === 'tool'), 'the tool result message was persisted');
  assert.equal(persisted[0].role, 'user');
});

test('worker::send persists whatever was produced so far when the run is stopped mid-turn', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-send-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);

  let started!: () => void;
  const providerCalled = new Promise<void>(resolve => { started = resolve; });
  const server = createServer((_request, response) => {
    started();
    // Never respond — the test will abort before this matters.
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  const port = (server.address() as { port: number }).port;

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home },
  });
  t.after(() => worker.terminate());

  const connection = { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' };
  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'bonjour', connection });
  const { events, stop } = collectAgentEvents(worker, runId);
  await providerCalled;
  await callWorker(worker, 'stop', { runId });
  await waitUntilDone(events);
  stop();

  assert.equal(events.at(-1).kind, 'stopped');
  const persisted = await callWorker(worker, 'messages', { folder: project, branchId: 'main' });
  assert.deepEqual(persisted.map((m: any) => m.content), ['bonjour'], 'the user message survives even though the model never answered');
});
