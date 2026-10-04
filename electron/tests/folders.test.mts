import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, readFile, stat, chmod } from 'node:fs/promises';
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

test('R1: a folder recorded by Python (C:/…) and by this app (C:\\…) is ONE entry with the most recent date, written back once', async t => {
  const { home, a } = await fixture(t);
  const real = await realpath(a);
  const original = JSON.stringify([
    { path: real.replaceAll('\\', '/'), last_used: '2026-08-01T10:00:00.123456' },
    { path: real, last_used: '2026-10-03T08:00:00.000Z' },
  ], null, 2);
  await writeFile(join(home, 'folders.json'), original);
  const { FoldersService } = await import('../core/folders.mts');
  const service = new FoldersService(home);
  const list = await service.list();
  assert.deepEqual(list.map(entry => [entry.path, entry.last_used]), [[real, '2026-10-03T08:00:00.000Z']]);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'folders.json'), 'utf8')), [{ path: real, last_used: '2026-10-03T08:00:00.000Z' }], 'rewritten normalised');
  assert.equal(await readFile(join(home, 'folders.json.pre-electron.bak'), 'utf8'), original, 'the original is kept byte for byte');
  const written = (await stat(join(home, 'folders.json'))).mtimeMs;
  await service.list();
  assert.equal((await stat(join(home, 'folders.json'))).mtimeMs, written, 'written once: a merged file is not rewritten again');
});

test('R1: the most recent date wins whichever spelling holds it — compared as times, not as strings', async t => {
  const { home, a } = await fixture(t);
  const real = await realpath(a);
  // Python wrote local time without a zone; this app writes UTC. 2026-10-03T23:30 local is after 2026-10-03T08:00Z.
  await writeFile(join(home, 'folders.json'), JSON.stringify([
    { path: real, last_used: '2026-10-03T08:00:00.000Z' },
    { path: real.replaceAll('\\', '/'), last_used: '2026-10-03T23:30:00.000001' },
  ]));
  const { FoldersService } = await import('../core/folders.mts');
  assert.deepEqual((await new FoldersService(home).list()).map(entry => [entry.path, entry.last_used]), [[real, '2026-10-03T23:30:00.000001']]);
});

test('R1: recordOpened with the C:\\ spelling of a folder stored by Python as C:/… does not create a duplicate', async t => {
  const { home, a } = await fixture(t);
  const real = await realpath(a);
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: real.replaceAll('\\', '/'), last_used: '2026-01-01T00:00:00.000' }]));
  const { FoldersService } = await import('../core/folders.mts');
  const before = Date.now();
  const list = await new FoldersService(home).recordOpened(real);
  assert.deepEqual(list.map(entry => entry.path), [real], 'one entry, under the canonical path');
  assert.ok(Date.parse(list[0].last_used) >= before, 'it carries the latest date: now');
  assert.deepEqual(JSON.parse(await readFile(join(home, 'folders.json'), 'utf8')).map((entry: any) => entry.path), [real], 'one entry on disk too');
});

test('R1: recordOpened with the C:/ spelling of a folder stored as C:\\… does not create a duplicate', async t => {
  const { home, a } = await fixture(t);
  const real = await realpath(a);
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: real, last_used: '2026-01-01T00:00:00.000Z' }]));
  const { FoldersService } = await import('../core/folders.mts');
  const before = Date.now();
  const list = await new FoldersService(home).recordOpened(real.replaceAll('\\', '/'));
  assert.deepEqual(list.map(entry => entry.path), [real], 'one entry, under the canonical path');
  assert.ok(Date.parse(list[0].last_used) >= before, 'it carries the latest date: now');
  assert.deepEqual(JSON.parse(await readFile(join(home, 'folders.json'), 'utf8')).map((entry: any) => entry.path), [real], 'one entry on disk too');
});

test('R1: two spellings of a folder that no longer exists merge too (separators, and case under Windows)', { skip: process.platform !== 'win32' }, async t => {
  const { home, root } = await fixture(t);
  const gone = join(root, 'Disparu', 'projet');
  await writeFile(join(home, 'folders.json'), JSON.stringify([
    { path: gone.replaceAll('\\', '/').toUpperCase(), last_used: '2026-01-01T00:00:00.000Z' },
    { path: gone + '\\', last_used: '2026-02-01T00:00:00.000Z' },
  ]));
  const { FoldersService } = await import('../core/folders.mts');
  const list = await new FoldersService(home).list();
  assert.equal(list.length, 1);
  assert.equal(list[0].last_used, '2026-02-01T00:00:00.000Z');
  assert.equal(list[0].path.toLowerCase(), gone.toLowerCase(), 'stored resolved, with \\ and no trailing separator');
});

test('R1: a folders.json that cannot be rewritten (read-only) never fails the read: the merged entries are returned and the failure is logged', async t => {
  const { home, a } = await fixture(t);
  const real = await realpath(a);
  const file = join(home, 'folders.json');
  const original = JSON.stringify([
    { path: real.replaceAll('\\', '/'), last_used: '2026-08-01T10:00:00.123456' },
    { path: real, last_used: '2026-10-03T08:00:00.000Z' },
  ]);
  await writeFile(file, original);
  // A real obstacle: under Windows a read-only file cannot be replaced by a rename; elsewhere the folder is locked.
  const locked = process.platform === 'win32' ? file : home;
  await chmod(locked, process.platform === 'win32' ? 0o444 : 0o555);
  try {
    const { FoldersService } = await import('../core/folders.mts');
    const service = new FoldersService(home);
    await assert.rejects(service.recordOpened(a), 'the obstacle is real: a write to folders.json fails');
    // A spy that still calls the real console.error: it only records that the failure was logged.
    const errors = t.mock.method(console, 'error');
    const list = await service.list();
    assert.deepEqual(list.map(entry => [entry.path, entry.last_used]), [[real, '2026-10-03T08:00:00.000Z']], 'the read returns the merged entries');
    assert.equal(await readFile(file, 'utf8'), original, 'the file is left as it was');
    assert.ok(errors.mock.calls.some(call => String(call.arguments[0]).includes('folders.json')), 'the failed rewrite is logged');
  } finally {
    await chmod(locked, process.platform === 'win32' ? 0o666 : 0o755);
  }
});

test('R1: an unparsable last_used is "unknown": a known date wins the merge, and an unknown one sorts last', async t => {
  const { home, a, b } = await fixture(t);
  const [realA, realB] = [await realpath(a), await realpath(b)];
  await writeFile(join(home, 'folders.json'), JSON.stringify([
    { path: realB, last_used: 'pas une date' },
    { path: realA, last_used: 'jamais' },
    { path: realA.replaceAll('\\', '/'), last_used: '2020-01-01T00:00:00' },
  ]));
  const { FoldersService, lastUsedTime } = await import('../core/folders.mts');
  const list = await new FoldersService(home).list();
  assert.deepEqual(list.map(entry => [entry.path, entry.last_used]), [[realA, '2020-01-01T00:00:00'], [realB, 'pas une date']]);
  // The one helper folders.mts and cleanup.mts share.
  assert.equal(lastUsedTime('pas une date'), undefined);
  assert.equal(lastUsedTime('2026-10-03T08:00:00.000Z'), Date.UTC(2026, 9, 3, 8));
  assert.equal(lastUsedTime('2026-10-03T08:00:00.000001'), new Date(2026, 9, 3, 8).getTime(), 'a Python date without a zone is local time');
});
