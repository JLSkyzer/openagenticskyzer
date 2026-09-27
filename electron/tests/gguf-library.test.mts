import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GgufLibrary } from '../core/gguf-library.mts';

async function project(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-gguf-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home);
  const model = join(root, 'model.gguf');
  await writeFile(model, Buffer.alloc(2048)); // 2 KB stand-in; content does not matter to the library itself
  return { home, model, library: new GgufLibrary(home) };
}

test('a fresh library is empty', async t => {
  const { library } = await project(t);
  assert.deepEqual(await library.list(), []);
});

test('add records the real file: name from the path, exact size in bytes, an id, a timestamp — never copies the file', async t => {
  const { library, model } = await project(t);
  const before = Date.now();
  const entry = await library.add(model);
  assert.equal(entry.name, 'model.gguf');
  assert.equal(entry.path, model);
  assert.equal(entry.size_bytes, 2048);
  assert.match(entry.id, /^[a-f0-9-]{36}$/);
  assert.ok(Date.parse(entry.added_at) >= before);
  const listed = await library.list();
  assert.deepEqual(listed, [entry]);
});

test('list is sorted by most recently added first', async t => {
  const { home, model } = await project(t);
  const second = model.replace('model.gguf', 'second.gguf');
  await writeFile(second, Buffer.alloc(10));
  const library = new GgufLibrary(home);
  const first = await library.add(model);
  await new Promise(resolve => setTimeout(resolve, 5));
  const other = await library.add(second);
  assert.deepEqual((await library.list()).map(e => e.id), [other.id, first.id]);
});

test('add refuses a path that does not exist, one that is not a file, and one that is not .gguf', async t => {
  const { home, model } = await project(t);
  const library = new GgufLibrary(home);
  await assert.rejects(library.add(join(home, 'absent.gguf')), /introuvable/i);
  const dirWithGgufName = join(home, 'dir.gguf');
  await mkdir(dirWithGgufName);
  await assert.rejects(library.add(dirWithGgufName), /introuvable|fichier/i, 'a directory is not a file, even named .gguf');
  const wrongExt = model.replace('.gguf', '.bin');
  await import('node:fs/promises').then(fs => fs.rename(model, wrongExt));
  await assert.rejects(library.add(wrongExt), /\.gguf/i);
});

test('add refuses a relative path (only an absolute, already-chosen path is trusted)', async t => {
  const { library } = await project(t);
  await assert.rejects(library.add('model.gguf'), /absolu/i);
});

test('adding the exact same path twice keeps only one entry (re-adding refreshes it, does not duplicate)', async t => {
  const { library, model } = await project(t);
  const first = await library.add(model);
  const second = await library.add(model);
  const listed = await library.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, second.id);
  assert.notEqual(first.id, second.id, 'a fresh id on re-add, not a silent no-op');
});

test('remove forgets an entry by id; the file on disk is never touched', async t => {
  const { library, model } = await project(t);
  const entry = await library.add(model);
  const after = await library.remove(entry.id);
  assert.deepEqual(after, []);
  assert.deepEqual(await library.list(), []);
  const { stat } = await import('node:fs/promises');
  assert.ok((await stat(model)).isFile(), 'the real .gguf file still exists');
});

test('remove of an unknown id is a harmless no-op', async t => {
  const { library, model } = await project(t);
  await library.add(model);
  const after = await library.remove('00000000-0000-0000-0000-000000000000');
  assert.equal(after.length, 1);
});

test('resolve returns the path for a known id, and null for an unknown one', async t => {
  const { library, model } = await project(t);
  const entry = await library.add(model);
  assert.equal(await library.resolve(entry.id), model);
  assert.equal(await library.resolve('00000000-0000-0000-0000-000000000000'), null);
});

test('list quietly drops an entry whose file has since been deleted or moved (never a crash, never a stale phantom)', async t => {
  const { library, model } = await project(t);
  const entry = await library.add(model);
  await rm(model);
  assert.deepEqual(await library.list(), [], 'gone from the list');
  assert.equal(await library.resolve(entry.id), null, 'and resolve says so too');
});

test('a corrupted library file is refused, never silently discarded (JsonStore.read\'s own contract, same as folders.mts and every other service)', async t => {
  const { home } = await project(t);
  await writeFile(join(home, 'gguf-library.json'), '{ not json');
  const library = new GgufLibrary(home);
  await assert.rejects(library.list(), /JSON illisible/);
});
