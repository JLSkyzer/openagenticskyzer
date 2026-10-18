// The offload estimate (hardware and offload): where a model's layers WOULD go, computed without loading it, by the
// very resolver loadModel uses (`gpuLayers: { fitContext }`), so the figure shown before a load is the one the load
// gives while free VRAM stays the same. Slow on a big model (60–110 s on the user's 27B, measured by the recon):
// it runs in the background (core/estimate-jobs.mts), can be aborted, and its result is cached on disk.
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { readGgufFileInfo, GgufInsights, InsufficientMemoryError, GgmlType } from 'node-llama-cpp';
import { JsonStore } from './json-store.mts';
import { runtimeLlama, backendOf } from './llama-runtime.mts';
import { readHardware } from './hardware.mts';
import { contextOverflow } from './local-engine.mts';
import { fitOf, type Backend, type Placement } from './placement.mts';

/** Where the model file is. 'remote' is prepared for reading a model's header over the network (project 2): the
 * type and the cache key accept it, the estimate refuses it for now. */
export type ModelSource = { kind: 'file'; path: string } | { kind: 'remote'; url: string; etag?: string };
export type EstimatePhase = 'stat' | 'read' | 'insights' | 'layers' | 'resources';

export const REMOTE_ESTIMATE_LATER = "Estimation d'un modèle distant : pas encore disponible.";
export const ESTIMATE_BUSY = 'Estimation impossible pendant une réponse du modèle : réessaie à la fin de la réponse.';
export const ESTIMATE_CACHE_LIMIT = 64;

export interface HardwareKey { backend: Backend; gpuNames: string[]; vramTotal: number }

/** The machine part of the cache key: the backend, the card(s) and their TOTAL VRAM (0 on the processor). */
export async function hardwareKey(): Promise<HardwareKey> {
  const hardware = await readHardware();
  return { backend: hardware.backend, gpuNames: [...hardware.gpuNames], vramTotal: hardware.backend === 'cpu' ? 0 : hardware.vram?.total ?? 0 };
}

/**
 * The cache key: the file (resolved path, size, modification time), the context size and the hardware.
 * Known limit (ruling F9): FREE VRAM is not part of it. The resolver fits layers into the VRAM free at the time of the
 * estimate, so a persisted estimate goes stale when other programs take or release VRAM; it stays labelled « estimé »,
 * and after a load the real model.gpuLayers is shown instead.
 */
export async function estimateKey(source: ModelSource, contextSize: number, hardware: HardwareKey): Promise<string> {
  const machine = { backend: hardware.backend, gpuNames: hardware.gpuNames, vramTotal: hardware.vramTotal };
  if (source.kind === 'remote') return JSON.stringify(['remote', source.url, source.etag ?? '', contextSize, machine]);
  const path = resolve(source.path);
  const { size, mtimeMs } = await stat(path);
  return JSON.stringify(['file', path, size, mtimeMs, contextSize, machine]);
}

interface CacheFile { entries: { key: string; placement: Placement }[] }
const EMPTY: CacheFile = { entries: [] };

/** The estimates already computed, in <dataHome>/estimates.v1.json: the last ESTIMATE_CACHE_LIMIT set, oldest first. */
export class EstimateCache {
  private readonly file: string;
  private readonly store = new JsonStore();
  constructor(dataHome: string) {
    this.file = join(dataHome, 'estimates.v1.json');
  }

  /** The cached estimate, or null. An unreadable cache file reads as empty: it only costs a new estimate. */
  async get(key: string): Promise<Placement | null> {
    const saved = await this.store.read<CacheFile>(this.file, EMPTY).catch(() => EMPTY);
    const entries = Array.isArray(saved?.entries) ? saved.entries : [];
    return entries.find(entry => entry?.key === key)?.placement ?? null;
  }

  async set(key: string, placement: Placement): Promise<void> {
    // No .pre-electron.bak copy: a cache has no first version worth keeping.
    await this.store.update<CacheFile>(this.file, EMPTY, saved => {
      const kept = (Array.isArray(saved?.entries) ? saved.entries : []).filter(entry => entry?.key !== key);
      return { entries: [...kept, { key, placement }].slice(-ESTIMATE_CACHE_LIMIT) };
    }, { backup: false });
  }
}

// node-llama-cpp internals LlamaModel._create uses (3.21.1, LlamaModel.js): one simulator session shared by the layer
// resolution and the resource estimate, disposed afterwards, and the insights' default mmap. Not in its typings.
interface InsightsInternals {
  _defaultUseMmap?: boolean;
  _createSimulatorSession?(): { dispose(): Promise<void> };
}

/**
 * Where `source`'s layers would go with `contextSize` tokens of context, without loading it. Mirrors what
 * loadLocalModel's `llama.loadModel({ modelPath, gpuLayers: { fitContext: { contextSize } } })` resolves (ruling F8):
 * the same useMmap, flash-attention and KV-cache types, the same resolver, the same runtime Llama. After each phase,
 * onPhase(phase), then the signal is checked. A size the machine cannot hold even with no layer on the card is
 * answered « ne tient pas » (fit 'none') by the Task 4 pre-check, before any native estimation.
 */
export async function estimatePlacement(source: ModelSource, options: { contextSize: number; signal?: AbortSignal; onPhase?(phase: EstimatePhase): void }): Promise<Placement> {
  const { contextSize, signal } = options;
  const step = (phase: EstimatePhase) => { options.onPhase?.(phase); signal?.throwIfAborted(); };
  signal?.throwIfAborted();
  if (source.kind === 'remote') throw new Error(REMOTE_ESTIMATE_LATER);
  step('stat');
  const info = await readGgufFileInfo(source.path, { signal });
  step('read');
  const llama = await runtimeLlama();
  const insights = await GgufInsights.from(info, llama);
  const backend = backendOf(llama);
  const { totalLayers } = insights;
  step('insights');

  const overflow = await contextOverflow(llama, insights, contextSize);
  if (overflow !== null) {
    const ramBytes = insights.modelSize + overflow;
    return { source: 'estimate', backend, gpuLayers: 0, totalLayers, contextSize, vramBytes: 0, ramBytes, memoryMeasured: false, fit: 'none' };
  }

  // What LlamaModel._create resolves when loadModel gets no option beyond modelPath and gpuLayers.
  const useMmap = llama.supportsMmap ? 'auto' as const : false;
  const internals = insights as unknown as InsightsInternals;
  internals._defaultUseMmap = useMmap === 'auto' ? true : useMmap;
  const flashAttention = insights.flashAttentionSupported ? 'auto' as const : false;
  const kvCacheType = GgmlType.F16;
  const session = typeof internals._createSimulatorSession === 'function' ? internals._createSimulatorSession() : undefined;
  // Spread from an untyped object: `_simulatorSession` is an internal option of node-llama-cpp.
  const internal: object = session ? { _simulatorSession: session } : {};
  try {
    let gpuLayers = 0;
    let resolvedMmap = useMmap !== false;
    let insufficient = false;
    try {
      // getVramState, the VRAM padding, the gpu type and offloading support are left to their defaults: the
      // runtime Llama's own, exactly what loadModel passes by not passing them.
      const resolved = await insights.configurationResolver.resolveModelGpuLayersV2({ fitContext: { contextSize } }, {
        defaultContextFlashAttention: flashAttention,
        defaultContextSwaFullCache: false,
        defaultContextKvCacheKeyType: kvCacheType,
        defaultContextKvCacheValueType: kvCacheType,
        useMmap,
        signal,
        ...internal,
      });
      gpuLayers = resolved.gpuLayers;
      resolvedMmap = resolved.useMmap;
    } catch (error) {
      if (!(error instanceof InsufficientMemoryError)) throw error;
      insufficient = true;
    }
    step('layers');

    const model = await insights.estimateModelResourceRequirementsV2({ gpuLayers, useMmap: resolvedMmap, ...internal });
    const context = await insights.estimateContextResourceRequirementsV2({
      contextSize, modelGpuLayers: gpuLayers, flashAttention, swaFullCache: false, kvCacheKeyType: kvCacheType, kvCacheValueType: kvCacheType, useMmap: resolvedMmap, ...internal,
    });
    const vramBytes = model.gpuVram + context.gpuVram;
    const ramBytes = model.cpuRam + context.cpuRam;
    step('resources');
    return {
      source: 'estimate', backend, gpuLayers, totalLayers, contextSize, vramBytes, ramBytes, memoryMeasured: false,
      fit: fitOf({ backend, gpuLayers, totalLayers, ramBytes, ramTotal: os.totalmem(), insufficient }),
    };
  } finally {
    await session?.dispose().catch(() => {});
  }
}

/** estimatePlacement, then the result cached under `key`. Nothing is cached when it fails or is aborted. A failed cache
 * write still answers the estimate: it only costs recomputing it next time. */
export async function estimateAndRemember(cache: EstimateCache, key: string, source: ModelSource, options: Parameters<typeof estimatePlacement>[1]): Promise<Placement> {
  const placement = await estimatePlacement(source, options);
  await cache.set(key, placement).catch(() => {});
  return placement;
}
