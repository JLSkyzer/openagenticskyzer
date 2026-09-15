import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = join(root, 'a'); const b = join(root, 'b');
  await Promise.all([a, b].map(p => mkdir(p)));
  const { workspaceTools } = await import('../core/workspace.mts');
  const tools = await workspaceTools(a, 'node_modules/, dist/, ignored.txt');
  async function invoke(name: string, args: Record<string, unknown>) {
    const tool = tools.find(t => t.name === name)!;
    assert.ok(tool, `Missing ${name}`);
    tool.validate(args);
    return tool.execute(args, new AbortController().signal);
  }
  return { root, a, b, invoke };
}

test('workspace file tools use their captured project and preserve existing files on create/edit errors', async t => {
  const { a, b, invoke } = await fixture(t);
  await writeFile(join(b, 'file.txt'), 'other-project');
  await invoke('create_file', { path: 'file.txt', content: 'one\ntwo\nthree' });
  assert.match(await invoke('read_file', { path: 'file.txt', offset: 2, limit: 1 }), /2.*two/);
  await assert.rejects(invoke('create_file', { path: 'file.txt', content: 'overwrite' }));
  await assert.rejects(invoke('edit_file', { path: 'file.txt', old_string: 'absent', new_string: 'bad' }));
  await invoke('edit_file', { path: 'file.txt', old_string: 'two', new_string: 'TWO' });
  assert.equal(await readFile(join(a, 'file.txt'), 'utf8'), 'one\nTWO\nthree');
  assert.equal(await readFile(join(b, 'file.txt'), 'utf8'), 'other-project');
});

test('workspace rejects traversal, ignored files, secret files, metadata and Windows alternate streams', async t => {
  const { a, b, invoke } = await fixture(t);
  await writeFile(join(b, 'private.txt'), 'external');
  await writeFile(join(a, '.env'), 'fake-private');
  await writeFile(join(a, 'ignored.txt'), 'ignored');
  for (const path of ['../b/private.txt', '..\\b\\private.txt', '.env', '.env.local', '.git/config', '.openagent/config.json', 'ignored.txt', 'file.txt:stream', 'dist/output.txt']) {
    await assert.rejects(invoke('read_file', { path }), path);
    await assert.rejects(invoke('create_file', { path, content: 'no' }), path);
  }
  assert.equal(await readFile(join(b, 'private.txt'), 'utf8'), 'external');
  assert.equal(await readFile(join(a, '.env'), 'utf8'), 'fake-private');
});

test('directory junctions cannot bypass workspace confinement', async t => {
  const { a, b, invoke } = await fixture(t);
  await writeFile(join(b, 'private.txt'), 'outside');
  await symlink(b, join(a, 'redirect'), 'junction');
  await assert.rejects(invoke('read_file', { path: 'redirect/private.txt' }));
  await assert.rejects(invoke('create_file', { path: 'redirect/new.txt', content: 'bad' }));
  assert.deepEqual(await readdir(b), ['private.txt']);
});

test('file deletion is recoverable and directory listing excludes secrets and metadata', async t => {
  const { a, invoke } = await fixture(t);
  await writeFile(join(a, 'remove.txt'), 'recoverable');
  await writeFile(join(a, '.env'), 'fake-key');
  const result = JSON.parse(await invoke('delete_file', { path: 'remove.txt' }));
  assert.equal(await readFile(join(a, result.recovery_path), 'utf8'), 'recoverable');
  await assert.rejects(readFile(join(a, 'remove.txt')));
  const listing = await invoke('list_dir', {});
  assert.equal(listing.includes('.env'), false);
  assert.equal(listing.includes('.openagent'), false);
});
