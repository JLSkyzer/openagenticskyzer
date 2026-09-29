import { join } from 'node:path';
import { isAbsolute } from 'node:path';

// Loaded lazily (not at module top-level) so that env.cacheDir below is set BEFORE
// @huggingface/transformers ever touches its default cache path inside node_modules.
type TransformersModule = typeof import('@huggingface/transformers');
let transformers: TransformersModule | null = null;
let extractorPromise: Promise<any> | null = null;
let configuredHome: string | null = null;

const MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMENSIONS = 384;

/**
 * Local embeddings — a Node/ONNX port of the same model family the previous NiceGUI app used
 * (sentence-transformers/all-MiniLM-L6-v2), run entirely offline after the model's one-time
 * download. `device: 'cpu'` here is @huggingface/transformers' NODE build routing through
 * onnxruntime-node (a native addon): the library's separate browser/WASM build (transformers.web.js)
 * does not actually work outside a real browser (verified empirically — its relative model-path
 * resolution assumes `document`/`location`), so the native backend is the only one that works
 * in this app's worker process. Same packaging class as node-llama-cpp: a real `dependency`,
 * never a devDependency.
 */
async function getExtractor(home: string) {
  if (!isAbsolute(home)) throw new Error('Répertoire de données absolu requis');
  if (extractorPromise && configuredHome === home) return extractorPromise;
  if (!transformers) transformers = await import('@huggingface/transformers');
  const { pipeline, env } = transformers;
  // Never the library's own default (inside node_modules — read-only once packaged, and gone on
  // every reinstall): the model is downloaded once into this app's own data directory.
  env.cacheDir = join(home, 'embeddings-cache') + '/';
  configuredHome = home;
  extractorPromise = pipeline('feature-extraction', MODEL, { device: 'cpu' });
  return extractorPromise;
}

/** Embeds a batch of texts as normalized 384-dim vectors (mean-pooled), in the same order given. */
export async function embed(texts: string[], home: string): Promise<number[][]> {
  if (!texts.length) return [];
  const extractor = await getExtractor(home);
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  const [batch, dim] = output.dims;
  const vectors: number[][] = [];
  for (let i = 0; i < batch; i++) {
    vectors.push(Array.from(output.data.slice(i * dim, (i + 1) * dim)) as number[]);
  }
  return vectors;
}
