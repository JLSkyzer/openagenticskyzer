import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A real download of Xenova/all-MiniLM-L6-v2 happens on first use in this environment (cached
// afterwards in the test's own data home) — this suite needs network access and can take a while
// the first time it ever runs on a machine.
test('embed() produces real 384-dim normalized vectors, cached under the given home (not node_modules)', { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-embeddings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');

  const { embed, EMBEDDING_DIMENSIONS } = await import('../core/embeddings.mts');
  const [vector] = await embed(['fonction qui trie une liste'], home);
  assert.equal(EMBEDDING_DIMENSIONS, 384);
  assert.equal(vector.length, 384);
  // normalize: true → unit vector.
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-3, `expected a unit vector, got norm ${norm}`);

  const { stat } = await import('node:fs/promises');
  const cacheStat = await stat(join(home, 'embeddings-cache'));
  assert.ok(cacheStat.isDirectory(), 'the model was cached under the app data home, not the library default');
});

test('embed() gives semantically closer texts a higher cosine similarity than unrelated ones', { timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-embeddings-sim-'));
  const home = join(root, 'home');
  try {
    const { embed } = await import('../core/embeddings.mts');
    const { cosineSimilarity } = await import('../core/semantic-chunk.mts');
    const [fnSort, fnSortSimilar, unrelated] = await embed([
      'function sortList(items) { return items.sort(); }',
      'function orderArray(values) { return values.sort(); }',
      'the weather in Paris is sunny today',
    ], home);
    const related = cosineSimilarity(fnSort, fnSortSimilar);
    const notRelated = cosineSimilarity(fnSort, unrelated);
    assert.ok(related > notRelated, `expected related (${related}) > unrelated (${notRelated})`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('embed([]) returns [] without loading the model at all', async () => {
  const { embed } = await import('../core/embeddings.mts');
  assert.deepEqual(await embed([], '/definitely/not/a/real/absolute/path/used'), []);
});
