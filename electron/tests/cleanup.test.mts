import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const old = join(root, 'old-project');
  const recent = join(root, 'recent-project');
  await Promise.all([home, old, recent].map(p => mkdir(p)));
  return { root, home, old, recent };
}

function daysAgo(n: number) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

async function seedFoldersJson(home: string, entries: Array<{ path: string; last_used: string }>) {
  await writeFile(join(home, 'folders.json'), JSON.stringify(entries, null, 2));
}

async function seedConversation(folder: string) {
  const dir = join(folder, '.openagent');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'conversations.json'), JSON.stringify({ version: 1, branches: [{ id: 'main', label: 'Principale', messages: [{ role: 'user', content: 'salut' }], created_at: new Date().toISOString() }] }, null, 2));
}

test('cleanupOldFolders deletes conversation data of folders unused beyond retention', async t => {
  const { home, old, recent } = await fixture(t);
  await seedFoldersJson(home, [
    { path: old, last_used: daysAgo(40) },
    { path: recent, last_used: daysAgo(1) },
  ]);
  await seedConversation(old);
  await seedConversation(recent);
  const { FoldersService } = await import('../core/folders.mts');
  const { cleanupOldFolders } = await import('../core/cleanup.mts');
  const result = await cleanupOldFolders(new FoldersService(home), 30);
  assert.equal(result.cleaned, 1);
  await assert.rejects(readFile(join(old, '.openagent', 'conversations.json')));
  await assert.doesNotReject(readFile(join(recent, '.openagent', 'conversations.json')));
});

test('cleanupOldFolders is a no-op when retentionDays is 0 (never)', async t => {
  const { home, old } = await fixture(t);
  await seedFoldersJson(home, [{ path: old, last_used: daysAgo(400) }]);
  await seedConversation(old);
  const { FoldersService } = await import('../core/folders.mts');
  const { cleanupOldFolders } = await import('../core/cleanup.mts');
  const result = await cleanupOldFolders(new FoldersService(home), 0);
  assert.equal(result.cleaned, 0);
  await assert.doesNotReject(readFile(join(old, '.openagent', 'conversations.json')));
});

test('cleanupOldFolders skips a folder that no longer exists on disk without throwing', async t => {
  const { home, old } = await fixture(t);
  await seedFoldersJson(home, [{ path: old, last_used: daysAgo(400) }]);
  await seedConversation(old);
  await rm(old, { recursive: true, force: true });
  const { FoldersService } = await import('../core/folders.mts');
  const { cleanupOldFolders } = await import('../core/cleanup.mts');
  const result = await cleanupOldFolders(new FoldersService(home), 30);
  assert.equal(result.cleaned, 0);
});

test('cleanupOldFolders leaves the folder history entry itself intact (only the conversation data is wiped)', async t => {
  const { home, old } = await fixture(t);
  await seedFoldersJson(home, [{ path: old, last_used: daysAgo(400) }]);
  await seedConversation(old);
  const { FoldersService } = await import('../core/folders.mts');
  const { cleanupOldFolders } = await import('../core/cleanup.mts');
  const folders = new FoldersService(home);
  await cleanupOldFolders(folders, 30);
  const list = await folders.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].path, old);
});
