import { stat } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
/** The only files a BERT encoder loads with `dtype: 'q8'` (@huggingface/transformers 4.3.0: q8 → the `_quantized` suffix). */
export const EMBEDDING_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'] as const;
export const EMBEDDING_DIMENSIONS = 384;
/** The repository's copy (electron/resources/models), used in development and by the tests. The packaged app passes
 * `<resources>/models` (build.extraResources) through workerData.modelsDir instead — see main.cjs workerOptions. */
export const DEFAULT_MODELS_DIR = fileURLToPath(new URL('../resources/models/', import.meta.url));
export const EMBEDDINGS_MISSING = 'Modèle de recherche sémantique absent de l’installation : la recherche sémantique est indisponible.';

type TransformersModule = typeof import('@huggingface/transformers');
let transformers: TransformersModule | null = null;
let extractorPromise: Promise<any> | null = null;
let modelsDir = DEFAULT_MODELS_DIR;

/** Points the loader at another models folder (absolute) and drops the pipeline loaded from the previous one. */
export function setModelsDir(dir: string): void {
  if (!isAbsolute(dir)) throw new Error('Répertoire de modèles absolu requis');
  modelsDir = dir;
  extractorPromise = null;
}

async function bundledFilesPresent(dir: string): Promise<boolean> {
  for (const file of EMBEDDING_FILES) {
    try {
      if (!(await stat(join(dir, EMBEDDING_MODEL, file))).isFile()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Local embeddings with the quantized all-MiniLM-L6-v2 that ships with the app (Apache-2.0, see the LICENSE and model
 * card beside it). Nothing is ever downloaded: a missing file fails with EMBEDDINGS_MISSING before the library is even
 * asked, and the library itself is locked to local files (allowRemoteModels = false, local_files_only) with every cache
 * off, so it neither fetches nor writes anything. The old `<dataHome>/embeddings-cache/` is left in place, unused.
 *
 * `device: 'cpu'` is @huggingface/transformers' Node build routing through onnxruntime-node (a native addon): its
 * browser/WASM build does not work outside a real browser, so the native backend is the only one that works in this
 * app's worker. Same packaging class as node-llama-cpp: a real `dependency`, never a devDependency.
 */
function getExtractor(): Promise<any> {
  if (extractorPromise) return extractorPromise;
  const dir = modelsDir;
  const loading = (async () => {
    if (!(await bundledFilesPresent(dir))) throw new Error(EMBEDDINGS_MISSING);
    if (!transformers) transformers = await import('@huggingface/transformers');
    const { pipeline, env } = transformers;
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = dir.endsWith(sep) ? dir : dir + sep;
    env.useFSCache = false;
    env.useBrowserCache = false;
    return pipeline('feature-extraction', EMBEDDING_MODEL, { device: 'cpu', dtype: 'q8', local_files_only: true });
  })();
  extractorPromise = loading;
  // A failed load is not kept: the next call checks the folder again (e.g. after a repair of the installation).
  loading.catch(() => { if (extractorPromise === loading) extractorPromise = null; });
  return loading;
}

/** Embeds a batch of texts as normalized 384-dim vectors (mean-pooled), in the same order given. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const extractor = await getExtractor();
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  const [batch, dim] = output.dims;
  const vectors: number[][] = [];
  for (let i = 0; i < batch; i++) {
    vectors.push(Array.from(output.data.slice(i * dim, (i + 1) * dim)) as number[]);
  }
  return vectors;
}
