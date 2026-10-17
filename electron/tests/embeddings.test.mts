import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { embed, setModelsDir, DEFAULT_MODELS_DIR, EMBEDDING_DIMENSIONS, EMBEDDING_FILES, EMBEDDING_MODEL, EMBEDDINGS_MISSING } from '../core/embeddings.mts';
import { cosineSimilarity } from '../core/semantic-chunk.mts';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

// The quantized Xenova/all-MiniLM-L6-v2 ships in electron/resources/models: nothing here ever downloads.
test('embed() produces real 384-dim normalized vectors from the bundled model', { timeout: 120000 }, async () => {
  const [vector] = await embed(['fonction qui trie une liste']);
  assert.equal(EMBEDDING_DIMENSIONS, 384);
  assert.equal(vector.length, 384);
  // normalize: true → unit vector.
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-3, `expected a unit vector, got norm ${norm}`);
});

test('embed() gives semantically closer texts a higher cosine similarity than unrelated ones', { timeout: 120000 }, async () => {
  const [fnSort, fnSortSimilar, unrelated] = await embed([
    'function sortList(items) { return items.sort(); }',
    'function orderArray(values) { return values.sort(); }',
    'the weather in Paris is sunny today',
  ]);
  const related = cosineSimilarity(fnSort, fnSortSimilar);
  const notRelated = cosineSimilarity(fnSort, unrelated);
  assert.ok(related > notRelated, `expected related (${related}) > unrelated (${notRelated})`);
});

test('embed([]) returns [] without loading the model at all', async () => {
  assert.deepEqual(await embed([]), []);
});

test('the bundled model is in the repository and packaged as extraResources', () => {
  for (const f of EMBEDDING_FILES) assert.ok(statSync(join(DEFAULT_MODELS_DIR, EMBEDDING_MODEL, f)).isFile(), f);
  assert.equal(statSync(join(DEFAULT_MODELS_DIR, EMBEDDING_MODEL, 'onnx/model_quantized.onnx')).size, 22_972_370);
  assert.match(readFileSync(join(DEFAULT_MODELS_DIR, EMBEDDING_MODEL, 'LICENSE'), 'utf8'), /Apache License/);
  assert.deepEqual(pkg.build.extraResources, [{ from: 'resources/models', to: 'models' }]);
});

test('embed never downloads: an empty models folder fails with EMBEDDINGS_MISSING and stays empty', async t => {
  const empty = await mkdtemp(join(tmpdir(), 'openagent-no-models-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  setModelsDir(empty);
  t.after(() => setModelsDir(DEFAULT_MODELS_DIR));
  await assert.rejects(embed(['x']), { message: EMBEDDINGS_MISSING });
  assert.deepEqual(await readdir(empty), []);
  assert.throws(() => setModelsDir('resources/models'), { message: 'Répertoire de modèles absolu requis' });
});

test('once loaded, the library is locked to local files', { timeout: 120000 }, async () => {
  await embed(['x']);
  const { env } = await import('@huggingface/transformers');
  assert.equal(env.allowRemoteModels, false);
  assert.equal(env.useFSCache, false);
});

test('embed() runs fixed slices of EMBED_BATCH texts and returns every vector in input order', { timeout: 120000 }, async () => {
  const { EMBED_BATCH, embeddingBatches } = await import('../core/embeddings.mts');
  assert.equal(EMBED_BATCH, 32);
  const marked = new Map([[0, 'trier une liste de nombres'], [33, 'la météo de demain à Paris'], [69, 'ouvrir une connexion à la base de données']]);
  const texts = Array.from({ length: 70 }, (_, i) => marked.get(i) ?? `ligne de remplissage numéro ${i}`);
  // The slicing embed() runs: 3 runs of 32, 32 and 6 texts, in order.
  const batches = embeddingBatches(texts);
  assert.deepEqual(batches.map(b => b.length), [32, 32, 6]);
  assert.deepEqual(batches.flat(), texts);
  const vectors = await embed(texts);
  assert.equal(vectors.length, 70);
  // Not an exact equality: the quantized model's vector of a text shifts slightly with the padding of the batch it is in
  // (measured 2026-10-17: up to 0.026 per component, cosine ≥ 0.987 to the single-call vector, ≤ 0.49 across these texts).
  const alone = new Map<number, number[]>();
  for (const [position, text] of marked) alone.set(position, (await embed([text]))[0]);
  for (const position of marked.keys()) {
    const own = cosineSimilarity(alone.get(position)!, vectors[position]);
    assert.ok(own >= 0.98, `position ${position} holds the vector of « ${marked.get(position)} » (cosine ${own})`);
    for (const other of marked.keys()) {
      if (other !== position) assert.ok(own > cosineSimilarity(alone.get(other)!, vectors[position]) + 0.3, `position ${position} is not « ${marked.get(other)} »`);
    }
  }
});
