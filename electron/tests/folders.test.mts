import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-folders-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const a = join(root, 'project-a');
  const b = join(root, 'project-b');
  await Promise.all([home, a, b].map(p => mkdir(p)));
  return { root, home, a, b };
}

test('list() on a missing folders.json returns an empty array, not a crash', async t => {
  const { home } = await fixture(t);
  const { FoldersService } = await import('../core/folders.mts');
  assert.deepEqual(await new FoldersService(home).list(), []);
});

test('recordOpened adds an entry with a derived name and an ISO last_used', async t => {
  const { home, a } = await fixture(t);
  const { FoldersService } = await import('../core/folders.mts');
  const service = new FoldersService(home);
  const list = await service.recordOpened(a);
  assert.equal(list.length, 1);
  assert.equal(list[0].path, await realpath(a));
  assert.equal(list[0].name, 'project-a');
  assert.match(list[0].last_used, /^\d{4}-\d{2}-\d{2}T/);
});

test('recordOpened moves an already-known folder to the front instead of duplicating it', async t => {
  const { home, a, b } = await fixture(t);
  const { FoldersService } = await import('../core/folders.mts');
  const service = new FoldersService(home);
  await service.recordOpened(a);
  await service.recordOpened(b);
  const list = await service.recordOpened(a);
  assert.deepEqual(list.map(entry => entry.name), ['project-a', 'project-b']);
});

test('recordOpened rejects a relative path', async t => {
  const { home } = await fixture(t);
  const { FoldersService } = await import('../core/folders.mts');
  await assert.rejects(new FoldersService(home).recordOpened('project-a'), /absolu/);
});

test('recordOpened rejects a path that does not exist or is not a directory', async t => {
  const { home, root } = await fixture(t);
  const { FoldersService } = await import('../core/folders.mts');
  const service = new FoldersService(home);
  await assert.rejects(service.recordOpened(join(root, 'nope')), /introuvable/);
  const file = join(root, 'a-file.txt');
  await writeFile(file, 'x');
  await assert.rejects(service.recordOpened(file), /introuvable/);
});

test('a folders.json corrupted with malformed entries is tolerated: garbage is dropped, valid entries survive', async t => {
  const { home, a, b } = await fixture(t);
  const { FoldersService } = await import('../core/folders.mts');
  await writeFile(
    join(home, 'folders.json'),
    JSON.stringify([{ path: await realpath(a), last_used: '2026-01-01T00:00:00.000Z' }, 'garbage', 42, { last_used: 'no path' }, null]),
  );
  const service = new FoldersService(home);
  assert.deepEqual((await service.list()).map(entry => entry.name), ['project-a']);
  const list = await service.recordOpened(b);
  assert.deepEqual(list.map(entry => entry.name), ['project-b', 'project-a']);
});

test('a folders.json that is not even a JSON array is tolerated as an empty history', async t => {
  const { home, a } = await fixture(t);
  const { FoldersService } = await import('../core/folders.mts');
  await writeFile(join(home, 'folders.json'), JSON.stringify({ not: 'an array' }));
  const service = new FoldersService(home);
  assert.deepEqual(await service.list(), []);
  const list = await service.recordOpened(a);
  assert.deepEqual(list.map(entry => entry.name), ['project-a']);
});
