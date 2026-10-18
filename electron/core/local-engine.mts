// The model engine: with core/llama-runtime.mts, one of the two modules that import node-llama-cpp, a native binding loaded only
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
  // No Llama passed: node-llama-cpp reads the header without a backend, so this never creates the runtime.
  const train = (await GgufInsights.from(await readGgufFileInfo(modelPath))).trainContextSize;
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

/**
 * Loads `modelPath` with exactly `contextSize` tokens of context, its layers placed by node-llama-cpp for THAT
 * context (`gpuLayers: { fitContext }`), and keeps it warm. The warm engine is reused only for the same path, the
 * same requested size and the same runtime Llama; anything else reloads. When the machine cannot hold it even with
 * no layer on the card, nothing stays loaded and the error is localModelTooBig(contextSize).
 */
export async function loadLocalModel(modelPath: string, contextSize: number): Promise<Placement> {
  if (loaded && loaded.path === modelPath && loaded.requested === contextSize && loaded.generation === runtimeGeneration()) return placementOf(loaded);
  await disposeEngine();
  const llama = await runtimeLlama();
  const generation = runtimeGeneration();
  let model: LlamaModel | null = null;
  try {
    model = await llama.loadModel({ modelPath, gpuLayers: { fitContext: { contextSize } } });
    // A fixed size: no silent shrink on failure (node-llama-cpp only retries an 'auto' size, said here anyway).
    const context = await model.createContext({ contextSize, failedCreationRemedy: false });
    loaded = { path: modelPath, requested: contextSize, generation, llama, model, context, chat: new LlamaChat({ contextSequence: context.getSequence() }) };
    return placementOf(loaded);
  } catch (error) {
    if (model && !model.disposed) await model.dispose();
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
  await loadLocalModel(modelPath, await plannedContextSize(modelPath, request));
  if (!loaded) throw new Error('Modèle local non chargé');
  return loaded;
}

/** Frees whatever local model is currently loaded (switching to another model or context size, or the app shutting
 * down) — a GGUF model can hold several gigabytes of RAM/VRAM, so this is never left to the GC. The Llama itself is
 * not disposed here: llama-runtime.mts owns it. */
export async function disposeEngine(): Promise<void> {
  if (!loaded) return;
  const { context, model } = loaded;
  loaded = null;
  await context.dispose();
  await model.dispose();
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
