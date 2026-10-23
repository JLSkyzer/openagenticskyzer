// The model engine: with core/llama-runtime.mts, core/offload-estimate.mts and core/thought-prefill.mts, one of the modules that import node-llama-cpp, a native binding loaded only
// ("réveiller le modèle sélectionné"), never at module load time. Bridges to `local-provider.mts`'s pure
// mappers, so the agent loop (agent.mts) keeps its OpenAI-shaped messages (model-types.mts).
// The Llama belongs to llama-runtime.mts (one per worker). That module and this one import each other, so neither
// uses the other's exports at module load time: only inside functions.
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import { LlamaChat, JinjaTemplateChatWrapper, InsufficientMemoryError, readGgufFileInfo, GgufInsights, GgmlType, type Llama, type LlamaModel, type LlamaContext } from 'node-llama-cpp';
import { historyFromMessages, responseToMessage, toGgufFunctions } from './local-provider.mts';
import type { ChatMessage, ChatWrapperInfo, CompletionOptions, GenerationStats, ModelProvider, ToolSchema, WindowOptions } from './model-types.mts';
import { localContextSize, DEFAULT_LOCAL_CONTEXT, type LocalContextSetting } from './context-budget.mts';
import { runtimeLlama, runtimeGeneration, backendOf } from './llama-runtime.mts';
import { fitOf, type Placement } from './placement.mts';
import { untilAborted } from './abortable.mts';
import { ReplyAccumulator, type SplitPiece } from './reasoning-split.mts';
import { opensThought, type ThoughtSegment } from './thought-prefill.mts';

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
export type LoadOutcome =
  | { kind: 'direct' }
  | { kind: 'step-down'; refused: number[] }
  | { kind: 'fallback'; cause: 'loadModel' | 'createContext'; refused: number[] };
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
  if (!outcome || outcome.kind === 'direct') return '';
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

async function loadFresh(modelPath: string, contextSize: number, { signal, onLoad }: EngineOptions): Promise<Loaded> {
  const startedAt = performance.now();
  onLoad?.({ kind: 'start' });
  const onLoadProgress = (progress: number) => onLoad?.({ kind: 'progress', progress });
  await disposeLocked();
  const llama = await runtimeLlama();
  const generation = runtimeGeneration();
  const insights = await assertContextCanFit(llama, modelPath, contextSize);
  const vramBefore = await llama.getVramState().catch(() => null);
  const kept = (model: LlamaModel, context: LlamaContext, outcome: LoadOutcome) =>
    keep({ modelPath, contextSize, generation, llama, model, context, vramBefore, outcome, startedAt, onLoad });
  // The layer counts createContext refused, in order, and the cap of the next fitContext load (none at first).
  const refused: number[] = [];
  let max: number | null = null;
  let cause: 'loadModel' | 'createContext' = 'createContext';
  for (;;) {
    let model: LlamaModel;
    try {
      nativeLoads += 1;
      // fitContext places as many layers as node-llama-cpp thinks fit with this context; after a refusal, at most `max`.
      const gpuLayers = max === null ? { fitContext: { contextSize } } : { min: 0, max, fitContext: { contextSize } };
      model = await llama.loadModel({ modelPath, gpuLayers, loadSignal: signal, onLoadProgress });
      liveModels += 1;
    } catch (error) {
      if (!(error instanceof InsufficientMemoryError)) throw error;
      // node-llama-cpp's resolver: the card cannot take even 0 layers with this context (a game holding the VRAM).
      memoryWarning('loadModel', max === null ? 'fitContext' : `fitContext ≤ ${max}`, error);
      cause = 'loadModel';
      break;
    }
    try {
      // A fixed size: no silent shrink on failure (node-llama-cpp only retries an 'auto' size, said here anyway).
      const context = await model.createContext({ contextSize, failedCreationRemedy: false, createSignal: signal });
      return kept(model, context, refused.length ? { kind: 'step-down', refused: [...refused] } : { kind: 'direct' });
    } catch (error) {
      const layers = model.gpuLayers;
      await disposeModel(model);
      if (!(error instanceof InsufficientMemoryError)) throw error;
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
  const model = await llama.loadModel({ modelPath, gpuLayers: 0, useMmap, ignoreMemorySafetyChecks: true, loadSignal: signal, onLoadProgress });
  liveModels += 1;
  let context: LlamaContext;
  try {
    context = await model.createContext({ contextSize, failedCreationRemedy: false, ignoreMemorySafetyChecks: true, createSignal: signal });
  } catch (error) {
    // Even 0 layers keeps a compute buffer on the card: an allocation the full card refuses ends here.
    await disposeModel(model);
    if (signal?.aborted) throw signal.reason;
    console.warn(`[placement] repli processeur : le contexte n'a pas pu être créé : ${(error as Error | undefined)?.message ?? error}`);
    throw new Error(localModelTooBig(contextSize));
  }
  return kept(model, context, outcome);
}

function keep(p: { modelPath: string; contextSize: number; generation: number; llama: Llama; model: LlamaModel; context: LlamaContext; vramBefore: VramState | null; outcome: LoadOutcome; startedAt: number; onLoad?: EngineOptions['onLoad'] }): Loaded {
  const { llama, model, context } = p;
  const chat = new LlamaChat({ contextSequence: context.getSequence() });
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
  p.onLoad?.({ kind: 'end', ms: Math.round(performance.now() - p.startedAt), wrapper });
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
}

/**
 * `ModelProvider.complete()` (model-types.mts) for the built-in engine. `messages` is the request agent.mts built
 * (request-context.mts: attachments expanded, fitted to the budget). The answer streams to `onDelta` and the reasoning
 * apart to `onReasoning` (thought segments, or <think> tags: reasoning-split.mts); the content is the answer alone, and
 * `reasoning`/`reasoningMs` are set only when there was some. `onStats` is called once per generation, a stopped one
 * included; a stop during the load reports none, since no generation ran.
 */
export async function completeLocal(options: LocalCompletionOptions): Promise<ChatMessage & { content: string }> {
  const { chat, wrapper } = await engineFor(options.modelPath, options.contextRequest ?? DEFAULT_CONTEXT_REQUEST, { signal: options.signal });
  const reply = new ReplyAccumulator(undefined, { startInThought: wrapper.opensThought });
  const deliver = (pieces: SplitPiece[]) => {
    for (const piece of pieces) {
      if (piece.kind === 'text') options.onDelta?.(piece.text);
      else if (piece.kind === 'moved') options.onReasoning?.({ text: piece.text, moved: true });
      else if (piece.kind === 'movedBack') options.onReasoning?.({ text: piece.text, movedBack: true });
      else options.onReasoning?.({ text: piece.text });
    }
  };
  const meter = chat.sequence.tokenMeter;
  const before = meter.getState();
  const generation = new GenerationMeter();
  let response: Awaited<ReturnType<LlamaChat['generateResponse']>>;
  try {
    response = await chat.generateResponse(historyFromMessages(options.messages), {
      functions: toGgufFunctions(options.tools ?? []),
      onResponseChunk: chunk => {
        generation.chunk(chunk.tokens.length);
        deliver(reply.chunk(chunk));
      },
      signal: options.signal,
      maxTokens: options.maxTokens ?? LOCAL_OUTPUT_CAP,
    });
  } finally {
    options.onStats?.(generation.stats(meter.diff(before).usedInputTokens));
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
 * runs with (H3), sized from `request`; its output cap LOCAL_OUTPUT_CAP; the agent lowers the cap to what the
 * window leaves after the request (M3) and passes it as `maxTokens`. */
export function localProvider(modelPath: string, request: ContextRequest = DEFAULT_CONTEXT_REQUEST): ModelProvider {
  return {
    complete: (options: Omit<LocalCompletionOptions, 'modelPath' | 'contextRequest'>) => completeLocal({
      modelPath, messages: options.messages, tools: options.tools, signal: options.signal, onDelta: options.onDelta,
      onReasoning: options.onReasoning, onStats: options.onStats, maxTokens: options.maxTokens,
      contextRequest: request,
    }),
    contextWindow: (options?: WindowOptions) => engineContextSize(modelPath, request, options),
    outputCap: (): number | undefined => LOCAL_OUTPUT_CAP,
  };
}
