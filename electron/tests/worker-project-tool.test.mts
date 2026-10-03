// The agent tool `analyze_project_and_init` (Python parity: agent.py) through a real worker and a real
// OpenAI-compatible fake model server: it writes OPENAGENT.md in the ACTIVE project only, and a write
// tool goes through the permission policy like any other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';

const TOOL = 'analyze_project_and_init';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
function collect(worker: Worker, runId: string) {
  const events: any[] = [];
  const listener = (message: any) => { if (message?.type === 'event' && message.event === 'agent' && message.runId === runId) events.push(message); };
  worker.on('message', listener);
  return { events, stop: () => worker.off('message', listener) };
}
async function until(check: () => boolean, what: string, timeout = 15000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
const finished = (events: any[]) => events.some(e => ['done', 'error', 'stopped'].includes(e.kind));
const exists = (path: string) => stat(path).then(() => true, () => false);

type Step = { tool?: { name: string; args: Record<string, unknown> }; text?: string };
async function setup(t: any, steps: Step[], toolArgs?: (dirs: { root: string; other: string }) => Step[]) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-projtool-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  const other = join(root, 'other');
  await Promise.all([mkdir(home), mkdir(project), mkdir(other)]);
  await writeFile(join(project, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.0.0' } }));
  await writeFile(join(project, 'index.ts'), 'export {};');
  const script = toolArgs ? toolArgs({ root, other }) : steps;
  const bodies: any[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      bodies.push(JSON.parse(body));
      const step = script[Math.min(bodies.length - 1, script.length - 1)];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{
        message: step.tool ? { content: '', tool_calls: [{ id: `call-${bodies.length}`, type: 'function', function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] } : { content: step.text ?? 'ok' },
        finish_reason: step.tool ? 'tool_calls' : 'stop',
      }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  const port = (server.address() as { port: number }).port;
  const connection = { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' };
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);
  const send = async () => {
    const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'go', connection });
    return { runId, ...collect(worker, runId) };
  };
  const toolResults = async () => (await callWorker(worker, 'messages', { folder: project, branchId: 'main' })).filter((m: any) => m.role === 'tool').map((m: any) => m.content as string);
  return { project, other, worker, bodies, send, toolResults };
}
async function runToEnd(send: () => Promise<{ events: any[]; stop(): void }>, what: string) {
  const r = await send();
  await until(() => finished(r.events), what);
  r.stop();
  return r;
}

test('in auto permission mode the tool writes OPENAGENT.md in the project, and a second call refuses without overwrite', async t => {
  const { project, worker, send, toolResults } = await setup(t, [
    { tool: { name: TOOL, args: {} } }, { text: 'fait' },
    { tool: { name: TOOL, args: { overwrite: false } } }, { text: 'refusé' },
  ]);
  await callWorker(worker, 'save-global-settings', { patch: { permission_mode: 'auto' } });

  const first = await runToEnd(send, 'the first run');
  assert.equal(first.events.some(e => e.kind === 'permission-request'), false, 'auto mode does not ask');
  const content = await readFile(join(project, 'OPENAGENT.md'), 'utf8');
  assert.match(content, /TypeScript/);
  assert.match(content, /Vue/);
  assert.match((await toolResults())[0], /^OPENAGENT\.md généré dans .*project.*TypeScript/);

  await writeFile(join(project, 'OPENAGENT.md'), 'ma version\n');
  await runToEnd(send, 'the second run');
  assert.equal(await readFile(join(project, 'OPENAGENT.md'), 'utf8'), 'ma version\n', 'file unchanged without overwrite');
  assert.equal((await toolResults()).at(-1), 'OPENAGENT.md existe déjà. Confirmez son écrasement.');
});

test('overwrite: true rewrites an existing OPENAGENT.md', async t => {
  const { project, worker, send, toolResults } = await setup(t, [{ tool: { name: TOOL, args: { overwrite: true } } }, { text: 'fait' }]);
  await callWorker(worker, 'save-global-settings', { patch: { permission_mode: 'auto' } });
  await writeFile(join(project, 'OPENAGENT.md'), 'ancienne version\n');
  await runToEnd(send, 'the run');
  const content = await readFile(join(project, 'OPENAGENT.md'), 'utf8');
  assert.notEqual(content, 'ancienne version\n');
  assert.match(content, /TypeScript/);
  assert.match((await toolResults())[0], /^OPENAGENT\.md généré dans /);
});

test('in demander mode with the default settings it asks, writes nothing before the decision, and a refusal writes nothing', async t => {
  const { project, worker, send, toolResults } = await setup(t, [{ tool: { name: TOOL, args: {} } }, { text: 'ok' }]);
  const r = await send();
  await until(() => r.events.some(e => e.kind === 'permission-request'), 'the permission request');
  const request = r.events.find(e => e.kind === 'permission-request');
  assert.equal(request.tool, TOOL);
  assert.equal(request.category, 'write');
  assert.equal(await exists(join(project, 'OPENAGENT.md')), false, 'nothing written before the decision');
  await callWorker(worker, 'permission-decision', { runId: r.runId, requestId: request.requestId, allow: false, always: false });
  await until(() => finished(r.events), 'the refused run');
  r.stop();
  assert.equal(await exists(join(project, 'OPENAGENT.md')), false, 'refused: no file');
  assert.match((await toolResults())[0], /refusée par les permissions/);
});

test('in demander mode an approved call writes the file', async t => {
  const { project, worker, send } = await setup(t, [{ tool: { name: TOOL, args: {} } }, { text: 'ok' }]);
  const r = await send();
  await until(() => r.events.some(e => e.kind === 'permission-request'), 'the permission request');
  const request = r.events.find(e => e.kind === 'permission-request');
  await callWorker(worker, 'permission-decision', { runId: r.runId, requestId: request.requestId, allow: true, always: false });
  await until(() => finished(r.events), 'the approved run');
  r.stop();
  assert.match(await readFile(join(project, 'OPENAGENT.md'), 'utf8'), /TypeScript/);
});

test('the tool is offered in agent mode, but absent from ask, plan and strict', async t => {
  const { worker, bodies, send } = await setup(t, [{ text: 'ok' }]);
  const offered = async () => { await runToEnd(send, 'a run'); return bodies.at(-1).tools.map((tool: any) => tool.function.name) as string[]; };
  assert.ok((await offered()).includes(TOOL), 'offered in agent mode');
  assert.ok((bodies.at(-1).messages[0].content as string).includes(TOOL), 'named in the prompt, built from the tools offered');
  for (const patch of [{ agent_mode: 'ask' }, { agent_mode: 'plan' }, { agent_mode: 'auto', permission_mode: 'strict' }]) {
    await callWorker(worker, 'save-global-settings', { patch });
    assert.equal((await offered()).includes(TOOL), false, `absent with ${JSON.stringify(patch)}`);
    assert.equal((bodies.at(-1).messages[0].content as string).includes(TOOL), false, `not named in the prompt with ${JSON.stringify(patch)}`);
  }
});

test('the schema has one optional boolean, overwrite, and no folder; its description states the rules', async t => {
  const { worker, bodies, send } = await setup(t, [{ text: 'ok' }]);
  await runToEnd(send, 'a run');
  const spec = bodies[0].tools.find((tool: any) => tool.function.name === TOOL).function;
  assert.deepEqual(Object.keys(spec.parameters.properties), ['overwrite']);
  assert.equal(spec.parameters.properties.overwrite.type, 'boolean');
  assert.deepEqual(spec.parameters.required, []);
  assert.match(spec.description, /OPENAGENT\.md/);
  assert.match(spec.description, /accord explicite/);
  assert.match(spec.description, /overwrite: ?true/);
  assert.match(spec.description, /CLAUDE\.md/);
  void worker;
});

test('a folder key naming another directory is dropped: the other directory gets nothing, the active project gets the file', async t => {
  const { project, other, worker, send, toolResults } = await setup(t, [], ({ other }) => [
    { tool: { name: TOOL, args: { folder: other, overwrite: false } } }, { text: 'ok' },
  ]);
  await callWorker(worker, 'save-global-settings', { patch: { permission_mode: 'auto' } });
  await runToEnd(send, 'a run');
  assert.equal(await exists(join(other, 'OPENAGENT.md')), false, 'the other folder is untouched');
  assert.equal(await exists(join(project, 'OPENAGENT.md')), true, 'the active project got the file');
  assert.match((await toolResults())[0], /^OPENAGENT\.md généré dans .*project/);
});
