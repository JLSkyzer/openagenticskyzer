import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';
import { createRequire } from 'node:module';

// main.cjs as a library: the very function the app runs on quit (worker 'shutdown', then terminate).
const { stopWorker } = createRequire(import.meta.url)('../main.cjs');

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

/** A project's .mcp.json is only used once the project is trusted (core/project-trust.mts). */
async function approveProject(worker: Worker, folder: string) {
  const { token } = await callWorker(worker, 'project-trust', { folder });
  await callWorker(worker, 'trust-project', { folder, decision: 'trusted', token });
}

test('worker::mcp-list/add/remove persist real MCP server definitions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-mcp-config-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  await mkdir(home);
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);

  assert.deepEqual(await callWorker(worker, 'mcp-list', {}), []);
  const afterAdd = await callWorker(worker, 'mcp-add', { commandLine: 'echo hello' });
  assert.equal(afterAdd.length, 1);
  assert.equal(afterAdd[0].command, 'echo');
  const afterRemove = await callWorker(worker, 'mcp-remove', { id: afterAdd[0].id });
  assert.deepEqual(afterRemove, []);
});

test('worker::send registers a real configured MCP server\'s tools and actually calls one', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-mcp-send-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);

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
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  await writeFile(join(project, '.mcp.json'), JSON.stringify({
    mcpServers: { fake: { command: process.execPath, args: [FAKE_MCP_SERVER] } },
  }));

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);
  await callWorker(worker, 'save-global-settings', { patch: { agent_mode: 'auto', permission_mode: 'auto' } });
  await approveProject(worker, project);

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
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);
  await callWorker(worker, 'save-global-settings', { patch: { agent_mode: 'auto', permission_mode: 'auto' } });

  // A global entry AND a project .mcp.json entry both point at the exact same real fake server
  // (same command+args) — mergeServerConfigs must drop the global duplicate. If it didn't, the
  // SAME tool would be discovered twice, which agent.mts::runAgent refuses outright ("Nom outil
  // invalide ou dupliqué") — so a successful turn IS the real, decisive proof of dedup.
  await callWorker(worker, 'mcp-add', { commandLine: `"${process.execPath}" "${FAKE_MCP_SERVER}"` });
  await writeFile(join(project, '.mcp.json'), JSON.stringify({
    mcpServers: { fake: { command: process.execPath, args: [FAKE_MCP_SERVER] } },
  }));
  await approveProject(worker, project);

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

test('worker::send: two DIFFERENT servers exposing the same tool names never fail the turn — the project one wins', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-mcp-samename-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);
  await callWorker(worker, 'save-global-settings', { patch: { agent_mode: 'auto', permission_mode: 'auto' } });

  // Same fixture, different args: two distinct server identities, so mergeServerConfigs keeps
  // BOTH — yet both expose `echo`/`boom`, i.e. two `mcp_echo` and two `mcp_boom` AgentTools.
  await callWorker(worker, 'mcp-add', { commandLine: `"${process.execPath}" "${FAKE_MCP_SERVER}" global` });
  await writeFile(join(project, '.mcp.json'), JSON.stringify({
    mcpServers: { fake: { command: process.execPath, args: [FAKE_MCP_SERVER, 'project'] } },
  }));
  await approveProject(worker, project);

  const toolNamesPerRequest: string[][] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body);
      toolNamesPerRequest.push((parsed.tools ?? []).map((tool: any) => tool.function.name));
      response.writeHead(200, { 'content-type': 'application/json' });
      if (toolNamesPerRequest.length === 1) {
        response.end(JSON.stringify({
          choices: [{ message: { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'mcp_echo', arguments: JSON.stringify({ text: 'qui répond ?' }) } }] }, finish_reason: 'tool_calls' }],
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

  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'utilise echo', connection });
  const { events, stop } = collectAgentEvents(worker, runId);
  await waitUntilDone(events);
  stop();

  assert.equal(events.at(-1).kind, 'done', `expected done (no duplicate-tool-name error), got: ${JSON.stringify(events.at(-1))}`);
  const offered = toolNamesPerRequest[0];
  assert.equal(offered.filter(name => name === 'mcp_echo').length, 1, `exactly one mcp_echo offered, got: ${offered.join(',')}`);
  assert.equal(offered.filter(name => name === 'mcp_boom').length, 1, `exactly one mcp_boom offered, got: ${offered.join(',')}`);
  const messages = await callWorker(worker, 'messages', { folder: project, branchId: 'main' });
  const toolResult = messages.find((m: any) => m.role === 'tool');
  assert.equal(toolResult.content, '[project] qui répond ?', 'the project-scope server (listed first by mergeServerConfigs) is the one that answered');
});

test('worker::send: an MCP tool with an invalid name is dropped instead of failing the turn', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-mcp-badname-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  await writeFile(join(project, '.mcp.json'), JSON.stringify({
    mcpServers: { fake: { command: process.execPath, args: [FAKE_MCP_SERVER], env: { FAKE_MCP_EXTRA_TOOL_NAME: 'nom avec espaces' } } },
  }));

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);
  await callWorker(worker, 'save-global-settings', { patch: { agent_mode: 'auto', permission_mode: 'auto' } });
  await approveProject(worker, project);

  const toolNames: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      toolNames.push(...(JSON.parse(body).tools ?? []).map((tool: any) => tool.function.name));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'Fait.' }, finish_reason: 'stop' }] }));
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

  assert.equal(events.at(-1).kind, 'done', `expected done (no invalid-tool-name error), got: ${JSON.stringify(events.at(-1))}`);
  assert.ok(toolNames.includes('mcp_echo'), 'the server\'s valid tools are still offered');
  assert.ok(!toolNames.includes('mcp_nom avec espaces'), 'the invalid one is not');
});

test('worker::mcp-list shows project entries as written (an expanded ${VAR} never reaches the renderer), deduped as a turn would be', { timeout: 30000 }, async t => {
  const SECRET = 'sk-EXPANDED-ARG-SECRET';
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-mcp-expand-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const { startFakeMcpHttpServer } = await import('./fixtures/fake-mcp-http-server.cjs');
  const fake = await startFakeMcpHttpServer({ mode: 'json' });
  t.after(() => fake.close());
  const distantUrl = `${fake.url}/\${OA_TEST_SECRET}`; // the fake server answers on any path
  await writeFile(join(project, '.mcp.json'), JSON.stringify({
    mcpServers: {
      local: { command: '${OA_TEST_NODE}', args: [FAKE_MCP_SERVER] },
      tokened: { command: 'some-server', args: ['--token=${OA_TEST_SECRET}'] },
      distant: { type: 'http', url: distantUrl, headers: { Authorization: 'Bearer ${OA_TEST_SECRET}' } },
    },
  }));
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home, OA_TEST_SECRET: SECRET, OA_TEST_NODE: process.execPath },
  });
  terminateAtEnd(t, worker);
  await approveProject(worker, project);
  // Same command+args as the project's `local` entry ONCE EXPANDED: a turn runs only one of them.
  await callWorker(worker, 'mcp-add', { commandLine: `"${process.execPath}" "${FAKE_MCP_SERVER}"` });

  const listed = await callWorker(worker, 'mcp-list', { folder: project });
  assert.ok(!JSON.stringify(listed).includes(SECRET), `the expanded secret must not reach the renderer — got ${JSON.stringify(listed)}`);
  const byId = new Map(listed.map((s: any) => [s.id, s]));
  assert.deepEqual((byId.get('tokened') as any).args, ['--token=${OA_TEST_SECRET}'], 'shown exactly as written in .mcp.json');
  assert.equal((byId.get('distant') as any).url, distantUrl);
  assert.equal((byId.get('local') as any).command, '${OA_TEST_NODE}');
  assert.equal(listed.length, 3, `the global duplicate of the expanded \`local\` entry is merged away, as in a turn — got ${JSON.stringify(listed)}`);

  // A real turn uses the EXPANDED values: the remote server receives the real path and header.
  const llm = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'Fait.' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((resolve, reject) => { llm.once('error', reject); llm.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => llm.close(() => resolve(undefined))));
  const port = (llm.address() as { port: number }).port;
  const connection = { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' };
  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'bonjour', connection });
  const { events, stop } = collectAgentEvents(worker, runId);
  await waitUntilDone(events);
  stop();
  assert.equal(events.at(-1).kind, 'done', `expected done, got: ${JSON.stringify(events.at(-1))}`);
  const init = fake.receivedRequests.find(r => r.message.method === 'initialize');
  assert.equal(init?.headers.authorization, `Bearer ${SECRET}`, 'the header placeholder was expanded for the real request');
});

test('worker::mcp-add-remote persists a real remote server definition', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-mcp-remote-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  await mkdir(home);
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);

  const result = await callWorker(worker, 'mcp-add-remote', { url: 'https://example.com/mcp', type: 'sse', headers: { Authorization: 'Bearer tok' } });
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'sse');
  assert.equal(result[0].url, 'https://example.com/mcp');
  const relisted = await callWorker(worker, 'mcp-list', {});
  assert.equal(relisted.length, 1);
  assert.equal(relisted[0].url, 'https://example.com/mcp');
  assert.deepEqual(Object.keys(relisted[0].headers), ['Authorization'], 'the header name survives for the renderer');
  assert.ok(!JSON.stringify([result, relisted]).includes('Bearer tok'), 'but never its value');
  const onDisk = JSON.parse(await readFile(join(home, 'mcp.json'), 'utf8'));
  assert.equal(onDisk[0].headers.Authorization, 'Bearer tok', 'the real value is still persisted');
});

test('worker::mcp-* replies never carry a real env/header secret to the renderer — yet the real value is still used', { timeout: 30000 }, async t => {
  const SECRET_HEADER = 'Bearer sk-HEADER-SECRET-123';
  const SECRET_ENV = 'sk-ENV-SECRET-456';
  const SECRET_PROJECT_HEADER = 'sk-PROJECT-HEADER-789';
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-mcp-secrets-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  await writeFile(join(project, '.mcp.json'), JSON.stringify({
    mcpServers: {
      local: { command: process.execPath, args: [FAKE_MCP_SERVER], env: { API_KEY: SECRET_ENV } },
      distant: { type: 'http', url: 'http://127.0.0.1:1/unused', headers: { 'X-Api-Key': SECRET_PROJECT_HEADER } },
    },
  }));
  const { startFakeMcpHttpServer } = await import('./fixtures/fake-mcp-http-server.cjs');
  const fake = await startFakeMcpHttpServer({ mode: 'json' });
  t.after(() => fake.close());

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);
  await approveProject(worker, project);
  const assertNoSecret = (label: string, value: unknown) => {
    const text = JSON.stringify(value);
    for (const secret of [SECRET_HEADER, SECRET_ENV, SECRET_PROJECT_HEADER]) {
      assert.ok(!text.includes(secret), `${label}: "${secret}" must never come back to the renderer — got ${text}`);
    }
  };

  const added = await callWorker(worker, 'mcp-add-remote', { url: fake.url, type: 'http', headers: { Authorization: SECRET_HEADER } });
  assertNoSecret('mcp-add-remote reply', added);
  assertNoSecret('mcp-add reply', await callWorker(worker, 'mcp-add', { commandLine: 'echo hello' }));
  const listed = await callWorker(worker, 'mcp-list', { folder: project });
  assertNoSecret('mcp-list reply', listed);
  assert.equal(listed.length, 4, 'both scopes listed');
  const byId = new Map(listed.map((s: any) => [s.id, s]));
  assert.deepEqual(Object.keys((byId.get('local') as any).env), ['API_KEY'], 'env key names survive, values do not');
  assert.deepEqual(Object.keys((byId.get('distant') as any).headers), ['X-Api-Key']);
  const echoEntry = listed.find((s: any) => s.command === 'echo');
  assertNoSecret('mcp-remove reply', await callWorker(worker, 'mcp-remove', { id: echoEntry.id }));

  // On disk and inside the worker, the real value is untouched: a real turn sends it for real.
  const onDisk = await readFile(join(home, 'mcp.json'), 'utf8');
  assert.ok(onDisk.includes(SECRET_HEADER), 'mcp.json keeps the real header value');
  const llm = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'Fait.' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((resolve, reject) => { llm.once('error', reject); llm.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => llm.close(() => resolve(undefined))));
  const port = (llm.address() as { port: number }).port;
  const connection = { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' };
  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'bonjour', connection });
  const { events, stop } = collectAgentEvents(worker, runId);
  await waitUntilDone(events);
  stop();
  assert.equal(events.at(-1).kind, 'done');
  const init = fake.receivedRequests.find(r => r.message.method === 'initialize');
  assert.equal(init?.headers.authorization, SECRET_HEADER, 'the remote server really received the real, unredacted header');
});

async function exists(file: string) {
  try { await readFile(file); return true; } catch { return false; }
}
function isAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error: any) { return error.code === 'EPERM'; }
}
async function until(check: () => boolean | Promise<boolean>, what: string, timeout = 15000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
/** A real model: request 1 asks for mcp_echo when `callTool`, every other request ends the turn. Records the tool
 * names each request offered. */
async function model(t: any, callTool: boolean) {
  let count = 0;
  const offered: string[][] = [];
  const server = createServer((request, response) => {
    count++;
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      offered.push((JSON.parse(body).tools ?? []).map((tool: any) => tool.function.name));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(callTool && count === 1
        ? { choices: [{ message: { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'mcp_echo', arguments: JSON.stringify({ text: 'x' }) } }] }, finish_reason: 'tool_calls' }] }
        : { choices: [{ message: { content: 'Fait.' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve(undefined)); }));
  const port = (server.address() as { port: number }).port;
  return { offered, connection: { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' } };
}
/** One whole turn in `folder`; returns its events. */
async function runTurn(worker: Worker, folder: string, connection: unknown) {
  const { runId } = await callWorker(worker, 'send', { folder, branchId: 'main', text: 'bonjour', connection });
  const { events, stop } = collectAgentEvents(worker, runId);
  await waitUntilDone(events);
  stop();
  return events;
}
const entry = (list: any[], scope: string) => list.find(server => server.scope === scope);

test('the Outils tab never starts an MCP server: plugin-list and mcp-list leave it stopped; a turn starts it and its tools are remembered', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-mcp-not-started-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const marker = join(root, 'mcp-started.txt');
  await writeFile(join(home, 'mcp.json'), JSON.stringify([{ id: 'fake', command: process.execPath, args: [FAKE_MCP_SERVER], env: { FAKE_MCP_MARKER: marker }, added_at: new Date().toISOString() }]));
  const worker = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } }));
  await callWorker(worker, 'save-global-settings', { patch: { agent_mode: 'auto', permission_mode: 'auto' } });

  await callWorker(worker, 'plugin-list', { folder: project });
  await callWorker(worker, 'plugin-list', { folder: null });
  const before = await callWorker(worker, 'mcp-list', { folder: project });
  assert.equal(await exists(marker), false, 'neither plugin-list nor mcp-list started the server');
  assert.equal(before[0].tools, null, 'not started: no tools to show yet');
  assert.equal(before[0].error, null, 'not started: no error either, so « non démarré »');

  const { connection } = await model(t, false);
  const events = await runTurn(worker, project, connection);
  assert.equal(events.at(-1).kind, 'done', JSON.stringify(events.at(-1)));
  assert.equal(await exists(marker), true, 'the turn started it');
  assert.deepEqual((await callWorker(worker, 'mcp-list', { folder: project }))[0].tools, ['mcp_echo', 'mcp_boom']);
  assert.deepEqual((await callWorker(worker, 'mcp-list', {}))[0].tools, ['mcp_echo', 'mcp_boom'], 'the same server, no active folder');

  await rm(marker);
  await callWorker(worker, 'plugin-list', { folder: project });
  await callWorker(worker, 'mcp-list', { folder: project });
  assert.equal(await exists(marker), false, 'showing the remembered tools never restarts the server');
});

test('a server whose last discovery failed shows its error in mcp-list, not « non démarré », and an expanded ${VAR} is never in it', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-mcp-failed-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  await writeFile(join(home, 'mcp.json'), JSON.stringify([{ id: 'crash', command: process.execPath, args: [FAKE_MCP_SERVER], env: { FAKE_MCP_CRASH: '1' }, added_at: new Date().toISOString() }]));
  // A remote project server whose URL is a placeholder: its expanded value is a secret, and the discovery error
  // (« Failed to parse URL from <url> ») would carry it.
  await writeFile(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { distant: { type: 'http', url: '${OA_TEST_MCP_URL}' } } }));
  const worker = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home, OA_TEST_MCP_URL: 'pas-une-url-secret-4242' } }));
  await approveProject(worker, project);

  const before = await callWorker(worker, 'mcp-list', { folder: project });
  for (const scope of ['global', 'project']) {
    assert.equal(entry(before, scope).tools, null, `${scope}: not started`);
    assert.equal(entry(before, scope).error, null, `${scope}: never started, so no error, « non démarré »`);
  }

  const { connection } = await model(t, false);
  assert.equal((await runTurn(worker, project, connection)).at(-1).kind, 'done', 'a failing server never fails the turn');
  const after = await callWorker(worker, 'mcp-list', { folder: project });
  assert.equal(entry(after, 'global').tools, null);
  assert.match(entry(after, 'global').error, /serveur MCP terminé/, 'the crash is shown');
  assert.equal(entry(after, 'project').tools, null);
  assert.match(entry(after, 'project').error, /Failed to parse URL from \$\{OA_TEST_MCP_URL\}/, 'the error, with the URL as written');
  assert.doesNotMatch(JSON.stringify(after), /secret-4242/, 'the expanded secret never reaches the renderer');
  assert.match((await callWorker(worker, 'mcp-list', {}))[0].error, /serveur MCP terminé/, 'the same global server, no active folder');
});

test('the tool names listed are those a turn offers: an invalid name, or one another server already took, is not listed', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-mcp-offered-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  // Two identities (different args), both exposing echo/boom: the project server, listed first, wins them.
  await writeFile(join(home, 'mcp.json'), JSON.stringify([{ id: 'g', command: process.execPath, args: [FAKE_MCP_SERVER, 'global'], env: { FAKE_MCP_EXTRA_TOOL_NAME: 'propre' }, added_at: new Date().toISOString() }]));
  await writeFile(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { p: { command: process.execPath, args: [FAKE_MCP_SERVER, 'project'], env: { FAKE_MCP_EXTRA_TOOL_NAME: 'nom avec espaces' } } } }));
  const worker = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } }));
  await callWorker(worker, 'save-global-settings', { patch: { agent_mode: 'auto', permission_mode: 'auto' } });
  await approveProject(worker, project);

  const { connection, offered } = await model(t, false);
  assert.equal((await runTurn(worker, project, connection)).at(-1).kind, 'done');
  const listed = await callWorker(worker, 'mcp-list', { folder: project });
  assert.deepEqual(entry(listed, 'project').tools, ['mcp_echo', 'mcp_boom'], 'its invalid « mcp_nom avec espaces » is not listed');
  assert.deepEqual(entry(listed, 'global').tools, ['mcp_propre'], 'its echo/boom went to the project server');
  assert.deepEqual([...entry(listed, 'project').tools, ...entry(listed, 'global').tools].sort(), offered[0].filter(name => name.startsWith('mcp_')).sort(), 'exactly what the turn offered');
  // No active folder: no project server takes echo/boom, so what a turn without project servers would offer.
  assert.deepEqual((await callWorker(worker, 'mcp-list', {}))[0].tools, ['mcp_echo', 'mcp_boom', 'mcp_propre']);
});

test('a project server\'s remembered tools are shown for that project only, never for another project running the same server', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-mcp-per-project-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  const beta = join(root, 'beta');
  await Promise.all([mkdir(home), mkdir(alpha), mkdir(beta)]);
  const betaMarker = join(root, 'beta-started.txt');
  // The same command + args (one server identity) in both projects.
  await writeFile(join(alpha, '.mcp.json'), JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [FAKE_MCP_SERVER] } } }));
  await writeFile(join(beta, '.mcp.json'), JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [FAKE_MCP_SERVER], env: { FAKE_MCP_MARKER: betaMarker } } } }));
  const worker = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } }));
  await approveProject(worker, alpha);
  await approveProject(worker, beta);

  const { connection } = await model(t, false);
  assert.equal((await runTurn(worker, alpha, connection)).at(-1).kind, 'done');
  assert.deepEqual(entry(await callWorker(worker, 'mcp-list', { folder: alpha }), 'project').tools, ['mcp_echo', 'mcp_boom']);
  const inBeta = entry(await callWorker(worker, 'mcp-list', { folder: beta }), 'project');
  assert.equal(inBeta.tools, null, 'beta\'s server was never started: alpha\'s discovery is not beta\'s');
  assert.equal(inBeta.error, null);
  await callWorker(worker, 'plugin-list', { folder: beta });
  assert.equal(await exists(betaMarker), false, 'nor started by beta\'s Outils tab');
  assert.deepEqual(await callWorker(worker, 'mcp-list', {}), [], 'no active folder: no project server at all');
});

test('quitting the app (main.cjs::stopWorker) stops the MCP server a turn left in the middle of a call', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-mcp-quit-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const pidFile = join(root, 'mcp-pids.txt');
  await writeFile(join(home, 'mcp.json'), JSON.stringify([{
    id: 'slow', command: process.execPath, args: [FAKE_MCP_SERVER],
    env: { FAKE_MCP_PID_FILE: pidFile, FAKE_MCP_CALL_DELAY_MS: '60000' }, added_at: new Date().toISOString(),
  }]));
  const worker = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } }));
  await callWorker(worker, 'save-global-settings', { patch: { agent_mode: 'auto', permission_mode: 'auto' } });
  const pids = async () => {
    try { return (await readFile(pidFile, 'utf8')).split('\n').filter(Boolean).map(Number); } catch { return []; }
  };

  const { connection } = await model(t, true);
  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'appelle mcp_echo', connection });
  const { events, stop } = collectAgentEvents(worker, runId);
  t.after(stop);
  // One process for the discovery (closed right after it), one for the call, still running: the call takes 60 s.
  await until(async () => events.some(e => e.kind === 'tool-start') && (await pids()).length >= 2, 'the MCP call in flight');
  const started = await pids();
  assert.ok(started.some(isAlive), `the server answering the call runs before the quit (pids ${started.join(', ')})`);

  await stopWorker(worker, 3000);
  await until(() => started.every(pid => !isAlive(pid)), `every MCP process gone after the quit (pids ${started.join(', ')})`, 10000);
});

test('quitting the app (main.cjs::stopWorker) during an MCP discovery stops that server too', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-mcp-quit-discovery-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const pidFile = join(root, 'mcp-pids.txt');
  // Its initialize answer takes 60 s, and it stays alive meanwhile even once its stdin is closed.
  await writeFile(join(home, 'mcp.json'), JSON.stringify([{
    id: 'slow-start', command: process.execPath, args: [FAKE_MCP_SERVER],
    env: { FAKE_MCP_PID_FILE: pidFile, FAKE_MCP_INIT_DELAY_MS: '60000' }, added_at: new Date().toISOString(),
  }]));
  const worker = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } }));
  const pids = async () => {
    try { return (await readFile(pidFile, 'utf8')).split('\n').filter(Boolean).map(Number); } catch { return []; }
  };

  const { connection } = await model(t, false);
  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'bonjour', connection });
  const { stop } = collectAgentEvents(worker, runId);
  t.after(stop);
  await until(async () => (await pids()).length >= 1, 'the discovery process started');
  const started = await pids();
  assert.ok(started.every(isAlive), `the server being discovered runs before the quit (pids ${started.join(', ')})`);

  await stopWorker(worker, 3000);
  // Well under the 10 s discovery timeout, which died with the worker anyway.
  await until(() => started.every(pid => !isAlive(pid)), `every MCP process gone after the quit (pids ${started.join(', ')})`, 5000);
});

test('the tool names listed follow the agent mode: a mode that never offers MCP tools lists none', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-mcp-mode-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  await writeFile(join(home, 'mcp.json'), JSON.stringify([{ id: 'fake', command: process.execPath, args: [FAKE_MCP_SERVER], added_at: new Date().toISOString() }]));
  const worker = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } }));
  await callWorker(worker, 'save-global-settings', { patch: { agent_mode: 'auto', permission_mode: 'demander' } });

  const { connection, offered } = await model(t, false);
  assert.equal((await runTurn(worker, project, connection)).at(-1).kind, 'done');
  assert.ok(offered[0].includes('mcp_echo'), 'auto + demander: the model is offered the MCP tools');
  assert.deepEqual((await callWorker(worker, 'mcp-list', { folder: project }))[0].tools, ['mcp_echo', 'mcp_boom']);

  for (const patch of [{ agent_mode: 'plan', permission_mode: 'demander' }, { agent_mode: 'ask', permission_mode: 'demander' }, { agent_mode: 'auto', permission_mode: 'strict' }]) {
    await callWorker(worker, 'save-global-settings', { patch });
    assert.deepEqual((await callWorker(worker, 'mcp-list', { folder: project }))[0].tools, [], `${JSON.stringify(patch)}: the model would get none`);
    assert.deepEqual((await callWorker(worker, 'mcp-list', {}))[0].tools, [], `${JSON.stringify(patch)}, no active folder: none either`);
  }
  // And it is what a turn in that mode really offers.
  const before = offered.length;
  assert.equal((await runTurn(worker, project, connection)).at(-1).kind, 'done');
  assert.ok(!offered[before].some(name => name.startsWith('mcp_')), `auto + strict: no MCP tool offered (got ${offered[before].join(',')})`);
});

test('mcp-remove forgets what the turns learned of that server: re-added, it is « non démarré » again', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-mcp-remove-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const worker = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } }));
  const commandLine = `"${process.execPath}" "${FAKE_MCP_SERVER}"`;
  const [added] = await callWorker(worker, 'mcp-add', { commandLine });

  const { connection } = await model(t, false);
  assert.equal((await runTurn(worker, project, connection)).at(-1).kind, 'done');
  assert.deepEqual((await callWorker(worker, 'mcp-list', { folder: project }))[0].tools, ['mcp_echo', 'mcp_boom']);

  await callWorker(worker, 'mcp-remove', { id: added.id });
  await callWorker(worker, 'mcp-add', { commandLine });
  const [again] = await callWorker(worker, 'mcp-list', { folder: project });
  assert.equal(again.tools, null, 'the same command, added again: not started since');
  assert.equal(again.error, null);
});
