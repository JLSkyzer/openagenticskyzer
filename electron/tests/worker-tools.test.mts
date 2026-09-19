import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const run = promisify(execFile);
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

type Step = { tool?: { name: string; args: Record<string, unknown> }; text?: string };
async function setup(t: any, steps: Step[] = [{ text: 'ok' }], extraEnv: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-tools-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const bodies: any[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      bodies.push(JSON.parse(body));
      const step = steps[Math.min(bodies.length - 1, steps.length - 1)];
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
  const start = () => {
    const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home, ...extraEnv } });
    t.after(() => worker.terminate());
    return worker;
  };
  const worker = start();
  const send = async (w: Worker, text = 'go') => {
    const { runId } = await callWorker(w, 'send', { folder: project, branchId: 'main', text, connection });
    return { runId, ...collect(w, runId) };
  };
  return { root, home, project, bodies, worker, start, send, connection };
}
const sh = async (args: string[], cwd: string) => (await run('git', args, { cwd })).stdout.trim();

// ── tools and prompt reach the model ──────────────────────────────────────────────
const READ_TOOLS = ['read_file', 'view_file', 'list_dir', 'grep_file', 'glob_files', 'grep_codebase', 'read_memory', 'git_status', 'git_diff', 'git_diff_staged', 'git_log', 'git_blame', 'git_branch_list'];
const OTHER_TOOLS = ['create_file', 'edit_file', 'create_dir', 'delete_file', 'delete_dir', 'save_memory', 'forget_memory', 'git_add', 'git_commit', 'git_checkout', 'git_create_branch', 'git_stash', 'git_stash_pop', 'git_push', 'git_pull', 'run_command', 'fetch_url', 'internet_search'];

test('the model is offered every tool by default, and only the read tools in strict mode', async t => {
  const { worker, bodies, send } = await setup(t);
  const run1 = await send(worker);
  await until(() => finished(run1.events), 'the first run');
  run1.stop();
  const offered = bodies[0].tools.map((tool: any) => tool.function.name).sort();
  assert.deepEqual(offered, [...READ_TOOLS, ...OTHER_TOOLS].sort());

  await callWorker(worker, 'save-global-settings', { patch: { permission_mode: 'strict' } });
  const run2 = await send(worker);
  await until(() => finished(run2.events), 'the strict run');
  run2.stop();
  assert.deepEqual(bodies[1].tools.map((tool: any) => tool.function.name).sort(), [...READ_TOOLS].sort(), 'strict mode hides everything that is not read-only');
});

test('the system prompt tells the model what it can do and that outside content is data', async t => {
  const { worker, bodies, send } = await setup(t);
  const r = await send(worker);
  await until(() => finished(r.events), 'the run');
  r.stop();
  const system = bodies[0].messages[0].content as string;
  for (const word of ['run_command', 'git_status', 'fetch_url', 'save_memory']) assert.ok(system.includes(word), `the prompt names ${word}`);
  assert.match(system, /jamais.*instructions|donnée/i);
});

// ── the new tools really run through the worker ───────────────────────────────────
test('git_status runs on the real repository and its result reaches the transcript', async t => {
  const { worker, project, send } = await setup(t, [{ tool: { name: 'git_status', args: {} } }, { text: 'propre' }]);
  await sh(['init', '-b', 'main'], project);
  await sh(['config', 'user.name', 'Test'], project);
  await sh(['config', 'user.email', 't@example.com'], project);
  await writeFile(join(project, 'README.md'), '# x\n');
  await sh(['add', '.'], project);
  await sh(['commit', '-m', 'init'], project);
  const r = await send(worker);
  await until(() => finished(r.events), 'the run');
  r.stop();
  assert.equal(r.events.at(-1).kind, 'done');
  assert.equal(r.events.some(e => e.kind === 'permission-request'), false, 'a read tool never asks');
  const transcript = await callWorker(worker, 'messages', { folder: project, branchId: 'main' });
  assert.equal(transcript.find((m: any) => m.role === 'tool').content, 'Working tree clean.');
});

test('run_command asks by default, runs after approval, and shell_ask=false skips the prompt', async t => {
  const command = `node -e "console.log('salut-shell')"`;
  const { worker, project, send } = await setup(t, [{ tool: { name: 'run_command', args: { command } } }, { text: 'fait' }, { tool: { name: 'run_command', args: { command } } }, { text: 'refait' }]);
  const first = await send(worker);
  await until(() => first.events.some(e => e.kind === 'permission-request'), 'the permission request');
  const request = first.events.find(e => e.kind === 'permission-request');
  assert.equal(request.tool, 'run_command');
  assert.equal(request.category, 'shell');
  await callWorker(worker, 'permission-decision', { runId: first.runId, requestId: request.requestId, allow: true, always: false });
  await until(() => finished(first.events), 'the approved run');
  first.stop();
  let transcript = await callWorker(worker, 'messages', { folder: project, branchId: 'main' });
  assert.equal(transcript.find((m: any) => m.role === 'tool').content, 'salut-shell');

  await callWorker(worker, 'save-global-settings', { patch: { shell_ask: false } });
  const second = await send(worker);
  await until(() => finished(second.events), 'the unprompted run');
  second.stop();
  assert.equal(second.events.some(e => e.kind === 'permission-request'), false, 'shell_ask=false runs without asking');
  transcript = await callWorker(worker, 'messages', { folder: project, branchId: 'main' });
  assert.equal(transcript.filter((m: any) => m.role === 'tool').length, 2);
});

test('"Toujours" on a shell command lasts for the session only and never rewrites the settings', async t => {
  const command = `node -e "console.log('x')"`;
  // One tool call + one answer per run, for three runs (the fake provider walks this script).
  const call: Step = { tool: { name: 'run_command', args: { command } } };
  const steps: Step[] = [call, { text: 'a' }, call, { text: 'b' }, call, { text: 'c' }];
  const { worker, start, project, send } = await setup(t, steps);
  const first = await send(worker);
  await until(() => first.events.some(e => e.kind === 'permission-request'), 'the first prompt');
  const request = first.events.find(e => e.kind === 'permission-request');
  await callWorker(worker, 'permission-decision', { runId: first.runId, requestId: request.requestId, allow: true, always: true });
  await until(() => finished(first.events), 'the first run');
  first.stop();

  const second = await send(worker, 'encore');
  await until(() => finished(second.events), 'the second run');
  second.stop();
  assert.equal(second.events.some(e => e.kind === 'permission-request'), false, 'within the session the choice is remembered');

  const configFile = join(project, '.openagent', 'config.json');
  const saved = await readFile(configFile, 'utf8').catch(() => '{}');
  assert.equal(saved.includes('shell_ask'), false, 'no permanent "run anything" switch was written');
  assert.equal(saved.includes('override_permissions'), false);

  // A new session (fresh worker) has forgotten it: the next command asks again.
  const fresh = start();
  const third = await send(fresh, 'nouvelle session');
  await until(() => third.events.some(e => e.kind === 'permission-request'), 'a new prompt in the new session');
  third.stop();
});

const GRANDCHILD = `
  const { spawn } = require('node:child_process');
  spawn(process.execPath, ['-e', "setTimeout(() => require('node:fs').writeFileSync(process.env.MARKER, 'alive'), 3500)"], { stdio: 'ignore' });
  setTimeout(() => {}, 60000);
`;

test('Stop kills the running shell command and everything it started', async t => {
  const marker = join(tmpdir(), `openagent-worker-marker-${Date.now()}.txt`);
  t.after(() => rm(marker, { force: true }));
  const { worker, project, send } = await setup(t, [{ tool: { name: 'run_command', args: { command: 'node grand.js', timeout: 60 } } }], { MARKER: marker });
  await writeFile(join(project, 'grand.js'), GRANDCHILD);
  await callWorker(worker, 'save-global-settings', { patch: { shell_ask: false } });
  const r = await send(worker);
  await until(() => r.events.some(e => e.kind === 'tool-start'), 'the command to start');
  await sleep(500);
  await callWorker(worker, 'stop', { runId: r.runId });
  await until(() => finished(r.events), 'the stop');
  r.stop();
  assert.equal(r.events.at(-1).kind, 'stopped');
  await sleep(4000);
  await assert.rejects(stat(marker), 'Stop really stopped the process tree, not just the run');
});

test('shutdown stops the background dev servers a run started, and aborts what is running', async t => {
  const { worker, project, send } = await setup(t, [{ tool: { name: 'run_command', args: { command: 'npm run dev' } } }, { text: 'lancé' }]);
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'demo', scripts: { dev: 'node srv.js' } }));
  await writeFile(join(project, 'srv.js'), `const fs = require('node:fs'); console.log('listening'); setInterval(() => fs.appendFileSync('beat.txt', 'x'), 150);`);
  await callWorker(worker, 'save-global-settings', { patch: { shell_ask: false } });
  const r = await send(worker);
  await until(() => finished(r.events), 'the server launch', 20000);
  r.stop();
  const transcript = await callWorker(worker, 'messages', { folder: project, branchId: 'main' });
  assert.match(transcript.find((m: any) => m.role === 'tool').content, /^Server started in background/);
  await sleep(500);
  const beats = (await readFile(join(project, 'beat.txt'), 'utf8')).length;
  assert.ok(beats > 0, 'the server is running');

  await callWorker(worker, 'shutdown', {});
  await sleep(700);
  const after = (await readFile(join(project, 'beat.txt'), 'utf8')).length;
  await sleep(900);
  assert.equal((await readFile(join(project, 'beat.txt'), 'utf8')).length, after, 'no process of the server tree is still running');
});
