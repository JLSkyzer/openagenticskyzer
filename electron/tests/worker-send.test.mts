import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
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
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('worker::send runs a real agent turn: streams events, executes create_file, and persists the transcript', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-send-'));
  removeAtEnd(t, root);
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
  terminateAtEnd(t, worker);

  // This test is about the turn itself; the write prompt (asked by default since 2026-10-03) is
  // tested in worker-tools.test.mts. The user's own saved choice is respected.
  await callWorker(worker, 'save-global-settings', { patch: { files_ask: false } });
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
  removeAtEnd(t, root);
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
  terminateAtEnd(t, worker);

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

// The renderer shows the user message as soon as the send is accepted (send-started). A failure while the tools or
// the instructions are being read must leave the file holding that message too: edit and regenerate cut the file
// at a SCREEN index, so a file one message behind would be cut at the wrong place.
async function earlyFailureSetup(t: any, prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const server = createServer((request, response) => {
    request.on('data', () => {});
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'salut' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  const port = (server.address() as { port: number }).port;
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);
  const connection = { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' };
  const send = async (text: string, keep?: number) => {
    const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text, connection, ...(keep === undefined ? {} : { keep }) });
    const { events, stop } = collectAgentEvents(worker, runId);
    await waitUntilDone(events);
    stop();
    return events;
  };
  // A real conversation, saved by two real turns.
  assert.equal((await send('bonjour')).at(-1).kind, 'done');
  assert.equal((await send('deux')).at(-1).kind, 'done');
  return { worker, project, send, file: join(project, '.openagent', 'conversations.json') };
}

test('worker::send saves the user message when the turn fails while its tools or instructions are read', async t => {
  const { worker, project, send, file } = await earlyFailureSetup(t, 'openagent-worker-send-early-');
  // The project's own settings become unreadable: reading the turn's tools and settings fails for real.
  await writeFile(join(project, '.openagent', 'config.json'), "{ ceci n'est pas du JSON");
  const events = await send('encore');
  const last = events.at(-1);
  assert.equal(last.kind, 'error', 'the failure is reported');
  assert.match(last.message, /JSON illisible/);
  const persisted = await callWorker(worker, 'messages', { folder: project, branchId: 'main' });
  assert.deepEqual(persisted.map((m: any) => m.content), ['bonjour', 'salut', 'deux', 'salut', 'encore'], 'the file ends with the user message, like the screen');
  // An edit of « deux » (screen index 2): the file is cut at the same place as the screen, then gets the new text.
  const edited = await send('deux bis', 2);
  assert.equal(edited.at(-1).kind, 'error');
  const afterEdit = await callWorker(worker, 'messages', { folder: project, branchId: 'main' });
  assert.deepEqual(afterEdit.map((m: any) => m.content), ['bonjour', 'salut', 'deux bis'], 'never emptied, cut where the screen was cut');
  assert.ok((await readFile(file, 'utf8')).includes('deux bis'));
});

test('worker::send never rewrites a conversation file it could not read', async t => {
  const { send, file } = await earlyFailureSetup(t, 'openagent-worker-send-unreadable-');
  // The conversation file itself is unreadable: it was kept on purpose, nothing may overwrite it.
  await writeFile(file, '{ "version": 1, "branches": [ coupé');
  const before = await readFile(file);
  const events = await send('encore');
  assert.equal(events.at(-1).kind, 'error', 'the failure is reported');
  assert.match(events.at(-1).message, /JSON illisible/);
  assert.deepEqual(await readFile(file), before, 'the unreadable conversation file is byte-identical');
});

// M3 through the real worker: the window is the user's max_tokens (H3), the cap mistral's 16 384 (H1); the
// max_tokens sent is what the window leaves after the request the provider really received.
test('worker::send asks for no more output than the window leaves beside the real request', async t => {
  const { estimateRequestTokens } = await import('../core/request-context.mts');
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-send-cap-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const bodies: any[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      bodies.push(JSON.parse(raw));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'salut' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  const port = (server.address() as { port: number }).port;
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);
  await callWorker(worker, 'save-global-settings', { patch: { max_tokens: 8000 } });
  const connection = { provider: 'mistral', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' };
  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'bonjour', connection });
  const { events, stop } = collectAgentEvents(worker, runId);
  await waitUntilDone(events);
  stop();
  assert.equal(events.at(-1).kind, 'done');
  const [body] = bodies;
  const estimate = estimateRequestTokens(body.messages[0].content, body.tools ?? [], body.messages.slice(1));
  assert.ok(estimate > 1000, `the real system prompt and tool schemas weigh something (${estimate} tokens)`);
  assert.equal(body.max_tokens, 8000 - estimate, 'the 16 384 cap lowered to the room left in the 8 000-token window');
});
