// The ONLY module that imports node-llama-cpp: a native binding, loaded only on first actual use
// ("réveiller le modèle sélectionné"), never at module load time. Bridges to `local-provider.mts`'s pure
// mappers so the OpenAI-shaped agent loop (agent.mts, unchanged) never knows this isn't a real HTTP provider.
import { getLlama, LlamaChat } from 'node-llama-cpp';
import { historyFromMessages, responseToMessage, toGgufFunctions } from './local-provider.mts';
import type { ChatMessage, ToolSchema } from './provider.mts';

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
// small GPU's VRAM.
const MIN_CONTEXT = 16384;
function contextSizeFor(trainContextSize: number | undefined): number | undefined {
  return trainContextSize === undefined || trainContextSize >= MIN_CONTEXT ? undefined : MIN_CONTEXT;
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

/** Frees whatever local model is currently loaded (switching to another model, local or remote, or the app
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
 * request budget is computed from for the built-in engine, instead of a remote provider's table entry. */
export async function engineContextSize(modelPath: string): Promise<number> {
  await engineFor(modelPath);
  if (!loaded) throw new Error('Modèle local non chargé');
  return loaded.context.contextSize;
}

let mintedIds = 0;

// A real HTTP provider's own server enforces some sane generation limit even when we don't ask for one
// — here WE are the server, and node-llama-cpp will happily generate until end-of-sequence or the context
// is full if left unbounded, which on a model that rarely emits a natural stop token means an effectively
// hung turn. The cap is the one Python gave the local HTTP servers (lmstudio, llamacpp:
// provider.mts::OUTPUT_CAPS); a reply that reaches it is flagged truncated, like finish_reason "length".
export const LOCAL_OUTPUT_CAP = 8192;

/** Same contract as `ChatProvider.complete()` (provider.mts): agent.mts calls this without knowing the
 * difference. `messages` is the request agent.mts built (request-context.mts: attachments expanded, fitted to the budget). */
export async function completeLocal(options: LocalCompletionOptions): Promise<ChatMessage & { content: string }> {
  const chat = await engineFor(options.modelPath);
  const response = await chat.generateResponse(historyFromMessages(options.messages), {
    functions: toGgufFunctions(options.tools ?? []),
    onTextChunk: options.onDelta,
    signal: options.signal,
    maxTokens: options.maxTokens ?? LOCAL_OUTPUT_CAP,
  });
  return responseToMessage(response, () => `local-${++mintedIds}`);
}
