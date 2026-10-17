import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';
import { testWorkerOptions } from './support/test-model-provider.mts';

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

test("worker::git_diff applies the project's ignored patterns: an ignored file is named, never shown", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-git-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(join(project, 'private'), { recursive: true })]);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, env: { ...process.env, LC_ALL: 'C' } });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  await writeFile(join(project, 'app.ts'), 'APP-OLD\n');
  await writeFile(join(project, 'private', 'notes.md'), 'SECRET-WORKER-GIT-OLD\n');
  git('add', 'app.ts', 'private/notes.md');
  git('commit', '-m', 'files');
  await writeFile(join(project, 'app.ts'), 'APP-NEW\n');
  await writeFile(join(project, 'private', 'notes.md'), 'SECRET-WORKER-GIT-NEW\n');
  // The project ignores private/ (the app's setting, not a .gitignore: git still tracks the file).
  await mkdir(join(project, '.openagent'));
  await writeFile(join(project, '.openagent', 'config.json'), JSON.stringify({ ignored_patterns: 'private/' }));

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), testWorkerOptions(home));
  terminateAtEnd(t, worker);
  await callWorker(worker, 'save-global-settings', { patch: { agent_mode: 'auto', permission_mode: 'auto' } });

  const bodies: any[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      bodies.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(bodies.length === 1
        ? { choices: [{ message: { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'git_diff', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }
        : { choices: [{ message: { content: 'Fait.' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  const port = (server.address() as { port: number }).port;
  const testModel = { base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model' };

  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'montre le diff', testModel });
  const { events, stop } = collectAgentEvents(worker, runId);
  await waitUntilDone(events);
  stop();
  assert.equal(events.at(-1).kind, 'done', `expected done, got: ${events.map(e => e.kind).join(',')}`);
  const messages = await callWorker(worker, 'messages', { folder: project, branchId: 'main' });
  const toolResult = messages.find((m: any) => m.role === 'tool');
  assert.match(toolResult.content, /\+APP-NEW/);
  assert.equal(toolResult.content.split('\n').at(-1), 'Fichiers masqués (secrets ou exclus), contenu non affiché : private/notes.md');
  assert.equal(JSON.stringify(bodies[1]).includes('SECRET-WORKER-GIT'), false, 'nothing of the ignored file reached the model');
});
