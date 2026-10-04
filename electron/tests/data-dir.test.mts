import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { snapshot } from './fs-helpers.mts';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-datadir-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home);
  return { root, home };
}

test('resolveDataHome falls back to defaultHome when no redirect.json exists', async t => {
  const { home } = await fixture(t);
  const { resolveDataHome } = await import('../core/data-dir.mts');
  assert.equal(await resolveDataHome(home), home);
});

test('migrateDataDir moves every top-level file to the new directory and writes a redirect', async t => {
  const { root, home } = await fixture(t);
  await writeFile(join(home, 'config.json'), '{"theme":"dark"}');
  await writeFile(join(home, 'folders.json'), '[]');
  const newDir = join(root, 'new-home');
  const { migrateDataDir, resolveDataHome } = await import('../core/data-dir.mts');
  const result = await migrateDataDir(home, home, newDir);
  assert.equal(result.moved, 2);
  assert.deepEqual(result.errors, []);
  assert.equal(await readFile(join(newDir, 'config.json'), 'utf8'), '{"theme":"dark"}');
  assert.equal(await readFile(join(newDir, 'folders.json'), 'utf8'), '[]');
  await assert.rejects(readFile(join(home, 'config.json'), 'utf8'));
  // resolveDataHome now reads the redirect written into the ORIGINAL (fixed, default) home.
  assert.equal(await resolveDataHome(home), newDir);
});

test('migrateDataDir is a no-op move when the target is already the current home', async t => {
  const { home } = await fixture(t);
  await writeFile(join(home, 'config.json'), '{}');
  const { migrateDataDir } = await import('../core/data-dir.mts');
  const result = await migrateDataDir(home, home, home);
  assert.equal(result.moved, 0);
  assert.equal(await readFile(join(home, 'config.json'), 'utf8'), '{}');
});

test('migrateDataDir rejects a relative path', async t => {
  const { home } = await fixture(t);
  const { migrateDataDir } = await import('../core/data-dir.mts');
  await assert.rejects(migrateDataDir(home, home, 'relative/path'), /absolu/);
});

test('migrateDataDir creates the new directory if it does not exist yet', async t => {
  const { root, home } = await fixture(t);
  const newDir = join(root, 'does', 'not', 'exist', 'yet');
  const { migrateDataDir } = await import('../core/data-dir.mts');
  await migrateDataDir(home, home, newDir);
  const stat = await import('node:fs/promises').then(m => m.stat(newDir));
  assert.ok(stat.isDirectory());
});

test('a second migration later moves files from the NEW current home, and updates the same fixed redirect', async t => {
  const { root, home } = await fixture(t);
  await writeFile(join(home, 'config.json'), '{"n":1}');
  const dirB = join(root, 'dir-b');
  const dirC = join(root, 'dir-c');
  const { migrateDataDir, resolveDataHome } = await import('../core/data-dir.mts');
  await migrateDataDir(home, home, dirB);
  assert.equal(await resolveDataHome(home), dirB);
  await migrateDataDir(dirB, home, dirC);
  assert.equal(await resolveDataHome(home), dirC);
  assert.equal(await readFile(join(dirC, 'config.json'), 'utf8'), '{"n":1}');
});

test('R4: migrateDataDir moves the whole tree — knowledge/, tools/ and nested sub-folders — byte for byte', async t => {
  const { root, home } = await fixture(t);
  await writeFile(join(home, 'config.json'), '{"theme":"dark"}');
  await mkdir(join(home, 'knowledge'));
  await writeFile(join(home, 'knowledge', 'store.json'), '{"chunks":[]}');
  await mkdir(join(home, 'tools'));
  await writeFile(join(home, 'tools', 'outil.mjs'), 'export function getTools() { return []; }');
  await mkdir(join(home, 'cache', 'embeddings', 'deep'), { recursive: true });
  await writeFile(join(home, 'cache', 'embeddings', 'deep', 'v.bin'), Buffer.from([0, 1, 2, 250, 255]));
  const before = await snapshot(home);
  const newDir = join(root, 'new-home');
  const { migrateDataDir, resolveDataHome } = await import('../core/data-dir.mts');
  const result = await migrateDataDir(home, home, newDir);
  assert.deepEqual(result, { moved: 4, errors: [] }, 'config.json, knowledge, tools, cache');
  assert.deepEqual(await snapshot(newDir), before);
  assert.deepEqual(await readdir(home), ['redirect.json'], 'only the fixed pointer stays behind');
  assert.equal(await resolveDataHome(home), newDir);
});

test('I2: a new folder that already holds data (a stale folders.json from 2025) is refused BEFORE anything moves: no redirect, the old home and the target byte for byte as they were', async t => {
  const { root, home } = await fixture(t);
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: 'C:\\p', last_used: '2026-10-03T00:00:00Z' }]));
  await writeFile(join(home, 'config.json'), '{"current":true}');
  await mkdir(join(home, 'knowledge'));
  await writeFile(join(home, 'knowledge', 'store.json'), '{"chunks":[]}');
  const target = join(root, 'target');
  await mkdir(join(target, 'tools'), { recursive: true });
  await writeFile(join(target, 'folders.json'), JSON.stringify([{ path: 'C:\\p', last_used: '2025-01-01T00:00:00Z' }]));
  const [homeBefore, targetBefore] = [await snapshot(home), await snapshot(target)];
  const { migrateDataDir, resolveDataHome } = await import('../core/data-dir.mts');
  const error = await migrateDataDir(home, home, target).then(() => null, (e: Error) => e);
  assert.ok(error, 'the migration is refused');
  assert.match(error.message, /contient déjà/);
  assert.match(error.message, /folders\.json/, 'the message names the entries already there');
  assert.match(error.message, /tools/);
  assert.match(error.message, /rien n’a été déplacé/);
  assert.deepEqual(await snapshot(home), homeBefore, 'the old home is byte-identical');
  assert.deepEqual(await snapshot(target), targetBefore, 'the stale target is untouched');
  await assert.rejects(readFile(join(home, 'redirect.json')), /ENOENT/, 'no redirect written');
  assert.equal(await resolveDataHome(home), home, 'the next start still reads the current home, never the stale copy');
});

test('I2: the refusal names at most ten entries, then says how many more', async t => {
  const { root, home } = await fixture(t);
  await writeFile(join(home, 'config.json'), '{}');
  const target = join(root, 'target');
  await mkdir(target);
  for (let i = 0; i < 13; i++) await writeFile(join(target, `f${String(i).padStart(2, '0')}.txt`), '');
  const { migrateDataDir } = await import('../core/data-dir.mts');
  const error = await migrateDataDir(home, home, target).then(() => null, (e: Error) => e);
  assert.ok(error);
  assert.match(error.message, /f00\.txt.*f09\.txt/);
  assert.doesNotMatch(error.message, /f10\.txt/);
  assert.match(error.message, /et 3 autre\(s\)/);
  assert.equal(await readFile(join(home, 'config.json'), 'utf8'), '{}');
});

test('I2: moving back to the default home, which holds only redirect.json, is accepted — the pointer is not data', async t => {
  const { root, home } = await fixture(t);
  await writeFile(join(home, 'config.json'), '{"n":1}');
  const elsewhere = join(root, 'elsewhere');
  const { migrateDataDir, resolveDataHome } = await import('../core/data-dir.mts');
  await migrateDataDir(home, home, elsewhere);
  assert.deepEqual(await readdir(home), ['redirect.json']);
  const result = await migrateDataDir(elsewhere, home, home);
  assert.deepEqual(result, { moved: 1, errors: [] });
  assert.equal(await readFile(join(home, 'config.json'), 'utf8'), '{"n":1}');
  assert.equal(await resolveDataHome(home), home);
});

test('I2: an entry that fails mid-migration (a folder held by a running process) is NAMED in the result and in the message shown to the user; the rest moves', { skip: process.platform !== 'win32' && 'the lock used here, a process current directory, is a Windows one' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-datadir-lock-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  await mkdir(join(home, 'knowledge'), { recursive: true });
  await writeFile(join(home, 'config.json'), '{}');
  await writeFile(join(home, 'knowledge', 'store.json'), '{"chunks":[]}');
  // A real lock: a running process whose current directory is home/knowledge — Windows refuses to rename that folder.
  // The child opens its current-directory handle while it initialises, AFTER 'spawn' fires (seen: 1 run in ~20 moved
  // the folder anyway), so the lock only holds once the child's own code runs and says so.
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000);'], { cwd: join(home, 'knowledge'), stdio: ['ignore', 'pipe', 'ignore'] });
  terminateAtEnd(t, { terminate: async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } } });
  await once(child.stdout!, 'data');
  const newDir = join(root, 'new-home');
  const { migrateDataDir } = await import('../core/data-dir.mts');
  const result = await migrateDataDir(home, home, newDir);
  assert.equal(result.moved, 1, 'config.json moved');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^knowledge : /, 'the failed entry is named');
  assert.equal(await readFile(join(home, 'knowledge', 'store.json'), 'utf8'), '{"chunks":[]}', 'what could not move is intact');
  const { migrationSummary } = await import('../renderer-src/src/state/data-dir.ts');
  const summary = migrationSummary(result);
  assert.equal(summary.kind, 'warning');
  assert.match(summary.text, /knowledge/, 'the toast names the entry that stayed behind, not only a count');
  assert.match(summary.text, /Redémarrer maintenant/);
});

test('R4: a new folder chosen INSIDE the current home is not moved into itself', async t => {
  const { home } = await fixture(t);
  await writeFile(join(home, 'config.json'), '{}');
  await mkdir(join(home, 'tools'));
  await writeFile(join(home, 'tools', 'x.mjs'), '');
  const newDir = join(home, 'nouveau');
  const { migrateDataDir } = await import('../core/data-dir.mts');
  const result = await migrateDataDir(home, home, newDir);
  assert.deepEqual(result, { moved: 2, errors: [] });
  assert.deepEqual((await readdir(newDir)).sort(), ['config.json', 'tools']);
  assert.deepEqual((await readdir(home)).sort(), ['nouveau', 'redirect.json']);
});

test('R4: a new folder chosen inside one of the home\'s SUB-folders: that sub-folder is reported and stays, never moved into itself; the rest moves', async t => {
  const { home } = await fixture(t);
  await writeFile(join(home, 'config.json'), '{}');
  await mkdir(join(home, 'tools'));
  await writeFile(join(home, 'tools', 'x.mjs'), 'outil');
  const newDir = join(home, 'tools', 'nouveau');
  const { migrateDataDir, resolveDataHome } = await import('../core/data-dir.mts');
  const result = await migrateDataDir(home, home, newDir);
  assert.deepEqual(result, { moved: 1, errors: ['tools : contient le nouveau dossier, non déplacé'] });
  assert.deepEqual(await readdir(newDir), ['config.json']);
  assert.equal(await readFile(join(home, 'tools', 'x.mjs'), 'utf8'), 'outil', 'the reported folder is intact');
  assert.deepEqual((await readdir(home)).sort(), ['redirect.json', 'tools']);
  assert.equal(await resolveDataHome(home), newDir);
});

test('R4: a new folder that CONTAINS the current home (its parent) receives every entry, sub-folders included; the old home keeps only the pointer', async t => {
  const { root } = await fixture(t);
  const outer = join(root, 'outer');
  const home = join(outer, 'home');
  await mkdir(join(home, 'knowledge'), { recursive: true });
  await writeFile(join(home, 'config.json'), '{"n":1}');
  await writeFile(join(home, 'knowledge', 'store.json'), '{"chunks":[]}');
  const before = await snapshot(home);
  const { migrateDataDir, resolveDataHome } = await import('../core/data-dir.mts');
  const result = await migrateDataDir(home, home, outer);
  assert.deepEqual(result, { moved: 2, errors: [] });
  assert.deepEqual((await readdir(outer)).sort(), ['config.json', 'home', 'knowledge']);
  assert.deepEqual(await readdir(home), ['redirect.json']);
  const moved = await snapshot(outer);
  assert.deepEqual(Object.fromEntries(Object.entries(moved).filter(([name]) => !name.includes('redirect.json'))), before);
  assert.equal(await resolveDataHome(home), outer);
});

test('R4: a current home that cannot be listed (here a FILE, readdir fails with ENOTDIR) stops the migration BEFORE the redirect is written — it would point at an empty folder', async t => {
  const { root, home } = await fixture(t);
  const notAFolder = join(root, 'not-a-folder');
  await writeFile(notAFolder, 'contenu');
  const newDir = join(root, 'new-home');
  const { migrateDataDir, resolveDataHome } = await import('../core/data-dir.mts');
  await assert.rejects(migrateDataDir(notAFolder, home, newDir), /ENOTDIR/);
  await assert.rejects(readFile(join(home, 'redirect.json')), /ENOENT/, 'no redirect written');
  assert.equal(await resolveDataHome(home), home);
  assert.equal(await readFile(notAFolder, 'utf8'), 'contenu');
});

test('R4: a current home that does not exist (nothing to move) still writes the redirect, as before', async t => {
  const { root, home } = await fixture(t);
  const newDir = join(root, 'new-home');
  const { migrateDataDir, resolveDataHome } = await import('../core/data-dir.mts');
  assert.deepEqual(await migrateDataDir(join(root, 'absent'), home, newDir), { moved: 0, errors: [] });
  assert.equal(await resolveDataHome(home), newDir);
});
