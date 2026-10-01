import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-mcp-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home);
  return home;
}

test('list() on a missing mcp.json returns an empty array, not a crash', async t => {
  const home = await fixture(t);
  const { McpConfigStore } = await import('../core/mcp-config.mts');
  assert.deepEqual(await new McpConfigStore(home).list(), []);
});

test('add() splits a command line into command + args, like settings.py::add_server', async t => {
  const home = await fixture(t);
  const { McpConfigStore } = await import('../core/mcp-config.mts');
  const store = new McpConfigStore(home);
  const list = await store.add('npx -y @modelcontextprotocol/server-filesystem /tmp');
  assert.equal(list.length, 1);
  assert.equal((list[0] as any).command, 'npx');
  assert.deepEqual((list[0] as any).args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
  assert.match(list[0].id, /.+/);
});

test('add() rejects a blank command line', async t => {
  const home = await fixture(t);
  const { McpConfigStore } = await import('../core/mcp-config.mts');
  await assert.rejects(new McpConfigStore(home).add('   '));
});

test('remove() forgets a server by id; an unknown id is a harmless no-op', async t => {
  const home = await fixture(t);
  const { McpConfigStore } = await import('../core/mcp-config.mts');
  const store = new McpConfigStore(home);
  await store.add('server-one');
  const [entry] = await store.add('server-two');
  const afterUnknown = await store.remove('not-a-real-id');
  assert.equal(afterUnknown.length, 2);
  const afterRemove = await store.remove(entry.id);
  assert.equal(afterRemove.length, 1);
  assert.equal((afterRemove[0] as any).command, 'server-one');
});

test('list() drops a malformed entry from a hand-edited mcp.json rather than crashing', async t => {
  const home = await fixture(t);
  const { writeFile } = await import('node:fs/promises');
  const good = { id: 'a1', command: 'ok', args: [], added_at: new Date().toISOString() };
  await writeFile(join(home, 'mcp.json'), JSON.stringify([good, { args: ['no-command'] }, 'garbage']));
  const { McpConfigStore } = await import('../core/mcp-config.mts');
  const list = await new McpConfigStore(home).list();
  assert.equal(list.length, 1);
  assert.equal((list[0] as any).command, 'ok');
});

test('add() persists an optional env, list() returns it tagged scope=global', async t => {
  const home = await fixture(t);
  const store = new (await import('../core/mcp-config.mts')).McpConfigStore(home);
  const result = await store.add('npx -y pkg', { API_KEY: 'secret-value' });
  assert.equal(result[0].scope, 'global');
  assert.equal((result[0] as any).env.API_KEY, 'secret-value');
  const relisted = await store.list();
  assert.equal((relisted[0] as any).env.API_KEY, 'secret-value', 'persisted to disk, not just in-memory');
});

test('add() without env omits the field entirely (no empty {} noise on disk)', async t => {
  const home = await fixture(t);
  const { McpConfigStore } = await import('../core/mcp-config.mts');
  const store = new McpConfigStore(home);
  await store.add('npx -y pkg');
  const raw = JSON.parse(await (await import('node:fs/promises')).readFile((await import('node:path')).join(home, 'mcp.json'), 'utf8'));
  assert.equal('env' in raw[0], false);
});

test('addRemote() persists a real SSE/HTTP server definition, tagged scope=global', async t => {
  const home = await fixture(t);
  const { McpConfigStore } = await import('../core/mcp-config.mts');
  const store = new McpConfigStore(home);
  const result = await store.addRemote('https://example.com/mcp', 'sse', { Authorization: 'Bearer tok' });
  assert.equal(result.length, 1);
  assert.equal(result[0].scope, 'global');
  assert.equal((result[0] as any).type, 'sse');
  assert.equal((result[0] as any).url, 'https://example.com/mcp');
  assert.equal((result[0] as any).headers.Authorization, 'Bearer tok');
});

test('addRemote() refuses an empty URL', async t => {
  const home = await fixture(t);
  const { McpConfigStore } = await import('../core/mcp-config.mts');
  const store = new McpConfigStore(home);
  await assert.rejects(store.addRemote('   ', 'http'), /URL/);
});

test('readProjectMcpConfig reads a real .mcp.json, Claude Code schema, tagged scope=project', async t => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'openagent-mcp-project-'));
  t.after(() => import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, '.mcp.json'), JSON.stringify({
    mcpServers: {
      filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], env: { ROOT: '/tmp' } },
      remote: { type: 'sse', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
    },
  }));
  const { readProjectMcpConfig } = await import('../core/mcp-config.mts');
  const servers = await readProjectMcpConfig(project);
  assert.equal(servers.length, 2);
  const fs = servers.find((s: any) => s.name === 'filesystem') as any;
  assert.equal(fs.scope, 'project');
  assert.equal(fs.command, 'npx');
  assert.deepEqual(fs.args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
  assert.equal(fs.env.ROOT, '/tmp');
  const remote = servers.find((s: any) => s.name === 'remote') as any;
  assert.equal(remote.type, 'sse');
  assert.equal(remote.url, 'https://example.com/mcp');
});

test('readProjectMcpConfig on a missing .mcp.json returns an empty list, never throws', async t => {
  const { mkdtemp, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'openagent-mcp-noproject-'));
  t.after(() => import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })));
  const project = join(root, 'project');
  await mkdir(project);
  const { readProjectMcpConfig } = await import('../core/mcp-config.mts');
  assert.deepEqual(await readProjectMcpConfig(project), []);
});

test('readProjectMcpConfig on a malformed .mcp.json (bad JSON) returns an empty list, never throws', async t => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'openagent-mcp-badjson-'));
  t.after(() => import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, '.mcp.json'), '{ not valid json');
  const { readProjectMcpConfig } = await import('../core/mcp-config.mts');
  assert.deepEqual(await readProjectMcpConfig(project), []);
});

test('readProjectMcpConfig skips one invalid entry, keeps the valid ones', async t => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'openagent-mcp-mixedvalid-'));
  t.after(() => import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, '.mcp.json'), JSON.stringify({
    mcpServers: { good: { command: 'npx', args: [] }, bad: { neitherCommandNorUrl: true } },
  }));
  const { readProjectMcpConfig } = await import('../core/mcp-config.mts');
  const servers = await readProjectMcpConfig(project);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, 'good');
});

test('mergeServerConfigs: a project server with the same command+args as a global one replaces it (project wins)', async () => {
  const { mergeServerConfigs } = await import('../core/mcp-config.mts');
  const global: any[] = [{ id: 'g1', scope: 'global', command: 'npx', args: ['-y', 'pkg'], added_at: '2020-01-01' }];
  const project: any[] = [{ id: 'filesystem', name: 'filesystem', scope: 'project', command: 'npx', args: ['-y', 'pkg'], env: { X: '1' } }];
  const merged = mergeServerConfigs(global, project);
  assert.equal(merged.length, 1, 'the colliding global entry is dropped, only the project one remains');
  assert.equal(merged[0].scope, 'project');
  assert.equal((merged[0] as any).env.X, '1');
});

test('mergeServerConfigs: non-colliding servers from both scopes are all kept', async () => {
  const { mergeServerConfigs } = await import('../core/mcp-config.mts');
  const global: any[] = [{ id: 'g1', scope: 'global', command: 'a', args: [], added_at: '2020-01-01' }];
  const project: any[] = [{ id: 'b', name: 'b', scope: 'project', command: 'b', args: [] }];
  const merged = mergeServerConfigs(global, project);
  assert.equal(merged.length, 2);
});

test('mergeServerConfigs: a remote server collision is identified by url, not by name', async () => {
  const { mergeServerConfigs } = await import('../core/mcp-config.mts');
  const global: any[] = [{ id: 'g1', scope: 'global', type: 'sse', url: 'https://example.com/mcp', added_at: '2020-01-01' }];
  const project: any[] = [{ id: 'remote', name: 'remote', scope: 'project', type: 'sse', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer y' } }];
  const merged = mergeServerConfigs(global, project);
  assert.equal(merged.length, 1);
  assert.equal((merged[0] as any).headers.Authorization, 'Bearer y');
});

/** Sets (or, with `undefined`, unsets) real process.env variables for one test, restoring the
 * previous values — including "was unset" — afterwards. */
function withEnv(t: { after(fn: () => void): void }, vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    const had = Object.prototype.hasOwnProperty.call(process.env, key);
    const previous = process.env[key];
    t.after(() => { if (had) process.env[key] = previous; else delete process.env[key]; });
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

async function projectWith(t: { after(fn: () => unknown): void }, servers: Record<string, unknown>): Promise<string> {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'openagent-mcp-expand-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
  return project;
}

test('readProjectMcpConfig expands ${VAR} and ${VAR:-default} from process.env, like Claude Code', async t => {
  withEnv(t, { OA_TEST_TOKEN: 'real-token-123', OA_TEST_BIN: 'node', OA_TEST_UNSET: undefined, OA_TEST_EMPTY: '' });
  const project = await projectWith(t, {
    local: {
      command: '${OA_TEST_BIN}',
      args: ['--token=${OA_TEST_TOKEN}', '${OA_TEST_UNSET:-fallback-arg}', 'plain'],
      env: { TOKEN: '${OA_TEST_TOKEN}', MISSING: '${OA_TEST_UNSET}', EMPTY_DEFAULT: '${OA_TEST_EMPTY:-was-empty}' },
    },
    distant: {
      type: 'http',
      url: 'https://${OA_TEST_UNSET:-mcp.example.com}/v1',
      headers: { Authorization: 'Bearer ${OA_TEST_TOKEN}', 'X-Team': '${OA_TEST_UNSET:-default-team}' },
    },
  });
  const { readProjectMcpConfig } = await import('../core/mcp-config.mts');
  const servers = await readProjectMcpConfig(project);
  const local = servers.find(s => s.id === 'local') as any;
  assert.equal(local.command, 'node');
  assert.deepEqual(local.args, ['--token=real-token-123', 'fallback-arg', 'plain']);
  assert.deepEqual(local.env, { TOKEN: 'real-token-123', MISSING: '', EMPTY_DEFAULT: 'was-empty' });
  const distant = servers.find(s => s.id === 'distant') as any;
  assert.equal(distant.url, 'https://mcp.example.com/v1');
  assert.deepEqual(distant.headers, { Authorization: 'Bearer real-token-123', 'X-Team': 'default-team' });
});

test('readProjectMcpConfig: a set variable wins over its default; a value with "$&" is inserted literally', async t => {
  withEnv(t, { OA_TEST_TOKEN: 'a$&b$1' });
  const project = await projectWith(t, { s: { command: 'x', args: ['${OA_TEST_TOKEN:-unused}'] } });
  const { readProjectMcpConfig } = await import('../core/mcp-config.mts');
  const [server] = await readProjectMcpConfig(project) as any[];
  assert.deepEqual(server.args, ['a$&b$1']);
});

test('readProjectMcpConfig({ expandEnv: false }) returns the entries exactly as written', async t => {
  withEnv(t, { OA_TEST_TOKEN: 'real-token-123' });
  const project = await projectWith(t, { s: { command: 'x', args: ['${OA_TEST_TOKEN}'], env: { T: '${OA_TEST_TOKEN}' } } });
  const { readProjectMcpConfig } = await import('../core/mcp-config.mts');
  const [server] = await readProjectMcpConfig(project, { expandEnv: false }) as any[];
  assert.deepEqual(server.args, ['${OA_TEST_TOKEN}']);
  assert.deepEqual(server.env, { T: '${OA_TEST_TOKEN}' });
});

test('the global mcp.json store never expands placeholders (the user types real values there)', async t => {
  withEnv(t, { OA_TEST_TOKEN: 'real-token-123' });
  const home = await fixture(t);
  const { McpConfigStore } = await import('../core/mcp-config.mts');
  const store = new McpConfigStore(home);
  await store.add('x --token=${OA_TEST_TOKEN}');
  const [server] = await store.list() as any[];
  assert.deepEqual(server.args, ['--token=${OA_TEST_TOKEN}']);
});
