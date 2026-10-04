import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { removeAtEnd } from './teardown.mts';
import { localDay, expectedArchive } from './fs-helpers.mts';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-cleanup-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const old = join(root, 'old-project');
  const recent = join(root, 'recent-project');
  await Promise.all([home, old, recent].map(p => mkdir(p)));
  return { root, home, old, recent };
}

function daysAgo(n: number) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}
async function absent(path: string) {
  await assert.rejects(lstat(path), /ENOENT/, `${path} must not exist`);
}

async function seedFoldersJson(home: string, entries: Array<{ path: string; last_used: string }>) {
  await writeFile(join(home, 'folders.json'), JSON.stringify(entries, null, 2));
}

async function seedConversation(folder: string, content = 'salut') {
  const dir = join(folder, '.openagent');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'conversations.json'), JSON.stringify({ version: 1, branches: [{ id: 'main', label: 'Principale', messages: [{ role: 'user', content }], created_at: new Date().toISOString() }] }, null, 2));
  return readFile(join(dir, 'conversations.json'));
}
async function seedPythonHistory(folder: string, content = 'ancien') {
  const file = join(folder, '.openagent', 'chat_history.json');
  await writeFile(file, JSON.stringify([{ role: 'human', content }]));
  return readFile(file);
}

test('R2: an expired project\'s history files are MOVED to <home>/retention-archive/<day>/<name>-<sha8>/, byte for byte; a recent one is untouched', async t => {
  const { home, old, recent } = await fixture(t);
  await seedFoldersJson(home, [
    { path: old, last_used: daysAgo(40) },
    { path: recent, last_used: daysAgo(1) },
  ]);
  const before = { current: await seedConversation(old), legacy: await seedPythonHistory(old) };
  const recentBefore = await seedConversation(recent);
  const now = new Date();
  const target = await expectedArchive(home, old, now);
  const { FoldersService } = await import('../core/folders.mts');
  const { cleanupOldFolders } = await import('../core/cleanup.mts');
  const result = await cleanupOldFolders(new FoldersService(home), 30, home, now);
  assert.deepEqual(result, { cleaned: 1, failed: 0 });
  assert.deepEqual((await readdir(target)).sort(), ['chat_history.json', 'conversations.json']);
  assert.deepEqual(await readFile(join(target, 'conversations.json')), before.current);
  assert.deepEqual(await readFile(join(target, 'chat_history.json')), before.legacy);
  await absent(join(old, '.openagent', 'conversations.json'));
  await absent(join(old, '.openagent', 'chat_history.json'));
  assert.deepEqual(await readFile(join(recent, '.openagent', 'conversations.json')), recentBefore);
});

test('R2: a move that fails leaves the file in place, counts it as failed, and deletes nothing', async t => {
  const { home, old } = await fixture(t);
  await seedFoldersJson(home, [{ path: old, last_used: daysAgo(40) }]);
  const before = await seedConversation(old);
  // The archive path is impossible: retention-archive is a FILE, so no folder can be created under it.
  await writeFile(join(home, 'retention-archive'), 'pas un dossier');
  const { FoldersService } = await import('../core/folders.mts');
  const { cleanupOldFolders } = await import('../core/cleanup.mts');
  const result = await cleanupOldFolders(new FoldersService(home), 30, home);
  assert.deepEqual(result, { cleaned: 0, failed: 1 });
  assert.deepEqual(await readFile(join(old, '.openagent', 'conversations.json')), before, 'still there, byte for byte');
  assert.equal(await readFile(join(home, 'retention-archive'), 'utf8'), 'pas un dossier', 'the obstacle itself is untouched');
});

test('R2: chat_history.json is archived FIRST; when conversations.json then fails to move, it stays and is still what the next start reads', async t => {
  const { home, old } = await fixture(t);
  await seedFoldersJson(home, [{ path: old, last_used: daysAgo(40) }]);
  const current = await seedConversation(old, 'conversation actuelle');
  const legacy = await seedPythonHistory(old, 'vieille conversation Python');
  const now = new Date();
  const target = await expectedArchive(home, old, now);
  // A real obstacle for the SECOND move only: the archive already holds a conversations.json.
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'conversations.json'), 'déjà archivé');
  const { FoldersService } = await import('../core/folders.mts');
  const { cleanupOldFolders } = await import('../core/cleanup.mts');
  const result = await cleanupOldFolders(new FoldersService(home), 30, home, now);
  assert.deepEqual(result, { cleaned: 1, failed: 1 });
  assert.deepEqual(await readFile(join(target, 'chat_history.json')), legacy, 'the Python file was archived first');
  await absent(join(old, '.openagent', 'chat_history.json'));
  assert.deepEqual(await readFile(join(old, '.openagent', 'conversations.json')), current, 'conversations.json stays, byte for byte');
  assert.equal(await readFile(join(target, 'conversations.json'), 'utf8'), 'déjà archivé', 'never overwritten');
  // The next start reads the project's own conversation, not the stale Python one.
  const { Conversations } = await import('../core/conversations.mts');
  assert.deepEqual((await new Conversations().messages(old, 'main')).map(m => m.content), ['conversation actuelle']);
});

test('R2: when chat_history.json cannot be archived, conversations.json is not moved either — the stale Python file never becomes the main branch', async t => {
  const { home, old } = await fixture(t);
  await seedFoldersJson(home, [{ path: old, last_used: daysAgo(40) }]);
  const current = await seedConversation(old, 'conversation actuelle');
  const legacy = await seedPythonHistory(old, 'vieille conversation Python');
  const now = new Date();
  const target = await expectedArchive(home, old, now);
  // A real obstacle for the FIRST move: the archive already holds a chat_history.json.
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'chat_history.json'), 'déjà archivé');
  const { FoldersService } = await import('../core/folders.mts');
  const { cleanupOldFolders } = await import('../core/cleanup.mts');
  const result = await cleanupOldFolders(new FoldersService(home), 30, home, now);
  assert.deepEqual(result, { cleaned: 0, failed: 1 });
  assert.deepEqual(await readFile(join(old, '.openagent', 'chat_history.json')), legacy, 'chat_history.json stays, byte for byte');
  assert.deepEqual(await readFile(join(old, '.openagent', 'conversations.json')), current, 'conversations.json stays, byte for byte');
  await absent(join(target, 'conversations.json'));
  const { Conversations } = await import('../core/conversations.mts');
  assert.deepEqual((await new Conversations().messages(old, 'main')).map(m => m.content), ['conversation actuelle']);
});

test('R1 + R2: a project whose OLD Python entry expired but which was opened yesterday is left alone; a truly expired one is archived', async t => {
  const { home, old, recent } = await fixture(t);
  const recentReal = await realpath(recent);
  await seedFoldersJson(home, [
    { path: recentReal.replaceAll('\\', '/'), last_used: '2026-01-01T09:00:00.000001' }, // written by Python, long ago
    { path: recentReal, last_used: daysAgo(1) },                                          // written by this app yesterday
    { path: old, last_used: daysAgo(40) },
  ]);
  const recentBefore = await seedConversation(recent);
  const oldBefore = await seedConversation(old);
  const now = new Date();
  const { FoldersService } = await import('../core/folders.mts');
  const { cleanupOldFolders } = await import('../core/cleanup.mts');
  const result = await cleanupOldFolders(new FoldersService(home), 30, home, now);
  assert.deepEqual(result, { cleaned: 1, failed: 0 });
  assert.deepEqual(await readFile(join(recent, '.openagent', 'conversations.json')), recentBefore, 'the merged entry is recent: nothing touched');
  await absent(await expectedArchive(home, recent, now));
  assert.deepEqual(await readFile(join(await expectedArchive(home, old, now), 'conversations.json')), oldBefore, 'archived byte for byte');
  await absent(join(old, '.openagent', 'conversations.json'));
});

test('R2: a project whose last_used cannot be read as a date is "unknown" and is never archived', async t => {
  const { home, old } = await fixture(t);
  await seedFoldersJson(home, [{ path: old, last_used: 'pas une date' }]);
  const before = await seedConversation(old);
  const { FoldersService } = await import('../core/folders.mts');
  const { cleanupOldFolders } = await import('../core/cleanup.mts');
  const result = await cleanupOldFolders(new FoldersService(home), 30, home);
  assert.deepEqual(result, { cleaned: 0, failed: 0 });
  assert.deepEqual(await readFile(join(old, '.openagent', 'conversations.json')), before);
  await absent(join(home, 'retention-archive'));
});

test('R2: a project at a drive root (D:\\) or with a name a file name cannot hold still gets a valid archive folder', async t => {
  const { home } = await fixture(t);
  const now = new Date();
  const sha8 = (path: string) => createHash('sha256').update(path).digest('hex').slice(0, 8);
  const day = join(home, 'retention-archive', localDay(now));
  const { archiveDirectory } = await import('../core/cleanup.mts');
  assert.equal(archiveDirectory(home, 'D:\\', now), join(day, `D_-${sha8('D:\\')}`), 'the drive letter, its colon replaced');
  assert.equal(archiveDirectory(home, '/srv/a<b>c:d"e|f?g*h\u0001i', now), join(day, `a_b_c_d_e_f_g_h_i-${sha8('/srv/a<b>c:d"e|f?g*h\u0001i')}`));
  assert.equal(archiveDirectory(home, '/', now), join(day, `projet-${sha8('/')}`), 'an empty name falls back to « projet »');
  // The folder really can be created, which the raw `D:` segment could not be under Windows.
  await mkdir(archiveDirectory(home, 'D:\\', now), { recursive: true });
  assert.ok((await lstat(archiveDirectory(home, 'D:\\', now))).isDirectory());
});

test('cleanupOldFolders is a no-op when retentionDays is 0 (never)', async t => {
  const { home, old } = await fixture(t);
  await seedFoldersJson(home, [{ path: old, last_used: daysAgo(400) }]);
  const before = await seedConversation(old);
  const { FoldersService } = await import('../core/folders.mts');
  const { cleanupOldFolders } = await import('../core/cleanup.mts');
  const result = await cleanupOldFolders(new FoldersService(home), 0, home);
  assert.deepEqual(result, { cleaned: 0, failed: 0 });
  assert.deepEqual(await readFile(join(old, '.openagent', 'conversations.json')), before);
  await absent(join(home, 'retention-archive'));
});

test('cleanupOldFolders skips a folder that no longer exists on disk without throwing', async t => {
  const { home, old } = await fixture(t);
  await seedFoldersJson(home, [{ path: old, last_used: daysAgo(400) }]);
  await seedConversation(old);
  await rm(old, { recursive: true, force: true });
  const { FoldersService } = await import('../core/folders.mts');
  const { cleanupOldFolders } = await import('../core/cleanup.mts');
  const result = await cleanupOldFolders(new FoldersService(home), 30, home);
  assert.deepEqual(result, { cleaned: 0, failed: 0 });
  await absent(join(home, 'retention-archive'));
});

test('cleanupOldFolders leaves the folder history entry itself intact (only the conversation data is archived)', async t => {
  const { home, old } = await fixture(t);
  await seedFoldersJson(home, [{ path: old, last_used: daysAgo(400) }]);
  const before = await seedConversation(old);
  const now = new Date();
  const { FoldersService } = await import('../core/folders.mts');
  const { cleanupOldFolders } = await import('../core/cleanup.mts');
  const folders = new FoldersService(home);
  assert.deepEqual(await cleanupOldFolders(folders, 30, home, now), { cleaned: 1, failed: 0 });
  const list = await folders.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].path, await realpath(old));
  assert.deepEqual(await readFile(join(await expectedArchive(home, old, now), 'conversations.json')), before, 'archived byte for byte');
  await absent(join(old, '.openagent', 'conversations.json'));
});
