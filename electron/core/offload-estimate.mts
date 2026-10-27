// The offload estimate (hardware and offload): where a model's layers WOULD go, computed without loading it, by the
// very resolver loadModel uses (`gpuLayers: { fitContext }`), so the figure shown before a load is the one the load
// gives while free VRAM stays the same. Slow on a big model (60–110 s on the user's 27B, measured by the recon):
// it runs in the background (core/estimate-jobs.mts), can be aborted, and its result is cached on disk.
import { lstat, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { readGgufFileInfo, GgufInsights, InsufficientMemoryError, GgmlType } from 'node-llama-cpp';
import { JsonStore } from './json-store.mts';
import { runtimeLlama, backendOf } from './llama-runtime.mts';
import { readHardware } from './hardware.mts';
import { contextOverflow, cpuFallback, type LayerLimit, type LayerLimitStore } from './local-engine.mts';
import { fitOf, type Backend, type Placement } from './placement.mts';
import { perfLevers } from './perf-levers.mts';

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
interface LimitFile { entries: { key: string; limit: LayerLimit }[] }
const NO_LIMITS: LimitFile = { entries: [] };

/** What the estimate shows once a load proved fewer layers fit (local-engine.mts::LayerLimit): the placement that load
 * really got, labelled an estimate, when it has fewer layers than `estimate` (or there is no estimate yet). An
 * estimate with fewer layers still wins: the load is capped by the limit AND placed by fitContext. */
export function withLayerLimit(estimate: Placement | null, limit: LayerLimit | null): Placement | null {
  if (!limit) return estimate;
  if (estimate && estimate.gpuLayers <= limit.gpuLayers) return estimate;
  return { ...limit.placement, source: 'estimate' };
}

/** A disposable cache's store: a regular file that cannot be read or parsed reads as the fallback, so the next write
 * replaces it with a fresh file instead of failing on it forever. Anything else (a link, a folder) still throws. */
class DisposableStore extends JsonStore {
  override async read<T>(file: string, fallback: T): Promise<T> {
    try {
      return await super.read(file, fallback);
    } catch (error) {
      const info = await lstat(file).catch(() => null);
      if (info?.isFile() && !info.isSymbolicLink()) return structuredClone(fallback);
      throw error;
    }
  }
}

/** The estimates already computed, in <dataHome>/estimates.v3.json: the last ESTIMATE_CACHE_LIMIT set, oldest first.
 * v2 came with the Vulkan/Windows VRAM padding (llama-runtime.mts::vramPaddingFor); v3 with the processor fallback
 * (local-engine.mts::cpuFallback) and « auto » resolved to CUDA keeping CUDA's padding. Older files are never read:
 * their « ne tient pas » for a full card is no longer what the load does.
 *
 * Beside it, under the same key, the layer limits real loads proved (local-engine.mts::LayerLimit), in
 * <dataHome>/layer-limits.v1.json, the last ESTIMATE_CACHE_LIMIT. A file of their own rather than a field of the
 * estimate entries: an estimate is a computation, rewritten by every estimate job and dropped with the cache version,
 * while a limit is what a load observed (a createContext refusal no estimate foresees) and must outlive both; and the
 * estimate entries keep their shape, so estimates.v3.json needs no new version. */
export class EstimateCache {
  private readonly file: string;
  private readonly limitsFile: string;
  private readonly store = new DisposableStore();
  constructor(dataHome: string) {
    this.file = join(dataHome, 'estimates.v3.json');
    this.limitsFile = join(dataHome, 'layer-limits.v1.json');
  }

  /** The cached estimate, with the remembered layer limit applied (withLayerLimit), or null. An unreadable cache file
   * reads as empty: it only costs a new estimate, and the next set replaces it. */
  async get(key: string): Promise<Placement | null> {
    const saved = await this.store.read<CacheFile>(this.file, EMPTY).catch(() => EMPTY);
    const entries = Array.isArray(saved?.entries) ? saved.entries : [];
    return withLayerLimit(entries.find(entry => entry?.key === key)?.placement ?? null, await this.limit(key));
  }

  /** The layer limit a load proved for `key`, or null (none, or an unreadable file). */
  async limit(key: string): Promise<LayerLimit | null> {
    const saved = await this.store.read<LimitFile>(this.limitsFile, NO_LIMITS).catch(() => NO_LIMITS);
    const entries = Array.isArray(saved?.entries) ? saved.entries : [];
    const limit = entries.find(entry => entry?.key === key)?.limit;
    return limit && typeof limit.gpuLayers === 'number' && limit.gpuLayers > 0 && typeof limit.placement === 'object' && limit.placement ? limit : null;
  }

  async setLimit(key: string, limit: LayerLimit): Promise<void> {
    await this.store.update<LimitFile>(this.limitsFile, NO_LIMITS, saved => {
      const kept = (Array.isArray(saved?.entries) ? saved.entries : []).filter(entry => entry?.key !== key);
      return { entries: [...kept, { key, limit }].slice(-ESTIMATE_CACHE_LIMIT) };
    }, { backup: false });
  }

  /** The engine's side of the limits (local-engine.mts::setLayerLimits), keyed as the estimates: the file (resolved
   * path, size, mtime), the context size and the hardware (backend included). */
  layerLimits(): LayerLimitStore {
    const keyOf = async (modelPath: string, contextSize: number) => estimateKey({ kind: 'file', path: modelPath }, contextSize, await hardwareKey());
    return {
      recall: async (modelPath, contextSize) => this.limit(await keyOf(modelPath, contextSize)),
      remember: async (modelPath, contextSize, limit) => this.setLimit(await keyOf(modelPath, contextSize), limit),
    };
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
 * answered « ne tient pas » (fit 'none') by the Task 4 pre-check, before any native estimation. A card too full for
 * even 0 layers gets loadLocked's processor fallback, by the same cpuFallback: 0 layers (fit 'cpu') when the RAM holds
 * it, else « ne tient pas ».
 */
export async function estimatePlacement(source: ModelSource, options: { contextSize: number; signal?: AbortSignal; onPhase?(phase: EstimatePhase): void }): Promise<Placement> {
  const { contextSize, signal } = options;
  const step = (phase: EstimatePhase) => { options.onPhase?.(phase); signal?.throwIfAborted(); };
  signal?.throwIfAborted();
  if (source.kind === 'remote') throw new Error(REMOTE_ESTIMATE_LATER);
  step('stat');
  const info = await readGgufFileInfo(source.path, { sourceType: 'filesystem', signal });
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
  // The kvCacheType lever's type (f16 shipped, Task 11), as loadModel's fitContext and createContext get it. The
  // batchSize lever is not counted: the resolver sizes the context at node-llama-cpp's default batch, as the load's
  // fitContext does; a larger batch's compute buffer is caught by createContext, and the load steps down from there.
  const kvCacheType = GgmlType[perfLevers().kvCacheType];
  const session = typeof internals._createSimulatorSession === 'function' ? internals._createSimulatorSession() : undefined;
  // Spread from an untyped object: `_simulatorSession` is an internal option of node-llama-cpp.
  const internal: object = session ? { _simulatorSession: session } : {};
  try {
    let gpuLayers = 0;
    let resolvedMmap = useMmap !== false;
    // Set when the card cannot take even 0 layers: the processor fallback loadLocked takes, by the same rule.
    let fallback: Awaited<ReturnType<typeof cpuFallback>> | null = null;
    try {
      // getVramState, the VRAM padding, the gpu type and offloading support are left to their defaults: the
      // runtime Llama's own (its padding set at creation, llama-runtime.mts::vramPaddingFor), exactly what loadModel
      // passes by not passing them.
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
      // loadLocked's fallback passes useMmap: llama.supportsMmap, which is `useMmap !== false` here.
      fallback = await cpuFallback(insights, contextSize, resolvedMmap, { internal, kvCacheType });
    }
    step('layers');

    let vramBytes: number;
    let ramBytes: number;
    if (fallback) {
      ({ vramBytes, ramBytes } = fallback);
    } else {
      const model = await insights.estimateModelResourceRequirementsV2({ gpuLayers, useMmap: resolvedMmap, ...internal });
      const context = await insights.estimateContextResourceRequirementsV2({
        contextSize, modelGpuLayers: gpuLayers, flashAttention, swaFullCache: false, kvCacheKeyType: kvCacheType, kvCacheValueType: kvCacheType, useMmap: resolvedMmap, ...internal,
      });
      vramBytes = model.gpuVram + context.gpuVram;
      ramBytes = model.cpuRam + context.cpuRam;
    }
    step('resources');
    return {
      source: 'estimate', backend, gpuLayers, totalLayers, contextSize, vramBytes, ramBytes, memoryMeasured: false,
      fit: fitOf({ backend, gpuLayers, totalLayers, ramBytes, ramTotal: os.totalmem(), insufficient: fallback !== null && !fallback.fits }),
    };
  } finally {
    await session?.dispose().catch(() => {});
  }
}

/** estimatePlacement, then the result cached under `key`. Nothing is cached when it fails or is aborted. A failed cache
 * write still answers the estimate: it only costs recomputing it next time. The answer has the remembered layer limit
 * applied (withLayerLimit), as EstimateCache.get has; the cache keeps the estimate itself. */
export async function estimateAndRemember(cache: EstimateCache, key: string, source: ModelSource, options: Parameters<typeof estimatePlacement>[1]): Promise<Placement> {
  const placement = await estimatePlacement(source, options);
  await cache.set(key, placement).catch(() => {});
  return withLayerLimit(placement, await cache.limit(key).catch(() => null)) ?? placement;
}
