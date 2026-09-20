import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';

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

/** A fake model that answers "réponse N" to each request; a request can be held open until released. */
async function fakeModel(t: { after(fn: () => unknown): void }) {
  let count = 0;
  const held: Array<{ response: ServerResponse; answer: () => void }> = [];
  let hold = false;
  let onHeld: (() => void) | null = null;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const n = ++count;
      const answer = () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: `réponse ${n}` }, finish_reason: 'stop' }] }));
      };
      if (hold) { held.push({ response, answer }); onHeld?.(); } else answer();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { for (const h of held) h.response.destroy(); server.close(() => resolve(undefined)); }));
  const port = (server.address() as { port: number }).port;
  return {
    connection: { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' },
    holdNext() { hold = true; return new Promise<void>(resolve => { onHeld = resolve; }); },
    release() { hold = false; for (const h of held.splice(0)) h.answer(); },
  };
}

async function setup(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-branches-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home },
  });
  t.after(() => worker.terminate());
  const model = await fakeModel(t);
  const turn = async (branchId: string, text: string) => {
    const { runId } = await callWorker(worker, 'send', { folder: project, branchId, text, connection: model.connection });
    const { events, stop } = collectAgentEvents(worker, runId);
    await waitUntilDone(events);
    stop();
    assert.equal(events.at(-1).kind, 'done', `run failed: ${JSON.stringify(events.at(-1))}`);
  };
  return { worker, root, project, model, turn };
}

test('worker::fork copies up to and including the clicked message, and sending on the fork never touches main', async t => {
  const { worker, project, turn } = await setup(t);
  await turn('main', 'premier');
  await turn('main', 'second');
  const mainBefore = await callWorker(worker, 'messages', { folder: project, branchId: 'main' });
  assert.deepEqual(mainBefore.map((m: any) => m.content), ['premier', 'réponse 1', 'second', 'réponse 2']);

  // Forking from the 1st user message (index 0) keeps exactly that message: count = index + 1.
  const fork = await callWorker(worker, 'fork', { folder: project, source: 'main', count: 1, label: 'Branche 1' });
  assert.equal(fork.label, 'Branche 1');
  assert.deepEqual((await callWorker(worker, 'messages', { folder: project, branchId: fork.id })).map((m: any) => m.content), ['premier']);

  await turn(fork.id, 'autre piste');
  const onFork = await callWorker(worker, 'messages', { folder: project, branchId: fork.id });
  assert.deepEqual(onFork.map((m: any) => m.content), ['premier', 'autre piste', 'réponse 3']);
  const mainAfter = await callWorker(worker, 'messages', { folder: project, branchId: 'main' });
  assert.deepEqual(mainAfter, mainBefore, 'a turn on a fork never writes into main');

  const branches = await callWorker(worker, 'list-branches', { folder: project });
  assert.deepEqual(branches.map((b: any) => [b.id === 'main' ? 'main' : b.label, b.message_count]), [['main', 4], ['Branche 1', 3]]);
});

test('worker::fork can be nested: a fork of a fork copies the parent view', async t => {
  const { worker, project, turn } = await setup(t);
  await turn('main', 'un');
  const a = await callWorker(worker, 'fork', { folder: project, source: 'main', count: 1, label: 'Branche 1' });
  await turn(a.id, 'deux');
  // The parent view is ['un', 'deux', 'réponse 2']: cutting after 'deux' (index 1) means count 2.
  const b = await callWorker(worker, 'fork', { folder: project, source: a.id, count: 2, label: 'Branche 2' });
  assert.deepEqual((await callWorker(worker, 'messages', { folder: project, branchId: b.id })).map((m: any) => m.content), ['un', 'deux']);
});

test('worker::fork is refused while a run is in flight on that folder, and accepted once it ended', async t => {
  const { worker, project, model, turn } = await setup(t);
  await turn('main', 'un');
  const held = model.holdNext();
  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'deux', connection: model.connection });
  const { events, stop } = collectAgentEvents(worker, runId);
  await held;

  // The transcript on disk is only complete at the end of the run: forking now would cut at a stale index.
  await assert.rejects(callWorker(worker, 'fork', { folder: project, source: 'main', count: 1, label: 'Trop tôt' }), /en cours/);
  assert.equal((await callWorker(worker, 'list-branches', { folder: project })).length, 1, 'the refused fork created nothing');

  model.release();
  await waitUntilDone(events);
  stop();
  const fork = await callWorker(worker, 'fork', { folder: project, source: 'main', count: 1, label: 'Après' });
  assert.equal(fork.label, 'Après');
});

test('worker::fork is only refused for the folder that is running, not for another one', async t => {
  const { worker, root, project, model, turn } = await setup(t);
  await turn('main', 'un');
  const other = join(root, 'autre');
  await mkdir(other);
  const held = model.holdNext();
  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'deux', connection: model.connection });
  const { events, stop } = collectAgentEvents(worker, runId);
  await held;
  await callWorker(worker, 'save-messages', { folder: other, branchId: 'main', messages: [{ role: 'user', content: 'x' }] });
  const fork = await callWorker(worker, 'fork', { folder: other, source: 'main', count: 1, label: 'Ailleurs' });
  assert.equal(fork.label, 'Ailleurs');
  model.release();
  await waitUntilDone(events);
  stop();
});
