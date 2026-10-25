// The model engine: with core/llama-runtime.mts, core/offload-estimate.mts and core/thought-prefill.mts, one of the modules that import node-llama-cpp, a native binding loaded only
// ("réveiller le modèle sélectionné"), never at module load time. Bridges to `local-provider.mts`'s pure
// mappers, so the agent loop (agent.mts) keeps its OpenAI-shaped messages (model-types.mts).
// The Llama belongs to llama-runtime.mts (one per worker). That module and this one import each other, so neither
// uses the other's exports at module load time: only inside functions.
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import { LlamaChat, JinjaTemplateChatWrapper, InsufficientMemoryError, readGgufFileInfo, GgufInsights, GgmlType, type Llama, type LlamaModel, type LlamaContext, type LlamaContextSequence, type TokenPredictor, type ChatWrapper, type ChatHistoryItem, type ChatModelFunctions, type Token, type Tokenizer } from 'node-llama-cpp';
import { historyFromMessages, responseToMessage, toGgufFunctions, type GgufFunctions, type GgufHistoryItem } from './local-provider.mts';
import type { ChatMessage, ChatWrapperInfo, CompletionOptions, GenerationStats, LoadStage, ModelArchitecture, ModelProvider, ToolSchema, WindowOptions } from './model-types.mts';
import { localContextSize, DEFAULT_LOCAL_CONTEXT, type LocalContextSetting } from './context-budget.mts';
import { runtimeLlama, runtimeGeneration, backendOf } from './llama-runtime.mts';
import { fitOf, type Placement } from './placement.mts';
import { untilAborted } from './abortable.mts';
import { ReplyAccumulator, type SplitPiece } from './reasoning-split.mts';
import { opensThought, type ThoughtSegment } from './thought-prefill.mts';
import { perfLevers, type PerfLevers } from './perf-levers.mts';
import { reuseOf, commonPrefixLength, type PromptCheckpointFigures } from './reuse.mts';

/** What the engine context is sized from: the « Contexte des modèles locaux » setting. max_tokens takes no part
 * (ruling F6): it caps the request window only (context-budget.mts::effectiveWindow). */
export interface ContextRequest { setting: LocalContextSetting }
export const DEFAULT_CONTEXT_REQUEST: ContextRequest = { setting: DEFAULT_LOCAL_CONTEXT };

/** A load's stop (`signal`) and follow-up (`onLoad`): model-types.mts::WindowOptions. */
export interface EngineOptions extends WindowOptions {}

export interface LocalCompletionOptions {
  modelPath: string;
  messages: readonly ChatMessage[];
  tools?: readonly ToolSchema[];
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onReasoning?: CompletionOptions['onReasoning'];
  onStats?: CompletionOptions['onStats'];
  maxTokens?: number;
  contextRequest?: ContextRequest;
  /** Follows the load this call may cause (model-types.mts::WindowOptions). */
  onLoad?: WindowOptions['onLoad'];
}

/** The one error shown when the model does not fit even with no layer on the card. */
export function localModelTooBig(contextSize: number): string {
  return `Modèle trop gros pour cette machine avec un contexte de ${contextSize} tokens : même sans couche sur la carte graphique, la mémoire ne suffit pas. Baisse « Contexte des modèles locaux » (Réglages › Matériel) ou choisis un modèle plus petit.`;
}

interface Loaded {
  path: string;
  /** The context size asked for: the reload key (ruling F3f). llama.cpp may pad what it really allocates, so
   * comparing `context.contextSize` instead would reload on every message. */
  requested: number;
  /** The runtime generation this was loaded on: once the Llama is disposed, the engine is reloaded, not reused. */
  generation: number;
  llama: Llama;
  model: LlamaModel;
  context: LlamaContext;
  chat: LlamaChat;
  /** The chat wrapper node-llama-cpp chose for this model (logged at load: `[chat] wrapper …`). */
  wrapper: ChatWrapperInfo;
  /** How the load got there (LoadOutcome), and the VRAM free just before it: what a re-placement compares with. */
  outcome: LoadOutcome;
  vramBefore: VramState | null;
}
type VramState = { total: number; used: number; free: number };

/**
 * How a load reached its placement:
 * - `direct`: node-llama-cpp's fitContext placement, as it chose it;
 * - `step-down`: createContext refused the context with `refused[i]` layers on the card (InsufficientMemoryError: the
 *   context did not fit the VRAM those layers left), and the model was loaded again with fewer;
 * - `fallback`: on the processor (0 layers) — because the card could not take even 0 layers with that context
 *   (`cause` 'loadModel', node-llama-cpp's resolver refused), or because the context still did not fit after the
 *   step-downs (`cause` 'createContext').
 */
export type LoadOutcome = (
  | { kind: 'direct' }
  | { kind: 'step-down'; refused: number[] }
  | { kind: 'fallback'; cause: 'loadModel' | 'createContext'; refused: number[] }
) & {
  /** Set when the load started at a remembered layer limit (LayerLimit) instead of node-llama-cpp's full fitContext. */
  limit?: number;
};
let loaded: Loaded | null = null;

// A file's train context, read once per version of the file (path, size, modification time).
const trainCache = new Map<string, { size: number; mtimeMs: number; train: number | undefined }>();

async function trainContextOf(modelPath: string): Promise<number | undefined> {
  const { size, mtimeMs } = await stat(modelPath);
  const cached = trainCache.get(modelPath);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.train;
  // Straight from the header (what GgufInsights.trainContextSize returns): GgufInsights.from() without a Llama would
  // load node-llama-cpp's cpu binding just for this.
  const train = (await readGgufFileInfo(modelPath)).architectureMetadata.context_length;
  trainCache.set(modelPath, { size, mtimeMs, train });
  return train;
}

/** The context size `modelPath` is loaded with for this request: localContextSize() on its train size. Reads the
 * file header only, never loads the model. */
export async function plannedContextSize(modelPath: string, request: ContextRequest): Promise<number> {
  return localContextSize({ setting: request.setting, trainContextSize: await trainContextOf(modelPath) });
}

function placementOf({ llama, model, context }: Loaded): Placement {
  const backend = backendOf(llama);
  const { totalLayers } = model.fileInsights;
  const ramBytes = model.memoryUsage.ram + context.memoryUsage.ram;
  return {
    source: 'loaded',
    backend,
    gpuLayers: model.gpuLayers,
    totalLayers,
    contextSize: context.contextSize,
    vramBytes: model.memoryUsage.vram + context.memoryUsage.vram,
    ramBytes,
    memoryMeasured: false,
    fit: fitOf({ backend, gpuLayers: model.gpuLayers, totalLayers, ramBytes, ramTotal: os.totalmem(), insufficient: false }),
  };
}

// One load or dispose at a time: two folders sending at once must not interleave a dispose with the other's load,
// which would leak a model or free a context the other just created. A stop releases its caller at once, even while
// it waits for the lock (untilAborted); a queued run whose signal is already aborted never starts.
let lock: Promise<unknown> = Promise.resolve();
function serial<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const result = lock.then(() => {
    signal?.throwIfAborted();
    return run();
  });
  lock = result.catch(() => undefined);
  return untilAborted(result, signal);
}

// For tests: how many times node-llama-cpp's loadModel was called in this process, and how many of the models it
// returned are not disposed yet.
let nativeLoads = 0;
let liveModels = 0;
export function nativeLoadCount(): number {
  return nativeLoads;
}
export function liveModelCount(): number {
  return liveModels;
}

async function disposeModel(model: LlamaModel): Promise<void> {
  if (model.disposed) return;
  await model.dispose();
  liveModels -= 1;
}

/** For tests: the warm LlamaContext itself, to tell a reused engine from a reloaded one by identity. */
export function warmContext(): LlamaContext | null {
  return loaded?.context ?? null;
}

/**
 * Refuses, before any native code runs, a context that cannot fit even with every layer on the processor: on a
 * Vulkan card, node-llama-cpp's own fitContext resolution of such a size can abort the whole process natively
 * instead of throwing. Conservative on purpose — it must never refuse a load that would fit:
 * - the requirement is the KV cache alone (no weights, no graph overhead), at f16, which is what loadModel uses here;
 * - the room is ALL the RAM plus ALL the VRAM, free or not; a card whose VRAM cannot be read counts as unlimited.
 * The V1 estimate is arithmetic on the header (plus constant lookups in the already loaded binding): no tensor is
 * allocated, unlike the V2 simulation. Returns the insights, which the processor fallback (cpuFallback) reuses.
 */
async function assertContextCanFit(llama: Llama, modelPath: string, contextSize: number): Promise<GgufInsights> {
  const insights = await GgufInsights.from(await readGgufFileInfo(modelPath), llama);
  if ((await contextOverflow(llama, insights, contextSize)) !== null) throw new Error(localModelTooBig(contextSize));
  return insights;
}

/** The pre-check itself, shared with the offload estimate (core/offload-estimate.mts), which must not run native
 * code for a hopeless size either: the KV cache bytes `contextSize` needs when they exceed all the RAM plus all the
 * VRAM, else null. */
export async function contextOverflow(llama: Llama, insights: GgufInsights, contextSize: number): Promise<number | null> {
  const { cpuRam, gpuVram } = insights.estimateContextResourceRequirements({ contextSize, modelGpuLayers: 0, includeGraphOverhead: false });
  const vramTotal = llama.gpu === false ? 0 : (await llama.getVramState().catch(() => null))?.total ?? Number.POSITIVE_INFINITY;
  const required = cpuRam + gpuVram;
  return required > os.totalmem() + vramTotal ? required : null;
}

const mib = (bytes: number) => `${Math.round(bytes / 1024 ** 2)} Mio`;

/** What a load outcome adds to the [placement] line, and to the turn log's model-ready (`placementNote`): nothing for
 * a direct placement, else what happened and why. */
export function outcomeNote(outcome: LoadOutcome | undefined): string {
  if (!outcome) return '';
  const limit = outcome.limit === undefined ? '' : `limite mémorisée : ${outcome.limit} couches`;
  return [limit, howNote(outcome)].filter(Boolean).join(' · ');
}

function howNote(outcome: LoadOutcome): string {
  if (outcome.kind === 'direct') return '';
  const tries = (refused: number[]) => refused.join(' puis ');
  if (outcome.kind === 'step-down') return `moins de couches : le contexte ne tenait pas sur la carte avec ${tries(outcome.refused)} couches`;
  if (outcome.cause === 'loadModel') {
    const before = outcome.refused.length ? `le contexte ne tenait pas avec ${tries(outcome.refused)} couches, puis ` : '';
    return `repli processeur : ${before}la carte ne prenait même pas 0 couche avec ce contexte (carte pleine)`;
  }
  return `repli processeur : le contexte ne tenait toujours pas sur la carte (essais à ${tries(outcome.refused)} couches)`;
}

/** The one line a load logs (I-1): where its layers went, against which free VRAM and padding, and how it got there
 * when node-llama-cpp's placement was not kept as is (outcomeNote: fewer layers, or the processor fallback). */
export function placementLogLine(p: { backend: string; gpuLayers: number; totalLayers: number; useMmap: boolean; vramBefore: VramState | null; padding: number; contextSize: number; outcome?: LoadOutcome }): string {
  const before = p.vramBefore ? `libre ${mib(p.vramBefore.free)} / total ${mib(p.vramBefore.total)} (utilisée ${mib(p.vramBefore.used)})` : 'illisible';
  const note = outcomeNote(p.outcome);
  return `[placement] backend ${p.backend} · couches ${p.gpuLayers}/${p.totalLayers} sur la carte${note ? ` · ${note}` : ''} · mmap ${p.useMmap ? 'oui' : 'non'} · VRAM avant chargement : ${before} · marge VRAM ${mib(p.padding)} · contexte ${p.contextSize}`;
}

/** At most this many loads with fewer layers after createContext refused the context, before the processor. */
export const MAX_STEP_DOWNS = 3;

/** The most layers the next load may put on the card after createContext refused the context with `refused` layers:
 * about 10 % fewer, at least one. The 27B of 2026-10-24 missed by tens to a few hundred MiB (CUDA's own allocations,
 * not in the free VRAM read before the load); 10 % of its 25 layers is about 570 MiB, so one retry covers it while
 * costing only 3 layers. null: nothing left to step down to. */
export function stepDownMax(refused: number): number | null {
  const next = refused - Math.max(1, Math.ceil(refused / 10));
  return next > 0 ? next : null;
}

/**
 * A step-down remembered (part B of 2026-10-24: the 27B stepped down 25 → 22 → 19 on every cold load, 3 loads and
 * 33 s, because nothing foresees createContext's refusal). Kept per model file (path, size, mtime), context size and
 * hardware (backend, cards, total VRAM): offload-estimate.mts::EstimateCache, in layer-limits.v1.json. The next load
 * of that key starts at `gpuLayers` (`{ min: 0, max: gpuLayers, fitContext }`), and the estimate shows `placement`.
 * `freeVram`: the free VRAM read before the load that set it (null: unreadable).
 */
export interface LayerLimit { gpuLayers: number; freeVram: number | null; placement: Placement }
export interface LayerLimitStore {
  recall(modelPath: string, contextSize: number): Promise<LayerLimit | null>;
  remember(modelPath: string, contextSize: number, limit: LayerLimit): Promise<void>;
}
let layerLimits: LayerLimitStore | null = null;
/** Where the engine remembers its limits (worker.mjs: its EstimateCache). None: every load starts at fitContext. */
export function setLayerLimits(store: LayerLimitStore | null): void {
  layerLimits = store;
}

/** The free-VRAM noise floor: the 27B's refusals missed by tens to a few hundred MiB (CUDA's own allocations, not in
 * the free VRAM read before the load), so a gain below 512 MiB says nothing on a small model. */
export const LIMIT_RETRY_MIN_BYTES = 512 * 1024 ** 2;

/**
 * Whether a remembered limit still applies: yes, unless the free VRAM grew since it was noted by what the re-placement
 * calls clearly more room (REPLACE_MIN_LAYERS layers of this model) and by at least LIMIT_RETRY_MIN_BYTES. Then the
 * full fitContext runs again (a game closed). An unreadable figure keeps the limit: at worst a few layers too few,
 * which the re-placement between turns can still raise.
 */
export function limitStillHolds(p: { freeAtRecord: number | null; freeNow: number | null; bytesPerLayer: number }): boolean {
  if (p.freeAtRecord === null || p.freeNow === null) return true;
  return p.freeNow - p.freeAtRecord < Math.max(REPLACE_MIN_LAYERS * p.bytesPerLayer, LIMIT_RETRY_MIN_BYTES);
}

/** The limit remembered for this load, and whether it applies (`apply`: false for a re-placement, which must be free
 * to go higher). Never fails a load: an unreadable store reads as no limit. */
async function recallLimit(p: { modelPath: string; contextSize: number; llama: Llama; insights: GgufInsights; vramBefore: VramState | null; apply: boolean }): Promise<{ record: LayerLimit; applies: boolean } | null> {
  if (!layerLimits || p.llama.gpu === false) return null;
  const record = await layerLimits.recall(p.modelPath, p.contextSize).catch((error: unknown) => {
    console.warn(`[placement] limite mémorisée illisible : ${(error as Error | undefined)?.message ?? error}`);
    return null;
  });
  if (!record || !(record.gpuLayers > 0)) return null;
  if (!p.apply) return { record, applies: false };
  const freeNow = p.vramBefore?.free ?? null;
  const bytesPerLayer = p.insights.totalLayers > 0 ? p.insights.modelSize / p.insights.totalLayers : 0;
  if (limitStillHolds({ freeAtRecord: record.freeVram, freeNow, bytesPerLayer })) return { record, applies: true };
  console.info(`[placement] limite mémorisée de ${record.gpuLayers} couches ignorée : ${mib((freeNow ?? 0) - (record.freeVram ?? 0))} de VRAM libres en plus depuis qu'elle a été notée`);
  return { record, applies: false };
}

/** Notes what this load proved: the count a step-down reached, or a success above the record (more room since).
 * Nothing for the processor (0 layers), nor for a load that only stayed under its limit. Never fails a load. */
async function rememberLimit(p: { modelPath: string; contextSize: number; loaded: Loaded; refused: readonly number[]; record: LayerLimit | null }): Promise<void> {
  const { gpuLayers } = p.loaded.model;
  if (!layerLimits || p.loaded.llama.gpu === false || gpuLayers <= 0) return;
  if (p.refused.length === 0 && !(p.record && gpuLayers > p.record.gpuLayers)) return;
  await layerLimits.remember(p.modelPath, p.contextSize, { gpuLayers, freeVram: p.loaded.vramBefore?.free ?? null, placement: placementOf(p.loaded) }).catch((error: unknown) => {
    console.warn(`[placement] limite de couches non mémorisée : ${(error as Error | undefined)?.message ?? error}`);
  });
}

const memoryWarning = (stage: 'loadModel' | 'createContext', layers: string, error: Error) =>
  console.warn(`[placement] InsufficientMemoryError (${stage}, ${layers} couches) : ${error.message}`);

export interface CpuFallback { fits: boolean; ramBytes: number; vramBytes: number }

/**
 * Whether `insights`' model, with 0 layers on the card and `contextSize` tokens of context, fits in the RAM: the one
 * rule for the processor fallback, used by the load (loadLocked) and by the estimate (offload-estimate.mts), so the
 * figure shown is the one loaded. Needed because node-llama-cpp's fitContext resolution THROWS InsufficientMemoryError
 * when even 0 layers needs some VRAM (a compute buffer stays on the card), instead of answering 0 layers
 * (3.21.1, resolveModelGpuLayersOption.js). The fit is fitOf's: the RAM estimate against all the RAM (os.totalmem()).
 * The estimates are node-llama-cpp's V2 ones with what loadModel and createContext use here: f16 KV cache,
 * flash attention 'auto' when supported, no full SWA cache. `internal`: node-llama-cpp's simulator session, if any.
 */
export async function cpuFallback(insights: GgufInsights, contextSize: number, useMmap: boolean, options: { ramTotal?: number; internal?: object } = {}): Promise<CpuFallback> {
  const { ramTotal = os.totalmem(), internal = {} } = options;
  const flashAttention = insights.flashAttentionSupported ? 'auto' as const : false;
  const model = await insights.estimateModelResourceRequirementsV2({ gpuLayers: 0, useMmap, ...internal });
  const context = await insights.estimateContextResourceRequirementsV2({
    contextSize, modelGpuLayers: 0, flashAttention, swaFullCache: false, kvCacheKeyType: GgmlType.F16, kvCacheValueType: GgmlType.F16, useMmap, ...internal,
  });
  const ramBytes = model.cpuRam + context.cpuRam;
  return { fits: ramBytes <= ramTotal, ramBytes, vramBytes: model.gpuVram + context.gpuVram };
}

/**
 * Loads `modelPath` with exactly `contextSize` tokens of context, its layers placed by node-llama-cpp for THAT
 * context (`gpuLayers: { fitContext }`), and keeps it warm. The warm engine is reused only for the same path, the
 * same requested size and the same runtime Llama; anything else reloads. When the card is too full for even 0 layers,
 * it loads on the processor if the RAM holds it (cpuFallback). When the machine cannot hold it even with no layer on
 * the card, nothing stays loaded and the error is localModelTooBig(contextSize).
 */
export async function loadLocalModel(modelPath: string, contextSize: number, options: EngineOptions = {}): Promise<Placement> {
  // The placement is read inside the lock: a load queued behind this one may dispose this context.
  return serial(async () => placementOf(await loadLocked(modelPath, contextSize, options)), options.signal);
}

/** `options.signal` stops the load (node-llama-cpp's loadSignal and createSignal, on the fallback too), and the
 * rejection is then always the signal's own reason — a DOMException AbortError, whatever node-llama-cpp threw —
 * which the worker tests by name. `options.onLoad` follows a real load only: start, progress, end. */
async function loadLocked(modelPath: string, contextSize: number, options: EngineOptions = {}): Promise<Loaded> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (loaded && loaded.path === modelPath && loaded.requested === contextSize && loaded.generation === runtimeGeneration()) return loaded;
  try {
    return await loadFresh(modelPath, contextSize, options);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw error;
  }
}

/** `applyLimit`: false for the re-placement, which reloads to go higher than the load before it. */
async function loadFresh(modelPath: string, contextSize: number, { signal, onLoad }: EngineOptions, applyLimit = true): Promise<Loaded> {
  const startedAt = performance.now();
  onLoad?.({ kind: 'start' });
  const onLoadProgress = (progress: number) => onLoad?.({ kind: 'progress', progress });
  await disposeLocked();
  // Each stage of the load, timed (the bench's load figures): the runtime, the pre-checks, one loadModel and one
  // createContext per attempt, then the chat (keep).
  const stages: LoadStage[] = [];
  let stageStart = performance.now();
  const stage = (name: LoadStage['stage'], ok: boolean, extra: { gpuLayers?: number } = {}) => {
    const now = performance.now();
    stages.push({ stage: name, ms: Math.round((now - stageStart) * 10) / 10, ok, ...extra });
    stageStart = now;
  };
  const llama = await runtimeLlama();
  const generation = runtimeGeneration();
  stage('engine', true);
  const insights = await assertContextCanFit(llama, modelPath, contextSize);
  const vramBefore = await llama.getVramState().catch(() => null);
  const remembered = await recallLimit({ modelPath, contextSize, llama, insights, vramBefore, apply: applyLimit });
  const limit = remembered?.applies ? remembered.record.gpuLayers : null;
  stage('precheck', true);
  const architecture: ModelArchitecture = { hybrid: insights.isHybrid, recurrent: insights.isRecurrent, swaSize: insights.swaSize ?? null, mtpWeights: insights.hasMtpWeights };
  // llama.cpp's own timings, printed after each generation (completeLocal), when the bench asks for them.
  const tracking = perfLevers().performanceTracking ? { performanceTracking: true } : {};
  // The layer counts createContext refused, in order (read by `kept` once the loop ends).
  const refused: number[] = [];
  const kept = async (model: LlamaModel, context: LlamaContext, outcome: LoadOutcome) => {
    const result = keep({ modelPath, contextSize, generation, llama, model, context, vramBefore, outcome: limit === null ? outcome : { ...outcome, limit }, startedAt, onLoad, stages, architecture });
    await rememberLimit({ modelPath, contextSize, loaded: result, refused, record: remembered?.record ?? null });
    return result;
  };
  // The cap of the next fitContext load: the remembered limit, else none at first.
  let max: number | null = limit;
  let cause: 'loadModel' | 'createContext' = 'createContext';
  for (;;) {
    let model: LlamaModel;
    try {
      nativeLoads += 1;
      // fitContext places as many layers as node-llama-cpp thinks fit with this context; after a refusal, at most `max`.
      const gpuLayers = max === null ? { fitContext: { contextSize } } : { min: 0, max, fitContext: { contextSize } };
      model = await llama.loadModel({ modelPath, gpuLayers, loadSignal: signal, onLoadProgress });
      liveModels += 1;
      stage('loadModel', true, { gpuLayers: model.gpuLayers });
    } catch (error) {
      if (!(error instanceof InsufficientMemoryError)) throw error;
      stage('loadModel', false);
      // node-llama-cpp's resolver: the card cannot take even 0 layers with this context (a game holding the VRAM).
      memoryWarning('loadModel', max === null ? 'fitContext' : `fitContext ≤ ${max}`, error);
      cause = 'loadModel';
      break;
    }
    try {
      // A fixed size: no silent shrink on failure (node-llama-cpp only retries an 'auto' size, said here anyway).
      const context = await model.createContext({ contextSize, failedCreationRemedy: false, createSignal: signal, ...tracking });
      stage('createContext', true);
      return await kept(model, context, refused.length ? { kind: 'step-down', refused: [...refused] } : { kind: 'direct' });
    } catch (error) {
      const layers = model.gpuLayers;
      await disposeModel(model);
      if (!(error instanceof InsufficientMemoryError)) throw error;
      stage('createContext', false);
      // The layers loaded, then the context did not fit what they left (or the RAM): fewer layers, not the processor
      // yet (the regression of 2026-10-24: 25/66 loaded, then 0/66).
      memoryWarning('createContext', String(layers), error);
      refused.push(layers);
      const next = layers > 0 && refused.length <= MAX_STEP_DOWNS ? stepDownMax(layers) : null;
      if (next === null) break;
      max = next;
      signal?.throwIfAborted();
      onLoad?.({ kind: 'retry', mode: 'fewer-layers' });
    }
  }
  const outcome: LoadOutcome = { kind: 'fallback', cause, refused: [...refused] };
  // The processor, when the RAM holds it. useMmap is explicit: with ignoreMemorySafetyChecks, a numeric gpuLayers and
  // useMmap 'auto', node-llama-cpp turns mmap OFF when nothing fits and copies the whole model into RAM.
  // ignoreMemorySafetyChecks skips its VRAM check at 0 layers, and its RAM check with it: cpuFallback is that RAM check.
  const useMmap = llama.supportsMmap;
  if (!(await cpuFallback(insights, contextSize, useMmap)).fits) throw new Error(localModelTooBig(contextSize));
  signal?.throwIfAborted();
  onLoad?.({ kind: 'retry', mode: 'cpu' });
  nativeLoads += 1;
  // The fallback's own load: its time starts here, not at the refusal before it.
  stageStart = performance.now();
  const model = await llama.loadModel({ modelPath, gpuLayers: 0, useMmap, ignoreMemorySafetyChecks: true, loadSignal: signal, onLoadProgress });
  liveModels += 1;
  stage('loadModel', true, { gpuLayers: model.gpuLayers });
  let context: LlamaContext;
  try {
    context = await model.createContext({ contextSize, failedCreationRemedy: false, ignoreMemorySafetyChecks: true, createSignal: signal, ...tracking });
    stage('createContext', true);
  } catch (error) {
    // Even 0 layers keeps a compute buffer on the card: an allocation the full card refuses ends here.
    await disposeModel(model);
    if (signal?.aborted) throw signal.reason;
    console.warn(`[placement] repli processeur : le contexte n'a pas pu être créé : ${(error as Error | undefined)?.message ?? error}`);
    throw new Error(localModelTooBig(contextSize));
  }
  return await kept(model, context, outcome);
}

/** The options of the chat's context sequence, from the levers: the checkpoints a hybrid model restores a reused prefix
 * from (shipped = node-llama-cpp's defaults, so the shipped app is unchanged). */
export function sequenceOptions(levers: Readonly<PerfLevers>): { checkpoints: { max: number; interval: number; maxMemory: number | null }; tokenPredictor?: TokenPredictor } {
  return { checkpoints: { max: levers.checkpointMax, interval: levers.checkpointInterval, maxMemory: levers.checkpointMaxMemory } };
}

/** LlamaChat's own prompt for `history` (node-llama-cpp 3.21.1, `getContextWindow` when the history fits the window,
 * as `fitToBudget` ensures): the chat wrapper's context state for the history ending in a model turn
 * (`ensureLastHistoryItemIsModel`), with the functions when there are any (`functionsEnabled`). */
function promptTokensOf(wrapper: ChatWrapper, tokenizer: Tokenizer, history: readonly GgufHistoryItem[], functions: GgufFunctions | undefined): Token[] {
  const chatHistory = (history.at(-1)?.type === 'model' ? [...history] : [...history, { type: 'model', response: [] }]) as unknown as ChatHistoryItem[];
  const availableFunctions = functions && Object.keys(functions).length > 0 ? functions as ChatModelFunctions : undefined;
  return wrapper.generateContextState({ chatHistory, availableFunctions }).contextText.tokenize(tokenizer);
}

/**
 * The prompt LlamaChat will read for `history`, and how many of its first tokens the next turn renders the same
 * (`stable`): the common prefix of the prompt and of the same history followed by a reply and a new message, at most
 * the prompt's length − 1. The cap is the case that matters: a template that opens the thought in its generation
 * prompt (Qwen 3.5/3.6, `openedOnStart`) ends it with `<think>\n`, and renders the reply back as `<think>\n\n</think>`;
 * `\n\n` is one token, so the next turn parts at the prompt's LAST token, and only a checkpoint before it is reusable.
 */
export function stablePromptLength(wrapper: ChatWrapper, tokenizer: Tokenizer, history: readonly GgufHistoryItem[], functions: GgufFunctions | undefined): { tokens: Token[]; stable: number } {
  const tokens = promptTokensOf(wrapper, tokenizer, history, functions);
  const last = history.at(-1);
  // The next turn's form: this turn's reply rendered back (appended to a model turn already open: a tool step), then a
  // new message. Any text stands for the reply: only where the two renderings part matters.
  const replied: GgufHistoryItem[] = last?.type === 'model'
    ? [...history.slice(0, -1), { type: 'model', response: [...last.response, 'x'] }, { type: 'user', text: 'y' }]
    : [...history, { type: 'model', response: ['x'] }, { type: 'user', text: 'y' }];
  const stable = Math.min(commonPrefixLength(tokens, promptTokensOf(wrapper, tokenizer, replied, functions)), tokens.length - 1);
  return { tokens, stable };
}

/**
 * The promptCheckpoint lever (Task 3b), before `generateResponse`: aligns the sequence with the prompt as LlamaChat
 * would (`alignCurrentSequenceStateWithCurrentTokens`: every token but the last, no shift), evaluates it up to its
 * stable end, and takes a checkpoint there with the public `takeCheckpoint()`. LlamaChat then finds that state as its
 * prefix and reads only the rest. On a hybrid model the next turn, diverging at the stable end, restores this
 * checkpoint instead of re-reading the prompt: LlamaChat's own checkpoint, at the first generated token, sits on the
 * prompt's last token, one past that divergence, and is pruned. A no-op checkpoint on an attention model.
 * null when the prompt does not fit the window (LlamaChat would compress the history: other tokens).
 */
export async function checkpointPromptEnd(sequence: LlamaContextSequence, wrapper: ChatWrapper, history: readonly GgufHistoryItem[], functions: GgufFunctions | undefined): Promise<PromptCheckpointFigures | null> {
  const { tokens, stable } = stablePromptLength(wrapper, sequence.model.tokenizer, history, functions);
  if (tokens.length + 1 >= sequence.contextSize) return null;
  await sequence.adaptStateToTokens(tokens.slice(0, -1), false);
  const from = sequence.nextTokenIndex;
  // The state already holds past the stable end (the same prompt sent again): nothing to evaluate, and a checkpoint
  // there would need the held tokens erased.
  if (from >= stable) return { prompt: tokens.length, stable, from, index: null };
  await sequence.evaluateWithoutGeneratingNewTokens(tokens.slice(from, stable));
  const index = sequence.nextTokenIndex - 1;
  await sequence.takeCheckpoint();
  return { prompt: tokens.length, stable, from, index };
}

function keep(p: { modelPath: string; contextSize: number; generation: number; llama: Llama; model: LlamaModel; context: LlamaContext; vramBefore: VramState | null; outcome: LoadOutcome; startedAt: number; onLoad?: EngineOptions['onLoad']; stages: readonly LoadStage[]; architecture: ModelArchitecture }): Loaded {
  const { llama, model, context } = p;
  const chatStart = performance.now();
  const chat = new LlamaChat({ contextSequence: context.getSequence(sequenceOptions(perfLevers())) });
  const chatMs = performance.now() - chatStart;
  // The segments as plain JSON, once (ruling T2-m2): the log line and the turn log's model-ready show the same value.
  const segments = chat.chatWrapper.settings.segments;
  // Does the template open <think> itself? Then every reply starts as reasoning (core/thought-prefill.mts).
  const thinks = opensThought({
    template: model.fileInfo.metadata?.tokenizer?.chat_template,
    reasoning: chat.chatWrapper instanceof JinjaTemplateChatWrapper ? chat.chatWrapper.reasoning ?? true : true,
    thought: segments?.thought as ThoughtSegment | undefined,
  });
  const wrapper: ChatWrapperInfo = { name: chat.chatWrapper.wrapperName, segments: JSON.parse(JSON.stringify(segments ?? null)), opensThought: thinks };
  loaded = { path: p.modelPath, requested: p.contextSize, generation: p.generation, llama, model, context, chat, wrapper, outcome: p.outcome, vramBefore: p.vramBefore };
  console.info(placementLogLine({ backend: backendOf(llama), gpuLayers: model.gpuLayers, totalLayers: model.fileInsights.totalLayers, useMmap: model.useMmap, vramBefore: p.vramBefore, padding: llama.vramPaddingSize, contextSize: context.contextSize, outcome: p.outcome }));
  console.info(chatWrapperLogLine(wrapper));
  const stages: LoadStage[] = [...p.stages, { stage: 'chat', ms: Math.round(chatMs * 10) / 10, ok: true }];
  p.onLoad?.({ kind: 'end', ms: Math.round(performance.now() - p.startedAt), wrapper, stages, architecture: p.architecture });
  return loaded;
}

/** The one line a load logs about its chat template: the wrapper node-llama-cpp chose, its thought segments (null:
 * the template declares none, and a reasoning model's tags are then caught by reasoning-split.mts only), and whether
 * the template opens <think> itself (every reply then starts as reasoning). */
export function chatWrapperLogLine(info: ChatWrapperInfo): string {
  return `[chat] wrapper ${info.name} · segments ${JSON.stringify(info.segments ?? null)} · réflexion ouverte par le modèle de conversation : ${info.opensThought ? 'oui' : 'non'}`;
}

/** The chat wrapper of the loaded `modelPath`, or null when it is not the model loaded now. Never loads anything. */
export function loadedChatWrapper(modelPath: string): ChatWrapperInfo | null {
  return loaded?.path === modelPath ? loaded.wrapper : null;
}

/** How the loaded `modelPath` got its placement (LoadOutcome), or null when it is not the model loaded now. */
export function loadedOutcome(modelPath: string): LoadOutcome | null {
  return loaded?.path === modelPath ? loaded.outcome : null;
}

/** Where the loaded `modelPath` really sits (model.gpuLayers, never an estimate), or null when it is not the model
 * loaded now. Never loads anything. */
export function loadedPlacement(modelPath: string): Placement | null {
  return loaded?.path === modelPath ? placementOf(loaded) : null;
}

// "Réveiller" = load once, on the first real message, and keep it warm across turns while the same file and the
// same context size stay selected — a fresh `LlamaChat` still gets the FULL history every call (it keeps no memory
// of its own between generateResponse() calls), so re-using the same instance is purely a cost optimisation, not
// a correctness requirement. A changed « Contexte des modèles locaux » reloads at the next message.
async function engineFor(modelPath: string, request: ContextRequest, options: EngineOptions = {}): Promise<Loaded> {
  const contextSize = await plannedContextSize(modelPath, request);
  return serial(() => loadLocked(modelPath, contextSize, options), options.signal);
}

/** Frees whatever local model is currently loaded (switching to another model or context size, or the app shutting
 * down) — a GGUF model can hold several gigabytes of RAM/VRAM, so this is never left to the GC. The Llama itself is
 * not disposed here: llama-runtime.mts owns it. */
export function disposeEngine(): Promise<void> {
  return serial(disposeLocked);
}

async function disposeLocked(): Promise<void> {
  if (!loaded) return;
  const { context, model } = loaded;
  loaded = null;
  await context.dispose();
  await disposeModel(model);
}

/**
 * Re-placement between turns (final fix wave, item 4): whether the loaded model should be reloaded, now that the card
 * may have more room than its load saw (a game closed). Pure and cheap: no estimate, only the free VRAM now against
 * the free VRAM before the load, counted in layers of this model.
 * - Only a load that could not keep node-llama-cpp's placement (`fallback` or `step-down`): a `direct` one already got
 *   what the resolver wanted for the VRAM it saw, and comparing again would only chase noise.
 * - A reload frees the loaded model's own VRAM (`loadedVram`), so it would see `freeNow + loadedVram`; the gain is that
 *   against `freeAtLoad`, in layers of `bytesPerLayer` (the weights over the layer count — the KV cache per layer is
 *   left out, so the count is generous).
 * - REPLACE_MIN_LAYERS layers at least: a reload of a big model costs as much as its first load (45 s for the 27B), and
 *   a gain of 1 to 3 layers is within the margin that made the first load step down or fall back — it would most
 *   likely end where it started. A reload that ends where it started does not repeat: its own load becomes the
 *   reference.
 */
export const REPLACE_MIN_LAYERS = 4;
export interface ReplacementInput {
  outcome: LoadOutcome['kind'];
  /** The load started at a remembered layer limit: a `direct` one is then open to the re-placement too. */
  limited?: boolean;
  gpuLayers: number;
  totalLayers: number;
  freeAtLoad: number | null;
  freeNow: number | null;
  loadedVram: number;
  bytesPerLayer: number;
}
export interface ReplacementDecision { replace: boolean; extraLayers: number; reason: string }

export function replacementDecision(input: ReplacementInput): ReplacementDecision {
  const no = (reason: string): ReplacementDecision => ({ replace: false, extraLayers: 0, reason });
  if (input.outcome === 'direct' && !input.limited) return no('placement direct');
  if (input.gpuLayers >= input.totalLayers) return no('toutes les couches sont déjà sur la carte');
  if (input.freeAtLoad === null || input.freeNow === null || !(input.bytesPerLayer > 0)) return no('VRAM illisible');
  const gain = input.freeNow + input.loadedVram - input.freeAtLoad;
  const extraLayers = Math.max(0, Math.min(input.totalLayers - input.gpuLayers, Math.floor(gain / input.bytesPerLayer)));
  if (extraLayers < REPLACE_MIN_LAYERS) return { replace: false, extraLayers, reason: `pas assez de place en plus (${extraLayers} couches)` };
  const from = input.outcome === 'fallback' ? 'repli processeur' : `${input.gpuLayers} couches`;
  return { replace: true, extraLayers, reason: `${from}, environ ${extraLayers} couches de plus tiennent maintenant sur la carte (${mib(Math.max(0, gain))} libérés)` };
}

/** The re-placement decision for the loaded `modelPath`, from one cheap VRAM read (getVramState); null when it is not
 * the model loaded now (or the Llama it was loaded on is gone). Never loads, never estimates. */
export async function replacementCheck(modelPath: string): Promise<ReplacementDecision | null> {
  const isCurrent = (current: Loaded | null): current is Loaded => current !== null && current.path === modelPath && current.generation === runtimeGeneration();
  if (!isCurrent(loaded)) return null;
  // A direct placement, or the processor backend, is decided without any native call: the common case after a turn
  // touches nothing native at all.
  const limited = loaded.outcome.limit !== undefined;
  if ((loaded.outcome.kind === 'direct' && !limited) || loaded.llama.gpu === false) {
    const { model } = loaded;
    return replacementDecision({ outcome: loaded.outcome.kind, limited, gpuLayers: model.gpuLayers, totalLayers: model.fileInsights.totalLayers, freeAtLoad: null, freeNow: null, loadedVram: 0, bytesPerLayer: 0 });
  }
  await generationsIdle();
  const current = loaded;
  if (!isCurrent(current)) return null;
  const { llama, model, context, outcome, vramBefore } = current;
  const now = await llama.getVramState().catch(() => null);
  const { totalLayers } = model.fileInsights;
  return replacementDecision({
    outcome: outcome.kind, limited: outcome.limit !== undefined, gpuLayers: model.gpuLayers, totalLayers,
    freeAtLoad: vramBefore?.free ?? null, freeNow: now?.free ?? null,
    loadedVram: model.memoryUsage.vram + context.memoryUsage.vram,
    bytesPerLayer: totalLayers > 0 ? model.fileInsights.modelSize / totalLayers : 0,
  });
}

/** Reloads the loaded `modelPath` with the same context size, placed again for the VRAM free now (the step-down and
 * the processor fallback apply as on any load). Waits for the engine's lock like any load; `options.signal` (a send)
 * cancels it: before it starts, the warm model stays as it is; during the native load, that load stops and the next
 * turn loads the model itself. null when `modelPath` is no longer the model loaded. */
export function replaceLoaded(modelPath: string, options: EngineOptions = {}): Promise<Placement | null> {
  const { signal } = options;
  return serial(async () => {
    await untilAborted(generationsIdle(), signal);
    if (!loaded || loaded.path !== modelPath || loaded.generation !== runtimeGeneration()) return null;
    try {
      // Not capped by the remembered limit: a re-placement is there to go higher (and a success above it raises it).
      return placementOf(await loadFresh(modelPath, loaded.requested, options, false));
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw error;
    }
  }, signal);
}

/** For tests: which path (if any) is currently kept warm, without touching it. */
export function warmModelPath(): string | null {
  return loaded?.path ?? null;
}

/** Loads `modelPath` if needed and returns the context size the engine really runs with: the window the
 * request budget is computed from. */
export async function engineContextSize(modelPath: string, request: ContextRequest = DEFAULT_CONTEXT_REQUEST, options: EngineOptions = {}): Promise<number> {
  return (await engineFor(modelPath, request, options)).context.contextSize;
}

/** The context size `modelPath` runs with if it is the model loaded now, else null. Never loads anything: the
 * model-status op reads it without waking a model the user has not used yet. */
export function loadedContextSize(modelPath: string): number | null {
  return loaded?.path === modelPath ? loaded.context.contextSize : null;
}

/** A GGUF tool-call id that never repeats, across app launches too: a counter restarted at 1 each time and
 * collided with the calls already in a conversation, whose results were then shown under the wrong call. */
export function mintCallId(): string {
  return `local-${randomUUID()}`;
}

// An HTTP model server enforces some sane generation limit even when it is not asked for one
// — here WE are the server, and node-llama-cpp will happily generate until end-of-sequence or the context
// is full if left unbounded, which on a model that rarely emits a natural stop token means an effectively
// hung turn. The cap is the one the Python app gave the local HTTP servers it supported (LM Studio, a
// llama.cpp server); a reply that reaches it is flagged truncated, like finish_reason "length".
export const LOCAL_OUTPUT_CAP = 8192;

// The generations node-llama-cpp is still running. A stopped turn ends for the page at once (untilAborted upstream),
// while its generation unwinds natively a little longer: nothing between turns (the re-placement's VRAM read and
// reload) may touch the engine before it has. Reading the VRAM, or disposing the context, during that tail crashed the
// process natively (0xC0000409, reproduced with stories260K: stop, then the re-placement at once).
const generations = new Set<Promise<unknown>>();
function tracked<T>(generation: Promise<T>): Promise<T> {
  const settled = generation.then(() => undefined, () => undefined);
  generations.add(settled);
  void settled.then(() => generations.delete(settled));
  return generation;
}
/** The limits one generation runs under: the outputCap lever (shipped LOCAL_OUTPUT_CAP) bounds whatever the caller
 * asked (ruling F1); `budgets` only when a thought cap applies — without one, LlamaChat limits no segment, as today
 * (ruling F5). */
export function generationLimits(levers: Readonly<PerfLevers>, maxTokens: number | undefined): { maxTokens: number; budgets?: { thoughtTokens: number } } {
  return {
    maxTokens: Math.min(maxTokens ?? levers.outputCap, levers.outputCap),
    ...(levers.thoughtTokens === null ? {} : { budgets: { thoughtTokens: levers.thoughtTokens } }),
  };
}

/** Resolves once every generation started so far has ended, a stopped one included. Never rejects. */
export async function generationsIdle(): Promise<void> {
  while (generations.size > 0) await Promise.all([...generations]);
}

/**
 * One generation's figures (`onStats`): tokens written, and the time from the first chunk that CARRIES tokens to the
 * end. A chunk with no token — a native thought segment's start, which node-llama-cpp sends before the prompt is
 * even read — starts nothing: counting from it put the prompt reading into the rate (I1). `now` is injected for tests.
 */
export class GenerationMeter {
  readonly #now: () => number;
  #first: number | undefined;
  #tokens = 0;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  chunk(tokens: number): void {
    if (tokens > 0) this.#first ??= this.#now();
    this.#tokens += tokens;
  }

  stats(inputTokens: number): GenerationStats {
    return { inputTokens, outputTokens: this.#tokens, generationMs: this.#first === undefined ? 0 : Math.round(this.#now() - this.#first) };
  }

  /** From `startedAt` (the call's start, on the same clock) to the first chunk carrying tokens: the prompt's reading,
   * a checkpoint restore included. null when no token came. */
  promptMs(startedAt: number): number | null {
    return this.#first === undefined ? null : Math.max(0, Math.round(this.#first - startedAt));
  }
}

/**
 * `ModelProvider.complete()` (model-types.mts) for the built-in engine. `messages` is the request agent.mts built
 * (request-context.mts: attachments expanded, fitted to the budget). The answer streams to `onDelta` and the reasoning
 * apart to `onReasoning` (thought segments, or <think> tags: reasoning-split.mts); the content is the answer alone, and
 * `reasoning`/`reasoningMs` are set only when there was some. `onStats` is called once per generation, a stopped one
 * included; a stop during the load reports none, since no generation ran.
 */
export async function completeLocal(options: LocalCompletionOptions): Promise<ChatMessage & { content: string }> {
  const { chat, context, wrapper } = await engineFor(options.modelPath, options.contextRequest ?? DEFAULT_CONTEXT_REQUEST, { signal: options.signal, onLoad: options.onLoad });
  const levers = perfLevers();
  const reply = new ReplyAccumulator(undefined, { startInThought: wrapper.opensThought });
  const deliver = (pieces: SplitPiece[]) => {
    for (const piece of pieces) {
      if (piece.kind === 'text') options.onDelta?.(piece.text);
      else if (piece.kind === 'moved') options.onReasoning?.({ text: piece.text, moved: true });
      else if (piece.kind === 'movedBack') options.onReasoning?.({ text: piece.text, movedBack: true });
      else options.onReasoning?.({ text: piece.text });
    }
  };
  const { sequence } = chat;
  const meter = sequence.tokenMeter;
  const before = meter.getState();
  // What the sequence held before the call: what the new prompt may reuse (core/reuse.mts).
  const heldTokens = sequence.contextTokens;
  const generation = new GenerationMeter();
  const startedAt = performance.now();
  const history = historyFromMessages(options.messages);
  const functions = toGgufFunctions(options.tools ?? []);
  let promptCheckpoint: PromptCheckpointFigures | null = null;
  let response: Awaited<ReturnType<LlamaChat['generateResponse']>>;
  try {
    if (levers.promptCheckpoint) {
      // Outside LlamaChat's lock: a stopped generation still unwinding must be done before the sequence is touched, and
      // this evaluation is tracked like one (nothing between turns may touch the engine before it ends).
      await generationsIdle();
      promptCheckpoint = await tracked(checkpointPromptEnd(sequence, chat.chatWrapper, history, functions));
      options.signal?.throwIfAborted();
    }
    response = await tracked(chat.generateResponse(history as unknown as ChatHistoryItem[], {
      functions: functions as ChatModelFunctions | undefined,
      onResponseChunk: chunk => {
        generation.chunk(chunk.tokens.length);
        deliver(reply.chunk(chunk));
      },
      signal: options.signal,
      ...generationLimits(levers, options.maxTokens),
    }));
  } finally {
    const used = meter.diff(before);
    const stats = generation.stats(used.usedInputTokens);
    const checkpoints = sequence.needsCheckpoints
      ? { needed: true, memoryBytes: sequence.checkpointsMemoryUsage, lastIndex: sequence.lastCheckpointIndex }
      : null;
    // The meter's own output count (M1): a tool call's tokens are not all in the streamed chunks.
    const reuse = {
      ...reuseOf({ heldTokens, afterTokens: sequence.contextTokens, evaluated: used.usedInputTokens, outputTokens: used.usedOutputTokens, checkpoints }),
      // Only with the lever on: today's figures keep their shape.
      ...(levers.promptCheckpoint ? { promptCheckpoint } : {}),
    };
    // The id ties this generation's turn-log line to its `[perf]` timings in the log (the bench, M5).
    const generationId = randomUUID();
    options.onStats?.({ ...stats, promptMs: generation.promptMs(startedAt), reuse, generationId });
    if (levers.performanceTracking) {
      await context.printTimings().catch((error: unknown) => console.warn(`[perf] mesures illisibles : ${(error as Error | undefined)?.message ?? error}`));
      console.info(`[perf] génération terminée ${generationId}`);
    }
  }
  deliver(reply.end());
  const { reasoning } = reply;
  return {
    ...responseToMessage(response, mintCallId),
    content: reply.text,
    ...(reasoning ? { reasoning, reasoningMs: reply.reasoningMs ?? 0 } : {}),
  };
}

/** The built-in engine as a ModelProvider (worker.mjs `turnProvider`): its window is the context size it really
 * runs with (H3), sized from `request`; its output cap the outputCap lever (shipped LOCAL_OUTPUT_CAP, which the bench
 * may lower: ruling F1); the agent lowers the cap to what the window leaves after the request (M3) and passes it as
 * `maxTokens`. */
export function localProvider(modelPath: string, request: ContextRequest = DEFAULT_CONTEXT_REQUEST): ModelProvider {
  return {
    complete: (options: Omit<LocalCompletionOptions, 'modelPath' | 'contextRequest'>) => completeLocal({
      modelPath, messages: options.messages, tools: options.tools, signal: options.signal, onDelta: options.onDelta,
      onReasoning: options.onReasoning, onStats: options.onStats, maxTokens: options.maxTokens,
      contextRequest: request,
    }),
    contextWindow: (options?: WindowOptions) => engineContextSize(modelPath, request, options),
    outputCap: (): number | undefined => perfLevers().outputCap,
  };
}
