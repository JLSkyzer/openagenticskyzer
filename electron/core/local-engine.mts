// The ONLY module that imports node-llama-cpp: a native binding, loaded only on first actual use
// ("réveiller le modèle sélectionné"), never at module load time. Bridges to `local-provider.mts`'s pure
// mappers, so the agent loop (agent.mts) keeps its OpenAI-shaped messages (model-types.mts).
import { randomUUID } from 'node:crypto';
import { getLlama, LlamaChat } from 'node-llama-cpp';
import { historyFromMessages, responseToMessage, toGgufFunctions } from './local-provider.mts';
import type { ChatMessage, ModelProvider, ToolSchema } from './model-types.mts';
import { MIN_LOCAL_CONTEXT } from './context-budget.mts';

export interface LocalCompletionOptions {
  modelPath: string;
  messages: readonly ChatMessage[];
  tools?: readonly ToolSchema[];
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  maxTokens?: number;
}

interface Loaded {
  path: string;
  llama: Awaited<ReturnType<typeof getLlama>>;
  model: Awaited<ReturnType<Awaited<ReturnType<typeof getLlama>>['loadModel']>>;
  context: Awaited<ReturnType<Loaded['model']['createContext']>>;
  chat: LlamaChat;
}
let loaded: Loaded | null = null;

// Our real system prompt (buildInstructions(): full tool descriptions + project context) can run well past a
// small model's own trained context (measured: over 2048 tokens against a model trained for exactly 2048).
// node-llama-cpp allows requesting more than `trainContextSize` — positions beyond it degrade in quality (RoPE
// extrapolation) rather than erroring, which is the right tradeoff for a local-first provider: degraded output
// beats a hard refusal. Floored at 4096 for a small model, left at the model's own choice (`undefined`) once
// it is already at least that — never lowered, and never pushed past a firm ceiling that could exhaust a
// small GPU's VRAM. The floor is MIN_LOCAL_CONTEXT (context-budget.mts), the window modelStatus assumes before a load.
function contextSizeFor(trainContextSize: number | undefined): number | undefined {
  return trainContextSize === undefined || trainContextSize >= MIN_LOCAL_CONTEXT ? undefined : MIN_LOCAL_CONTEXT;
}

// "Réveiller" = load once, on the first real message, and keep it warm across turns while the same file
// stays selected — a fresh `LlamaChat` still gets the FULL history every call (it keeps no memory of its
// own between generateResponse() calls), so re-using the same instance is purely a cost optimisation, not
// a correctness requirement.
async function engineFor(modelPath: string): Promise<LlamaChat> {
  if (loaded?.path === modelPath) return loaded.chat;
  await disposeEngine();
  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext({ contextSize: contextSizeFor(model.trainContextSize) });
  const chat = new LlamaChat({ contextSequence: context.getSequence() });
  loaded = { path: modelPath, llama, model, context, chat };
  return chat;
}

/** Frees whatever local model is currently loaded (switching to another model, or the app
 * shutting down) — a GGUF model can hold several gigabytes of RAM/VRAM, so this is never left to the GC. */
export async function disposeEngine(): Promise<void> {
  if (!loaded) return;
  const { context, model, llama } = loaded;
  loaded = null;
  await context.dispose();
  await model.dispose();
  await llama.dispose();
}

/** For tests: which path (if any) is currently kept warm, without touching it. */
export function warmModelPath(): string | null {
  return loaded?.path ?? null;
}

/** Loads `modelPath` if needed and returns the context size the engine really runs with: the window the
 * request budget is computed from. */
export async function engineContextSize(modelPath: string): Promise<number> {
  await engineFor(modelPath);
  if (!loaded) throw new Error('Modèle local non chargé');
  return loaded.context.contextSize;
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
  const chat = await engineFor(options.modelPath);
  const response = await chat.generateResponse(historyFromMessages(options.messages), {
    functions: toGgufFunctions(options.tools ?? []),
    onTextChunk: options.onDelta,
    signal: options.signal,
    maxTokens: options.maxTokens ?? LOCAL_OUTPUT_CAP,
  });
  return responseToMessage(response, mintCallId);
}

/** The built-in engine as a ModelProvider (worker.mjs `turnProvider`): its window is the context size it really
 * runs with (H3), its output cap LOCAL_OUTPUT_CAP; the agent lowers the cap to what the window leaves after the
 * request (M3) and passes it as `maxTokens`. */
export function localProvider(modelPath: string): ModelProvider {
  return {
    complete: (options: Omit<LocalCompletionOptions, 'modelPath'>) => completeLocal({
      modelPath, messages: options.messages, tools: options.tools, signal: options.signal, onDelta: options.onDelta, maxTokens: options.maxTokens,
    }),
    contextWindow: () => engineContextSize(modelPath),
    outputCap: (): number | undefined => LOCAL_OUTPUT_CAP,
  };
}
