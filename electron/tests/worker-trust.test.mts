import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';

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
async function exists(file: string) {
  try { await readFile(file); return true; } catch { return false; }
}
const markerPlugin = (marker: string, name: string) => `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'ran');
export function getTools() { return [{ name: ${JSON.stringify(name)}, description: 'x', properties: {}, execute: async () => 'ok' }]; }
`;

async function setup(t: any, prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);
  return { root, home, project, worker };
}

/** A fake model: odd requests ask for `toolCall` (when given), even requests end the turn. */
async function fakeModel(t: any, toolCall?: () => { name: string; arguments: Record<string, unknown> }) {
  let count = 0;
  const server = createServer((request, response) => {
    count++;
    request.on('data', () => {});
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      if (toolCall && count % 2 === 1) {
        const call = toolCall();
        response.end(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: `call-${count}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, finish_reason: 'tool_calls' }] }));
      } else {
        response.end(JSON.stringify({ choices: [{ message: { content: 'Fait.' }, finish_reason: 'stop' }] }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  const port = (server.address() as { port: number }).port;
  return { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' };
}

/** Runs one turn; answers every permission request with `allow`/`always`. */
async function turn(worker: Worker, folder: string, connection: unknown, decision = { allow: true, always: false }) {
  const { runId } = await callWorker(worker, 'send', { folder, branchId: 'main', text: 'vas-y', connection });
  const { events, stop } = collectAgentEvents(worker, runId);
  const answered = new Set<string>();
  while (!events.some(e => ['done', 'error', 'stopped'].includes(e.kind))) {
    for (const event of events) {
      if (event.kind === 'permission-request' && !answered.has(event.requestId)) {
        answered.add(event.requestId);
        await callWorker(worker, 'permission-decision', { runId, requestId: event.requestId, ...decision });
      }
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  stop();
  return events;
}

test('nothing a project brings runs before approval — not on evaluation, Outils tab, mcp-list or a turn', { timeout: 30000 }, async t => {
  const { root, project, worker } = await setup(t, 'openagent-worker-trust-gate-');
  const pluginMarker = join(root, 'plugin-ran.txt');
  const mcpMarker = join(root, 'mcp-started.txt');
  await mkdir(join(project, 'tools'));
  await writeFile(join(project, 'tools', 'marker.mjs'), markerPlugin(pluginMarker, 'marker_tool'));
  await writeFile(join(project, '.mcp.json'), JSON.stringify({
    mcpServers: { fake: { command: process.execPath, args: [FAKE_MCP_SERVER], env: { FAKE_MCP_MARKER: mcpMarker } } },
  }));
  const connection = await fakeModel(t);

  const shown = await callWorker(worker, 'project-trust', { folder: project });
  assert.equal(shown.state, 'pending');
  assert.deepEqual(shown.plugins, ['tools/marker.mjs']);
  assert.equal(shown.mcpServers.length, 1);
  assert.notEqual(shown.mcpServers[0].env.FAKE_MCP_MARKER, mcpMarker, 'env values never reach the renderer');

  const plugins = await callWorker(worker, 'plugin-list', { folder: project });
  assert.deepEqual(plugins.tools, []);
  assert.deepEqual(plugins.untrusted, ['tools/marker.mjs']);
  const servers = await callWorker(worker, 'mcp-list', { folder: project });
  assert.equal(servers.find((server: any) => server.scope === 'project').trusted, false);
  const events = await turn(worker, project, connection);
  assert.equal(events.at(-1).kind, 'done');
  assert.equal(await exists(pluginMarker), false, 'the project plugin never ran');
  assert.equal(await exists(mcpMarker), false, 'the project MCP server never started');

  await callWorker(worker, 'trust-project', { folder: project, decision: 'trusted', token: shown.token });
  const trusted = await callWorker(worker, 'plugin-list', { folder: project });
  assert.deepEqual(trusted.tools, ['marker_tool']);
  assert.deepEqual(trusted.untrusted, []);
  const trustedServers = await callWorker(worker, 'mcp-list', { folder: project });
  assert.equal(trustedServers.find((server: any) => server.scope === 'project').trusted, true, 'the project entry is listed as trusted once approved');
  assert.equal(await exists(pluginMarker), true, 'loaded once trusted');
  assert.equal(await exists(mcpMarker), true, 'started once trusted');
});

test('a plugin added after approval is not loaded until the project is approved again', { timeout: 30000 }, async t => {
  const { root, project, worker } = await setup(t, 'openagent-worker-trust-added-');
  await mkdir(join(project, 'tools'));
  await writeFile(join(project, 'tools', 'first.mjs'), markerPlugin(join(root, 'first.txt'), 'first_tool'));
  const shown = await callWorker(worker, 'project-trust', { folder: project });
  await callWorker(worker, 'trust-project', { folder: project, decision: 'trusted', token: shown.token });

  const secondMarker = join(root, 'second.txt');
  await writeFile(join(project, 'tools', 'second.mjs'), markerPlugin(secondMarker, 'second_tool'));
  const plugins = await callWorker(worker, 'plugin-list', { folder: project });
  assert.deepEqual(plugins.tools, [], 'the changed project is untrusted as a whole');
  assert.equal(await exists(secondMarker), false);
  const after = await callWorker(worker, 'project-trust', { folder: project });
  assert.equal(after.state, 'pending');
  assert.equal(after.changed, true);
});

test('a decision made on a stale listing is refused', async t => {
  const { project, worker } = await setup(t, 'openagent-worker-trust-stale-');
  await mkdir(join(project, 'tools'));
  await writeFile(join(project, 'tools', 'a.mjs'), 'export {}');
  const shown = await callWorker(worker, 'project-trust', { folder: project });
  await writeFile(join(project, 'tools', 'a.mjs'), 'export const swapped = 1;');
  await assert.rejects(callWorker(worker, 'trust-project', { folder: project, decision: 'trusted', token: shown.token }), /a changé depuis l’affichage/);
});

test('a repo-shipped shell_ask:false is ignored until the project is trusted', { timeout: 30000 }, async t => {
  const { project, worker } = await setup(t, 'openagent-worker-trust-shell-');
  await mkdir(join(project, '.openagent'));
  await writeFile(join(project, '.openagent', 'config.json'), JSON.stringify({ override_permissions: true, shell_ask: false }));
  const connection = await fakeModel(t, () => ({ name: 'run_command', arguments: { command: 'echo confiance' } }));

  const refused = await turn(worker, project, connection, { allow: false, always: false });
  assert.ok(refused.some(e => e.kind === 'permission-request'), 'still asks: the shipped relaxation is not applied');

  const shown = await callWorker(worker, 'project-trust', { folder: project });
  assert.deepEqual(shown.relaxations, { shell_ask: { project: false, global: true } });
  await callWorker(worker, 'trust-project', { folder: project, decision: 'trusted', token: shown.token });
  const trusted = await turn(worker, project, connection);
  assert.equal(trusted.some(e => e.kind === 'permission-request'), false, 'applied once approved');
});

test('"Toujours" on a file write works at once and writes nothing to the project (session only)', { timeout: 30000 }, async t => {
  const { project, worker } = await setup(t, 'openagent-worker-trust-always-');
  let file = 0;
  const connection = await fakeModel(t, () => ({ name: 'create_file', arguments: { path: `f${++file}.txt`, content: 'ok' } }));

  const first = await turn(worker, project, connection, { allow: true, always: true });
  assert.ok(first.some(e => e.kind === 'permission-request'), 'the default asks for a write');
  const second = await turn(worker, project, connection);
  assert.equal(second.some(e => e.kind === 'permission-request'), false, '"Toujours" is effective right away');
  assert.equal(await exists(join(project, '.openagent', 'config.json')), false, 'no project config is written');
  const view = await callWorker(worker, 'project-trust', { folder: project });
  assert.notEqual(view.state, 'pending', 'nothing for the user to approve');
  assert.deepEqual(view.relaxations, {});
});

test('the project-trust view tells each part apart: trusted plugins stay "trusted" while a new repo relaxation is pending', async t => {
  const { project, worker } = await setup(t, 'openagent-worker-trust-parts-');
  await mkdir(join(project, 'tools'));
  await writeFile(join(project, 'tools', 'a.mjs'), markerPlugin(join(project, '..', 'a.txt'), 'a_tool'));
  await callWorker(worker, 'trust-project', { folder: project, decision: 'trusted', token: (await callWorker(worker, 'project-trust', { folder: project })).token });
  await mkdir(join(project, '.openagent'), { recursive: true });
  await writeFile(join(project, '.openagent', 'config.json'), JSON.stringify({ override_permissions: true, shell_ask: false }));

  const view = await callWorker(worker, 'project-trust', { folder: project });
  assert.equal(view.state, 'pending');
  assert.equal(view.contentStatus, 'trusted');
  assert.deepEqual(view.relaxationStatus, { shell_ask: 'pending' });
  assert.equal(view.unreadable, false);
  assert.equal(view.changed, false);
  assert.deepEqual((await callWorker(worker, 'plugin-list', { folder: project })).tools, ['a_tool'], 'and the plugin really is loaded');
});

test('a project whose own config.json is invalid, or a folder that is gone, never hides the GLOBAL servers in mcp-list', async t => {
  const { root, project, worker } = await setup(t, 'openagent-worker-trust-mcplist-');
  await callWorker(worker, 'mcp-add', { commandLine: 'npx -y global-server' });
  await mkdir(join(project, '.openagent'));
  await writeFile(join(project, '.openagent', 'config.json'), '{ not json');
  await writeFile(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: 'npx', args: ['local-server'] } } }));

  const servers = await callWorker(worker, 'mcp-list', { folder: project });
  assert.ok(servers.some((server: any) => server.scope === 'global' && server.args.includes('global-server')), 'the global server is still listed');
  const local = servers.find((server: any) => server.scope === 'project');
  assert.equal(local?.trusted, false, 'the readable project entry is listed, as untrusted');

  const gone = await callWorker(worker, 'mcp-list', { folder: join(root, 'deleted-folder') });
  assert.deepEqual(gone.map((server: any) => server.scope), ['global']);
});

test('revoke makes a trusted project pending again', async t => {
  const { project, worker } = await setup(t, 'openagent-worker-trust-revoke-');
  await mkdir(join(project, 'tools'));
  await writeFile(join(project, 'tools', 'a.mjs'), 'export {}');
  const shown = await callWorker(worker, 'project-trust', { folder: project });
  await callWorker(worker, 'trust-project', { folder: project, decision: 'trusted', token: shown.token });
  assert.equal((await callWorker(worker, 'trust-project', { folder: project, decision: 'revoke' })).state, 'pending');
});

test('revoking or ignoring a project\'s trust forgets its session « Toujours »: the next write asks again', { timeout: 60000 }, async t => {
  for (const [label, forget] of [
    ['revoke', (worker: Worker, folder: string) => callWorker(worker, 'trust-project', { folder, decision: 'revoke' })],
    ['ignored', async (worker: Worker, folder: string) => callWorker(worker, 'trust-project', { folder, decision: 'ignored', token: (await callWorker(worker, 'project-trust', { folder })).token })],
  ] as const) {
    const { root, project, worker } = await setup(t, `openagent-worker-trust-forget-${label}-`);
    const other = join(root, 'other');
    await mkdir(other);
    await mkdir(join(project, 'tools'));
    await writeFile(join(project, 'tools', 'a.mjs'), markerPlugin(join(root, 'plugin-ran.txt'), 'a_tool'));
    let file = 0;
    const connection = await fakeModel(t, () => ({ name: 'create_file', arguments: { path: `f${++file}.txt`, content: 'ok' } }));
    const shown = await callWorker(worker, 'project-trust', { folder: project });
    await callWorker(worker, 'trust-project', { folder: project, decision: 'trusted', token: shown.token });

    assert.ok((await turn(worker, project, connection, { allow: true, always: true })).some(e => e.kind === 'permission-request'), `${label}: the first write asks`);
    assert.ok((await turn(worker, other, connection, { allow: true, always: true })).some(e => e.kind === 'permission-request'), `${label}: so does the other project's`);
    assert.equal((await turn(worker, project, connection)).some(e => e.kind === 'permission-request'), false, `${label}: « Toujours » holds in the project`);

    await forget(worker, project);
    assert.ok((await turn(worker, project, connection)).some(e => e.kind === 'permission-request'), `${label}: the next write asks again`);
    assert.equal((await turn(worker, other, connection)).some(e => e.kind === 'permission-request'), false, `${label}: another project keeps its « Toujours »`);
  }
});
