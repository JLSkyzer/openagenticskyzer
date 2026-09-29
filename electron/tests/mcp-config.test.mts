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
  assert.equal(list[0].command, 'npx');
  assert.deepEqual(list[0].args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
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
  assert.equal(afterRemove[0].command, 'server-one');
});

test('list() drops a malformed entry from a hand-edited mcp.json rather than crashing', async t => {
  const home = await fixture(t);
  const { writeFile } = await import('node:fs/promises');
  const good = { id: 'a1', command: 'ok', args: [], added_at: new Date().toISOString() };
  await writeFile(join(home, 'mcp.json'), JSON.stringify([good, { args: ['no-command'] }, 'garbage']));
  const { McpConfigStore } = await import('../core/mcp-config.mts');
  const list = await new McpConfigStore(home).list();
  assert.equal(list.length, 1);
  assert.equal(list[0].command, 'ok');
});
