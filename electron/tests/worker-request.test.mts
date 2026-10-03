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

test('a second turn sends neither the tool calls nor the tool results of the first one', async t => {
  const { bodies, send } = await setup(t, [call('c1', 'list_dir', {}), answer('Voici la liste.'), answer('Suite.')]);
  const first = await send('liste');
  await until(() => finished(first.events), 'the first turn');
  first.stop();
  const second = await send('et ensuite ?');
  await until(() => finished(second.events), 'the second turn');
  second.stop();
  assert.equal(second.events.at(-1).kind, 'done');
  assert.deepEqual(bodies[2].messages.map((m: any) => [m.role, m.content]).slice(1), [['user', 'liste'], ['assistant', 'Voici la liste.'], ['user', 'et ensuite ?']]);
  assert.equal(bodies[2].messages.some((m: any) => m.tool_calls || m.role === 'tool'), false);
});

test('over budget, the oldest tool result of the turn in progress is replaced; the saved transcript keeps it whole', async t => {
  const content = Array.from({ length: 450 }, () => 'x'.repeat(99)).join('\n');
  const output = content.split('\n').map((line, index) => `${index + 1}|${line}`).join('\n');
  const { bodies, worker, project, send, saved } = await setup(t, [
    answer('mesuré'),
    call('r1', 'read_file', { path: 'big1.txt' }),
    call('r2', 'read_file', { path: 'big2.txt' }),
    answer('lu'),
  ]);
  await writeFile(join(project, 'big1.txt'), content);
  await writeFile(join(project, 'big2.txt'), content);
  const measure = await send('mesure');
  await until(() => finished(measure.events), 'the measuring turn');
  measure.stop();
  // Fixed part of every request (system prompt + tool schemas), measured on the real request.
  const fixed = bodies[0].messages[0].content.length + JSON.stringify(bodies[0].tools).length;
  // Room for the fixed part, ONE read result and some slack — not for two.
  const max_tokens = Math.ceil((fixed + output.length + 5000) / 4) + 2048;
  await callWorker(worker, 'save-global-settings', { patch: { max_tokens } });
  const run = await send('lis les deux');
  await until(() => finished(run.events), 'the reading turn');
  run.stop();
  assert.equal(run.events.at(-1).kind, 'done', JSON.stringify(run.events.at(-1)));
  const toolsIn = (body: any) => body.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content);
  assert.deepEqual(toolsIn(bodies[2]), [output], 'one result fits as is');
  assert.deepEqual(toolsIn(bodies[3]), [`[sortie de read_file retirée pour tenir dans le contexte : ${output.length} caractères]`, output]);
  assert.deepEqual((await saved()).filter((m: any) => m.role === 'tool').map((m: any) => m.content), [output, output], 'the saved conversation never changes');
});

test('a history that alone exceeds the budget is not sent: "Contexte plein"', async t => {
  const { bodies, worker, project, send } = await setup(t, []);
  await callWorker(worker, 'save-messages', { folder: project, branchId: 'main', messages: [{ role: 'user', content: 'x'.repeat(400_000) }, { role: 'assistant', content: 'ok' }] });
  await callWorker(worker, 'save-global-settings', { patch: { max_tokens: 32000 } });
  const run = await send('suite');
  await until(() => finished(run.events), 'the refusal');
  run.stop();
  assert.equal(run.events.at(-1).kind, 'error');
  assert.equal(run.events.at(-1).message, 'Contexte plein : compacte ou efface la conversation');
  assert.equal(bodies.length, 0, 'no request reached the provider');
});

test('a Stop during a permission prompt saves a paired "Interrompu" result, and the next turn works', async t => {
  const { bodies, worker, send, saved } = await setup(t, [call('c1', 'run_command', { command: 'node -e 0' }), answer('repris')]);
  const first = await send('lance');
  await until(() => first.events.some(e => e.kind === 'permission-request'), 'the prompt');
  await callWorker(worker, 'stop', { runId: first.runId });
  await until(() => finished(first.events), 'the stop');
  first.stop();
  assert.equal(first.events.at(-1).kind, 'stopped');
  assert.ok(first.events.some(e => e.kind === 'message' && e.message.role === 'tool' && e.message.tool_call_id === 'c1'), 'the screen gets the closing message too');
  const transcript = await saved();
  assert.deepEqual(transcript.map((m: any) => [m.role, m.tool_call_id ?? null, m.content]), [
    ['user', null, 'lance'], ['assistant', null, ''], ['tool', 'c1', "Interrompu par l'utilisateur"],
  ]);
  const next = await send('encore');
  await until(() => finished(next.events), 'the next turn');
  next.stop();
  assert.equal(next.events.at(-1).kind, 'done');
  assert.equal(bodies[1].messages.some((m: any) => m.tool_calls || m.role === 'tool'), false, 'the interrupted call is not sent again');
});

test('the closing messages of a Stop are posted at the same indices the file saves them (screen and file agree)', async t => {
  const { worker, send, saved } = await setup(t, [call('c1', 'run_command', { command: 'node -e 0' })]);
  const run = await send('lance');
  await until(() => run.events.some(e => e.kind === 'permission-request'), 'the prompt');
  await callWorker(worker, 'stop', { runId: run.runId });
  await until(() => finished(run.events), 'the stop');
  run.stop();
  const posted = run.events.filter(e => e.kind === 'message').map(e => e.message);
  assert.deepEqual(posted.at(-1), { role: 'tool', tool_call_id: 'c1', content: "Interrompu par l'utilisateur" }, 'the closing message reaches the screen');
  assert.deepEqual((await saved()).slice(1), posted, 'after the typed message, the file holds exactly what the screen received, in order');
});

test('a dangling call of an OLDER turn is left as saved (not closed mid-list), and is never sent again', async t => {
  const { bodies, worker, project, send, saved } = await setup(t, [call('c1', 'run_command', { command: 'node -e 0' })]);
  const older = [{ role: 'user', content: 'avant' }, { role: 'assistant', content: '', tool_calls: [{ id: 'c0', type: 'function', function: { name: 'list_dir', arguments: '{}' } }] }];
  await callWorker(worker, 'save-messages', { folder: project, branchId: 'main', messages: older });
  const run = await send('lance');
  await until(() => run.events.some(e => e.kind === 'permission-request'), 'the prompt');
  await callWorker(worker, 'stop', { runId: run.runId });
  await until(() => finished(run.events), 'the stop');
  run.stop();
  assert.equal(bodies[0].messages.some((m: any) => m.tool_calls || m.role === 'tool'), false, 'the older call is not sent');
  const transcript = await saved();
  assert.deepEqual(transcript.map((m: any) => [m.role, m.tool_call_id ?? null, m.content]), [
    ['user', null, 'avant'], ['assistant', null, ''], ['user', null, 'lance'], ['assistant', null, ''], ['tool', 'c1', "Interrompu par l'utilisateur"],
  ], 'only the call of THIS run is closed');
  assert.deepEqual(transcript.slice(3), run.events.filter(e => e.kind === 'message').map(e => e.message), 'screen and file agree');
});
