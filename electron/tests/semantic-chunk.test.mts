import { test } from 'node:test';
import assert from 'node:assert/strict';

test('chunkText splits into an 800-char sliding window with 100-char overlap, like indexer.py::_chunk', async () => {
  const { chunkText } = await import('../core/semantic-chunk.mts');
  const text = 'a'.repeat(2000);
  const chunks = chunkText(text);
  // step = 800 - 100 = 700; starts at 0, 700, 1400 → 3 chunks (last one shorter).
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, 800);
  assert.equal(chunks[1].length, 800);
  assert.equal(chunks[2].length, 2000 - 1400);
});

test('chunkText drops empty/blank chunks', async () => {
  const { chunkText } = await import('../core/semantic-chunk.mts');
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n\t  '), []);
});

test('chunkText returns the whole text as one chunk when shorter than the window', async () => {
  const { chunkText } = await import('../core/semantic-chunk.mts');
  const chunks = chunkText('petit texte');
  assert.deepEqual(chunks, ['petit texte']);
});

test('cosineSimilarity: identical vectors score 1, orthogonal vectors score 0', async () => {
  const { cosineSimilarity } = await import('../core/semantic-chunk.mts');
  assert.ok(Math.abs(cosineSimilarity([1, 0, 0], [1, 0, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
});

test('cosineSimilarity: opposite vectors score -1, matches score = 1 - distance convention from indexer.py', async () => {
  const { cosineSimilarity } = await import('../core/semantic-chunk.mts');
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) - -1) < 1e-9);
});

test('cosineSimilarity rejects mismatched vector lengths and an all-zero vector rather than dividing by zero', async () => {
  const { cosineSimilarity } = await import('../core/semantic-chunk.mts');
  assert.throws(() => cosineSimilarity([1, 2], [1, 2, 3]));
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
});
