import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { removeAtEnd } from './teardown.mts';
import { seedTree, snapshot } from './fs-helpers.mts';

const { moveEntry, copyThenRemove, sameContent } = await import('../core/safe-move.mts');

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-safe-move-'));
  removeAtEnd(t, root);
  return root;
}

test('moveEntry moves a file and a whole directory tree on one drive, leaving nothing behind', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'f.txt'), 'contenu');
  await moveEntry(join(root, 'f.txt'), join(root, 'g.txt'));
  assert.equal(await readFile(join(root, 'g.txt'), 'utf8'), 'contenu');
  await assert.rejects(readFile(join(root, 'f.txt')), /ENOENT/);

  const src = join(root, 'tree');
  await seedTree(src);
  const before = await snapshot(src);
  await moveEntry(src, join(root, 'moved'));
  assert.deepEqual(await snapshot(join(root, 'moved')), before);
  await assert.rejects(readdir(src), /ENOENT/);
});

test('moveEntry never overwrites: an existing destination is refused and the source stays intact', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'mine.json'), 'mine');
  await writeFile(join(root, 'theirs.json'), 'theirs');
  await assert.rejects(moveEntry(join(root, 'mine.json'), join(root, 'theirs.json')), /la destination existe déjà/);
  assert.equal(await readFile(join(root, 'mine.json'), 'utf8'), 'mine');
  assert.equal(await readFile(join(root, 'theirs.json'), 'utf8'), 'theirs');
});

test('copyThenRemove — the path a move to another drive takes — copies every byte of a tree, checks it, then removes the source', async t => {
  const root = await fixture(t);
  const src = join(root, 'tree');
  await seedTree(src);
  const before = await snapshot(src);
  await copyThenRemove(src, join(root, 'copy'));
  assert.deepEqual(await snapshot(join(root, 'copy')), before);
  await assert.rejects(readdir(src), /ENOENT/);
  await writeFile(join(root, 'one.txt'), 'un');
  await writeFile(join(root, 'taken.txt'), 'pris');
  await assert.rejects(copyThenRemove(join(root, 'one.txt'), join(root, 'taken.txt')), /la destination existe déjà/);
  assert.equal(await readFile(join(root, 'one.txt'), 'utf8'), 'un', 'a refused copy keeps its source');
});

test('copyThenRemove moves a single file — the path every retention move takes when the project and the data home are on different drives — byte for byte, leaving nothing behind', async t => {
  const root = await fixture(t);
  const src = join(root, 'conversations.json');
  const bytes = Buffer.concat([Buffer.from('{"version":1}\n'), randomBytes(200_000)]);
  await writeFile(src, bytes);
  await copyThenRemove(src, join(root, 'archive.json'));
  assert.deepEqual(await readFile(join(root, 'archive.json')), bytes);
  await assert.rejects(readFile(src), /ENOENT/);
});

test('sameContent tells a faithful copy from one with a changed byte or a missing file', async t => {
  const root = await fixture(t);
  const a = join(root, 'a');
  await seedTree(a);
  await copyThenRemove(a, join(root, 'b'));
  await seedTree(a);
  const b = join(root, 'b');
  // seedTree writes a NEW random b.bin: a and b now differ in that file only.
  assert.equal(await sameContent(a, b), false, 'one changed file is enough to differ');
  await writeFile(join(b, 'sub', 'b.bin'), await readFile(join(a, 'sub', 'b.bin')));
  assert.equal(await sameContent(a, b), true);
  await writeFile(join(a, 'extra.txt'), 'x');
  assert.equal(await sameContent(a, b), false, 'a file missing from the copy is a difference');
});
