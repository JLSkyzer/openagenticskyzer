// The model engine: with core/llama-runtime.mts and core/offload-estimate.mts, one of the modules that import node-llama-cpp, a native binding loaded only
// ("réveiller le modèle sélectionné"), never at module load time. Bridges to `local-provider.mts`'s pure
// mappers, so the agent loop (agent.mts) keeps its OpenAI-shaped messages (model-types.mts).
// The Llama belongs to llama-runtime.mts (one per worker). That module and this one import each other, so neither
// uses the other's exports at module load time: only inside functions.
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import { LlamaChat, InsufficientMemoryError, readGgufFileInfo, GgufInsights, type Llama, type LlamaModel, type LlamaContext } from 'node-llama-cpp';
import { historyFromMessages, responseToMessage, toGgufFunctions } from './local-provider.mts';
import type { ChatMessage, ModelProvider, ToolSchema } from './model-types.mts';
import { localContextSize, DEFAULT_LOCAL_CONTEXT, type LocalContextSetting } from './context-budget.mts';
import { runtimeLlama, runtimeGeneration, backendOf } from './llama-runtime.mts';
import { fitOf, type Placement } from './placement.mts';

/** What the engine context is sized from: the « Contexte des modèles locaux » setting. max_tokens takes no part
 * (ruling F6): it caps the request window only (context-budget.mts::effectiveWindow). */
export interface ContextRequest { setting: LocalContextSetting }
export const DEFAULT_CONTEXT_REQUEST: ContextRequest = { setting: DEFAULT_LOCAL_CONTEXT };

export interface LocalCompletionOptions {
  modelPath: string;
  messages: readonly ChatMessage[];
  tools?: readonly ToolSchema[];
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
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
}
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
// which would leak a model or free a context the other just created.
let lock: Promise<unknown> = Promise.resolve();
function serial<T>(run: () => Promise<T>): Promise<T> {
  const result = lock.then(run);
  lock = result.catch(() => undefined);
  return result;
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
 * allocated, unlike the V2 simulation.
 */
async function assertContextCanFit(llama: Llama, modelPath: string, contextSize: number): Promise<void> {
  const insights = await GgufInsights.from(await readGgufFileInfo(modelPath), llama);
  if ((await contextOverflow(llama, insights, contextSize)) !== null) throw new Error(localModelTooBig(contextSize));
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

/** The one line a load logs (I-1): where its layers went, against which free VRAM and padding. */
export function placementLogLine(p: { backend: string; gpuLayers: number; totalLayers: number; useMmap: boolean; vramBefore: { total: number; used: number; free: number } | null; padding: number; contextSize: number }): string {
  const before = p.vramBefore ? `libre ${mib(p.vramBefore.free)} / total ${mib(p.vramBefore.total)} (utilisée ${mib(p.vramBefore.used)})` : 'illisible';
  return `[placement] backend ${p.backend} · couches ${p.gpuLayers}/${p.totalLayers} sur la carte · mmap ${p.useMmap ? 'oui' : 'non'} · VRAM avant chargement : ${before} · marge VRAM ${mib(p.padding)} · contexte ${p.contextSize}`;
}

/**
 * Loads `modelPath` with exactly `contextSize` tokens of context, its layers placed by node-llama-cpp for THAT
 * context (`gpuLayers: { fitContext }`), and keeps it warm. The warm engine is reused only for the same path, the
 * same requested size and the same runtime Llama; anything else reloads. When the machine cannot hold it even with
 * no layer on the card, nothing stays loaded and the error is localModelTooBig(contextSize).
 */
export async function loadLocalModel(modelPath: string, contextSize: number): Promise<Placement> {
  // The placement is read inside the lock: a load queued behind this one may dispose this context.
  return serial(async () => placementOf(await loadLocked(modelPath, contextSize)));
}

async function loadLocked(modelPath: string, contextSize: number): Promise<Loaded> {
  if (loaded && loaded.path === modelPath && loaded.requested === contextSize && loaded.generation === runtimeGeneration()) return loaded;
  await disposeLocked();
  const llama = await runtimeLlama();
  const generation = runtimeGeneration();
  await assertContextCanFit(llama, modelPath, contextSize);
  const vramBefore = await llama.getVramState().catch(() => null);
  let model: LlamaModel | null = null;
  try {
    nativeLoads += 1;
    model = await llama.loadModel({ modelPath, gpuLayers: { fitContext: { contextSize } } });
    liveModels += 1;
    // A fixed size: no silent shrink on failure (node-llama-cpp only retries an 'auto' size, said here anyway).
    const context = await model.createContext({ contextSize, failedCreationRemedy: false });
    loaded = { path: modelPath, requested: contextSize, generation, llama, model, context, chat: new LlamaChat({ contextSequence: context.getSequence() }) };
    console.info(placementLogLine({ backend: backendOf(llama), gpuLayers: model.gpuLayers, totalLayers: model.fileInsights.totalLayers, useMmap: model.useMmap, vramBefore, padding: llama.vramPaddingSize, contextSize: context.contextSize }));
    return loaded;
  } catch (error) {
    if (model) await disposeModel(model);
    if (error instanceof InsufficientMemoryError) throw new Error(localModelTooBig(contextSize));
    throw error;
  }
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
async function engineFor(modelPath: string, request: ContextRequest): Promise<Loaded> {
  const contextSize = await plannedContextSize(modelPath, request);
  return serial(() => loadLocked(modelPath, contextSize));
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
export async function engineContextSize(modelPath: string, request: ContextRequest = DEFAULT_CONTEXT_REQUEST): Promise<number> {
  return (await engineFor(modelPath, request)).context.contextSize;
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

/** `ModelProvider.complete()` (model-types.mts) for the built-in engine. `messages` is the request agent.mts built (request-context.mts: attachments expanded, fitted to the budget). */
export async function completeLocal(options: LocalCompletionOptions): Promise<ChatMessage & { content: string }> {
  const { chat } = await engineFor(options.modelPath, options.contextRequest ?? DEFAULT_CONTEXT_REQUEST);
  const response = await chat.generateResponse(historyFromMessages(options.messages), {
    functions: toGgufFunctions(options.tools ?? []),
    onTextChunk: options.onDelta,
    signal: options.signal,
    maxTokens: options.maxTokens ?? LOCAL_OUTPUT_CAP,
  });
  return responseToMessage(response, mintCallId);
}

/** The built-in engine as a ModelProvider (worker.mjs `turnProvider`): its window is the context size it really
 * runs with (H3), sized from `request`; its output cap LOCAL_OUTPUT_CAP; the agent lowers the cap to what the
 * window leaves after the request (M3) and passes it as `maxTokens`. */
export function localProvider(modelPath: string, request: ContextRequest = DEFAULT_CONTEXT_REQUEST): ModelProvider {
  return {
    complete: (options: Omit<LocalCompletionOptions, 'modelPath' | 'contextRequest'>) => completeLocal({
      modelPath, messages: options.messages, tools: options.tools, signal: options.signal, onDelta: options.onDelta, maxTokens: options.maxTokens,
      contextRequest: request,
    }),
    contextWindow: () => engineContextSize(modelPath, request),
    outputCap: (): number | undefined => LOCAL_OUTPUT_CAP,
  };
}
