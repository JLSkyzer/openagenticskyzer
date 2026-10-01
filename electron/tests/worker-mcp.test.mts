import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const FAKE_MCP_SERVER = fileURLToPath(new URL('./fixtures/fake-mcp-server.cjs', import.meta.url));

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

test('worker::mcp-list/add/remove persist real MCP server definitions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-mcp-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home);
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  t.after(() => worker.terminate());

  assert.deepEqual(await callWorker(worker, 'mcp-list', {}), []);
  const afterAdd = await callWorker(worker, 'mcp-add', { commandLine: 'echo hello' });
  assert.equal(afterAdd.length, 1);
  assert.equal(afterAdd[0].command, 'echo');
  const afterRemove = await callWorker(worker, 'mcp-remove', { id: afterAdd[0].id });
  assert.deepEqual(afterRemove, []);
});

test('worker::send registers a real configured MCP server\'s tools and actually calls one', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-mcp-send-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  t.after(() => worker.terminate());

  await callWorker(worker, 'mcp-add', { commandLine: `"${process.execPath}" "${FAKE_MCP_SERVER}"` });
  // The permission mode must allow an 'extension' tool without a prompt for this test to run
  // the turn to completion; auto mode does exactly that (see core/agent.mts::policy).
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
            message: { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'mcp_echo', arguments: JSON.stringify({ text: 'depuis le vrai serveur MCP' }) } }] },
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

  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'utilise le serveur MCP', connection });
  const { events, stop } = collectAgentEvents(worker, runId);
  await waitUntilDone(events);
  stop();

  assert.equal(events.at(-1).kind, 'done', `expected done, got: ${events.map(e => e.kind).join(',')}`);
  const toolStart = events.find(e => e.kind === 'tool-start');
  assert.equal(toolStart.tool, 'mcp_echo');
  assert.equal(toolStart.category, 'extension');

  const messages = await callWorker(worker, 'messages', { folder: project, branchId: 'main' });
  const toolResult = messages.find((m: any) => m.role === 'tool');
  assert.match(toolResult.content, /depuis le vrai serveur MCP/, 'the real fake-mcp-server process actually echoed it back');
});

test('worker::send discovers a real project-scope server from a real .mcp.json and calls it', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-mcp-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  await writeFile(join(project, '.mcp.json'), JSON.stringify({
    mcpServers: { fake: { command: process.execPath, args: [FAKE_MCP_SERVER] } },
  }));

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
          choices: [{ message: { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'mcp_echo', arguments: JSON.stringify({ text: 'depuis le .mcp.json du projet' }) } }] }, finish_reason: 'tool_calls' }],
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

  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'utilise le serveur du projet', connection });
  const { events, stop } = collectAgentEvents(worker, runId);
  await waitUntilDone(events);
  stop();

  assert.equal(events.at(-1).kind, 'done', `expected done, got: ${events.map((e: any) => e.kind).join(',')}`);
  const messages = await callWorker(worker, 'messages', { folder: project, branchId: 'main' });
  const toolResult = messages.find((m: any) => m.role === 'tool');
  assert.match(toolResult.content, /depuis le .mcp.json du projet/);
});

test('worker::send: a project .mcp.json server overrides a colliding global one (same command+args)', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-mcp-collision-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  t.after(() => worker.terminate());
  await callWorker(worker, 'save-global-settings', { patch: { agent_mode: 'auto', permission_mode: 'auto' } });

  // A global entry AND a project .mcp.json entry both point at the exact same real fake server
  // (same command+args) — mergeServerConfigs must drop the global duplicate. If it didn't, the
  // SAME tool would be discovered twice, which agent.mts::runAgent refuses outright ("Nom outil
  // invalide ou dupliqué") — so a successful turn IS the real, decisive proof of dedup.
  await callWorker(worker, 'mcp-add', { commandLine: `"${process.execPath}" "${FAKE_MCP_SERVER}"` });
  await writeFile(join(project, '.mcp.json'), JSON.stringify({
    mcpServers: { fake: { command: process.execPath, args: [FAKE_MCP_SERVER] } },
  }));

  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount++;
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'Fait, pas de doublon.' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  const port = (server.address() as { port: number }).port;
  const connection = { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' };

  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'bonjour', connection });
  const { events, stop } = collectAgentEvents(worker, runId);
  await waitUntilDone(events);
  stop();
  assert.equal(events.at(-1).kind, 'done', `expected done (no duplicate-tool-name error), got: ${JSON.stringify(events.at(-1))}`);
});

test('worker::mcp-add-remote persists a real remote server definition', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-mcp-remote-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home);
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  t.after(() => worker.terminate());

  const result = await callWorker(worker, 'mcp-add-remote', { url: 'https://example.com/mcp', type: 'sse', headers: { Authorization: 'Bearer tok' } });
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'sse');
  assert.equal(result[0].url, 'https://example.com/mcp');
  const relisted = await callWorker(worker, 'mcp-list', {});
  assert.equal(relisted.length, 1);
  assert.equal(relisted[0].headers.Authorization, 'Bearer tok');
});
