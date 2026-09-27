import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
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
