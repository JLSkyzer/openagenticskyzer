import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

function callWorker(worker: Worker, op: string, payload: unknown = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `plugin-${Math.random()}`;
    const listener = (message: any) => {
      if (message.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}

test('worker::send registers a real plugin tool and actually calls it end to end', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-plugin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'echo.mjs'), `
    export function getTools() {
      return [{
        name: 'plugin_echo',
        description: 'Echoes text from a real plugin file',
        category: 'read',
        properties: { text: { type: 'string' } },
        required: ['text'],
        execute: async (args) => 'plugin says: ' + args.text,
      }];
    }
  `);

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  t.after(() => worker.terminate());
  await callWorker(worker, 'save-global-settings', { patch: { agent_mode: 'auto', permission_mode: 'auto' } });

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
            message: { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'plugin_echo', arguments: JSON.stringify({ text: 'bonjour' }) } }] },
            finish_reason: 'tool_calls',
          }],
        }));
      } else {
        response.end(JSON.stringify({ choices: [{ message: { content: 'Fait.' }, finish_reason: 'stop' }] }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  const port = (server.address() as { port: number }).port;
  const connection = { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' };

  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'utilise le plugin', connection });
  const events: any[] = [];
  await new Promise<void>(resolve => {
    const listener = (message: any) => {
      if (message?.type === 'event' && message.event === 'agent' && message.runId === runId) {
        events.push(message);
        if (['done', 'error', 'stopped'].includes(message.kind)) { worker.off('message', listener); resolve(); }
      }
    };
    worker.on('message', listener);
  });

  assert.equal(events.at(-1).kind, 'done', `expected done, got: ${events.map(e => e.kind).join(',')}`);
  const toolStart = events.find(e => e.kind === 'tool-start');
  assert.equal(toolStart.tool, 'plugin_echo');
  assert.equal(toolStart.category, 'extension', 'forced to extension regardless of what the plugin declared');

  const messages = await callWorker(worker, 'messages', { folder: project, branchId: 'main' });
  const toolResult = messages.find((m: any) => m.role === 'tool');
  assert.match(toolResult.content, /plugin says: bonjour/);
});

test('worker::plugin-list reports loaded plugin names and isolated errors for the active folder', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-plugin-list-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'good.mjs'), `export function getTools() { return [{ name: 'good_tool', description: 'ok', category: 'read', properties: {}, execute: async () => 'ok' }]; }`);
  await writeFile(join(home, 'tools', 'bad.mjs'), `export const notGetTools = true;`);

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  t.after(() => worker.terminate());

  const result = await callWorker(worker, 'plugin-list', { folder: project });
  assert.deepEqual(result.tools, ['good_tool']);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /bad\.mjs/);
});

test('worker::plugin-list with folder=null only reports global plugins', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-plugin-noproject-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home);
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'global.mjs'), `export function getTools() { return [{ name: 'global_tool', description: 'ok', category: 'read', properties: {}, execute: async () => 'ok' }]; }`);

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  t.after(() => worker.terminate());

  const result = await callWorker(worker, 'plugin-list', { folder: null });
  assert.deepEqual(result.tools, ['global_tool']);
  assert.deepEqual(result.errors, []);
});
