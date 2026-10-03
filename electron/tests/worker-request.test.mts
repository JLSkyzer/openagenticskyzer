import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function callWorker(worker: Worker, op: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `req-${Math.random()}`;
    const listener = (message: any) => {
      if (message.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}
async function until(check: () => boolean, what: string, timeout = 15000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
const finished = (events: any[]) => events.some(e => ['done', 'error', 'stopped'].includes(e.kind));

type Reply = (response: ServerResponse) => void;
const json = (body: unknown): Reply => response => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};
const answer = (content: string) => json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
const call = (id: string, name: string, args: Record<string, unknown>) =>
  json({ choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });

/** A real worker on an isolated data home, and a real model server that answers request N with replies[N]. */
async function setup(t: any, replies: Reply[], env: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-request-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const bodies: any[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      bodies.push(JSON.parse(raw));
      (replies[bodies.length - 1] ?? answer('ok'))(response);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(() => resolve(undefined))); });
  const port = (server.address() as { port: number }).port;
  const connection = { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' };
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home, ...env } });
  t.after(() => worker.terminate());
  const send = async (text: string, extra: Record<string, unknown> = {}) => {
    const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text, connection, ...extra });
    const events: any[] = [];
    const listener = (message: any) => { if (message?.type === 'event' && message.event === 'agent' && message.runId === runId) events.push(message); };
    worker.on('message', listener);
    return { runId, events, stop: () => worker.off('message', listener) };
  };
  const saved = () => callWorker(worker, 'messages', { folder: project, branchId: 'main' });
  return { home, project, bodies, worker, send, saved };
}

test('a provider gone silent ends the turn with a clear error, and the text already received is kept', async t => {
  const { send, saved } = await setup(t, [response => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Début de réponse' } }] })}\n\n`);
  }], { OPENAGENT_PROVIDER_IDLE_MS: '400' });
  const run = await send('explique');
  await until(() => finished(run.events), 'the expiry');
  run.stop();
  const last = run.events.at(-1);
  assert.equal(last.kind, 'error');
  assert.equal(last.message, 'Le fournisseur ne répond plus (0.4 s)');
  assert.ok(run.events.some(e => e.kind === 'message' && e.message.content === 'Début de réponse'), 'the partial text is posted to the screen');
  assert.deepEqual((await saved()).map((m: any) => [m.role, m.content]), [['user', 'explique'], ['assistant', 'Début de réponse']]);
});
