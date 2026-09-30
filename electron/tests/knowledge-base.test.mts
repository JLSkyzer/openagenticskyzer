import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-knowledge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home);
  return { root, home };
}

test('addToKnowledge chunks and embeds real text, listSources reflects the new source', { timeout: 60000 }, async t => {
  const { home } = await fixture(t);
  const { addToKnowledge, listSources, knowledgeStorePath } = await import('../core/knowledge-base.mts');

  const count = await addToKnowledge('notes.txt', 'Ceci est un petit document de connaissance.', home);
  assert.ok(count >= 1);
  assert.deepEqual(await listSources(home), ['notes.txt']);

  const raw = JSON.parse(await readFile(knowledgeStorePath(home), 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.entries.length, count);
  assert.ok(raw.entries.every((e: any) => e.source === 'notes.txt' && Array.isArray(e.vector) && e.vector.length === 384));
});

test('re-adding the same source replaces its chunks instead of duplicating them', { timeout: 60000 }, async t => {
  const { home } = await fixture(t);
  const { addToKnowledge, knowledgeStorePath } = await import('../core/knowledge-base.mts');

  await addToKnowledge('notes.txt', 'Un texte assez long pour produire plusieurs morceaux. '.repeat(50), home);
  const shorterCount = await addToKnowledge('notes.txt', 'Un texte bien plus court.', home);

  const raw = JSON.parse(await readFile(knowledgeStorePath(home), 'utf8'));
  assert.equal(raw.entries.length, shorterCount, 'the old, longer version of the source must leave no stale chunks behind');
});

test('two different sources do not interfere; removeSource only deletes its own chunks', { timeout: 60000 }, async t => {
  const { home } = await fixture(t);
  const { addToKnowledge, removeSource, listSources } = await import('../core/knowledge-base.mts');

  await addToKnowledge('a.txt', 'Contenu du document A.', home);
  await addToKnowledge('b.txt', 'Contenu du document B.', home);
  assert.deepEqual(await listSources(home), ['a.txt', 'b.txt']);

  const removed = await removeSource('a.txt', home);
  assert.ok(removed >= 1);
  assert.deepEqual(await listSources(home), ['b.txt']);
});

test('searchKnowledge ranks a real semantically-related document above an unrelated one', { timeout: 60000 }, async t => {
  const { home } = await fixture(t);
  const { addToKnowledge, searchKnowledge } = await import('../core/knowledge-base.mts');

  await addToKnowledge('recette.txt', 'Pour trier une liste de nombres, on peut utiliser un algorithme de tri rapide.', home);
  await addToKnowledge('meteo.txt', 'Les prévisions météo annoncent de la pluie sur toute la région demain.', home);

  const results = await searchKnowledge('comment trier une liste', home, 5);
  assert.ok(results.length >= 2);
  assert.equal(results[0].source, 'recette.txt', `expected the sorting document to rank first, got: ${JSON.stringify(results.map(r => r.source))}`);
  assert.ok(results[0].score > results[1].score);
});

test('listSources and searchKnowledge on a knowledge base that was never populated return empty, not an error', async t => {
  const { home } = await fixture(t);
  const { listSources, searchKnowledge } = await import('../core/knowledge-base.mts');

  assert.deepEqual(await listSources(home), []);
  assert.deepEqual(await searchKnowledge('anything', home, 5), []);
});

test('addToKnowledge on empty text adds nothing and reports 0 chunks', { timeout: 60000 }, async t => {
  const { home } = await fixture(t);
  const { addToKnowledge, listSources } = await import('../core/knowledge-base.mts');

  const count = await addToKnowledge('empty.txt', '   ', home);
  assert.equal(count, 0);
  assert.deepEqual(await listSources(home), []);
});

test('addFileToKnowledge reads a real .txt/.md file from disk and adds it by its basename', { timeout: 60000 }, async t => {
  const { root, home } = await fixture(t);
  const filePath = join(root, 'notes.md');
  await writeFile(filePath, '# Notes\n\nCeci est un vrai fichier sur disque.');
  const { addFileToKnowledge, listSources } = await import('../core/knowledge-base.mts');

  const result = await addFileToKnowledge(filePath, home);
  assert.equal(result.source, 'notes.md');
  assert.ok(result.chunks >= 1);
  assert.deepEqual(await listSources(home), ['notes.md']);
});

test('addFileToKnowledge refuses a file whose extension is not .txt or .md', { timeout: 20000 }, async t => {
  const { root, home } = await fixture(t);
  const filePath = join(root, 'binaire.exe');
  await writeFile(filePath, 'peu importe le contenu');
  const { addFileToKnowledge } = await import('../core/knowledge-base.mts');

  await assert.rejects(addFileToKnowledge(filePath, home), /\.txt|\.md/);
});

test('addFileToKnowledge refuses a path that does not exist', { timeout: 20000 }, async t => {
  const { root, home } = await fixture(t);
  const { addFileToKnowledge } = await import('../core/knowledge-base.mts');

  await assert.rejects(addFileToKnowledge(join(root, 'jamais-créé.txt'), home));
});
