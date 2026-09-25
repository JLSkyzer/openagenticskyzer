import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

function callWorker(worker: Worker, op: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `keep-${Math.random()}`;
    const listener = (message: any) => {
      if (message.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}

async function waitDone(worker: Worker, runId: string) {
  await new Promise<void>(resolve => {
    const listener = (message: any) => {
      if (message?.type === 'event' && message.runId === runId && ['done', 'error', 'stopped'].includes(message.kind)) {
        worker.off('message', listener);
        resolve();
      }
    };
    worker.on('message', listener);
  });
}

const HISTORY = [
  { role: 'user', content: 'premier' },
  { role: 'assistant', content: 'réponse 1' },
  { role: 'user', content: 'second' },
  { role: 'assistant', content: 'réponse 2' },
];

async function setup(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-keep-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const folder = join(root, 'projet');
  await Promise.all([mkdir(home), mkdir(folder)]);
  const seen: any[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      seen.push(JSON.parse(raw));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'nouvelle réponse' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  const port = (server.address() as { port: number }).port;
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  t.after(() => worker.terminate());
  await callWorker(worker, 'save-messages', { folder, branchId: 'main', messages: HISTORY });
  const connection = { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'm', api_key: 'fake' };
  return { worker, folder, connection, seen };
}

test('worker::send with `keep` cuts the saved history there before the turn: the model never sees the cut part', async t => {
  const { worker, folder, connection, seen } = await setup(t);
  const { runId } = await callWorker(worker, 'send', { folder, branchId: 'main', text: 'second (édité)', keep: 2, connection });
  await waitDone(worker, runId);
  const sent = JSON.stringify(seen[0].messages);
  assert.equal(sent.includes('réponse 2'), false, 'the cut assistant reply was not sent to the model');
  assert.equal(sent.includes('"second"'), false, 'the cut user message was not sent to the model');
  assert.equal(sent.includes('réponse 1'), true, 'what was kept is still sent');
  const saved = await callWorker(worker, 'messages', { folder, branchId: 'main' });
  assert.deepEqual(saved.map((m: any) => [m.role, m.content]), [
    ['user', 'premier'], ['assistant', 'réponse 1'], ['user', 'second (édité)'], ['assistant', 'nouvelle réponse'],
  ]);
});

test('worker::send with keep = 0 starts the conversation over (editing the very first message)', async t => {
  const { worker, folder, connection } = await setup(t);
  const { runId } = await callWorker(worker, 'send', { folder, branchId: 'main', text: 'autre début', keep: 0, connection });
  await waitDone(worker, runId);
  const saved = await callWorker(worker, 'messages', { folder, branchId: 'main' });
  assert.deepEqual(saved.map((m: any) => m.content), ['autre début', 'nouvelle réponse']);
});

test('worker::send refuses a `keep` longer than what is saved, and loses nothing', async t => {
  const { worker, folder, connection, seen } = await setup(t);
  await assert.rejects(callWorker(worker, 'send', { folder, branchId: 'main', text: 'x', keep: 9, connection }), /plus court|enregistr/i);
  assert.equal(seen.length, 0, 'no turn was started');
  const saved = await callWorker(worker, 'messages', { folder, branchId: 'main' });
  assert.equal(saved.length, HISTORY.length, 'the saved history is untouched');
});

test('worker::send refuses a `keep` that is not a non-negative integer', async t => {
  const { worker, folder, connection } = await setup(t);
  for (const keep of [-1, 1.5, '2', null]) {
    await assert.rejects(callWorker(worker, 'send', { folder, branchId: 'main', text: 'x', keep, connection }), /keep|invalide/i, `keep=${JSON.stringify(keep)}`);
  }
});

test('worker::send without `keep` behaves as before: the turn is appended', async t => {
  const { worker, folder, connection } = await setup(t);
  const { runId } = await callWorker(worker, 'send', { folder, branchId: 'main', text: 'suite', connection });
  await waitDone(worker, runId);
  const saved = await callWorker(worker, 'messages', { folder, branchId: 'main' });
  assert.equal(saved.length, HISTORY.length + 2);
});
