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

// "Réveiller" = load once, on the first real message, and keep it warm across turns while the same file
// stays selected — a fresh `LlamaChat` still gets the FULL history every call (it keeps no memory of its
// own between generateResponse() calls), so re-using the same instance is purely a cost optimisation, not
// a correctness requirement.
async function engineFor(modelPath: string): Promise<LlamaChat> {
  if (loaded?.path === modelPath) return loaded.chat;
  await disposeEngine();
  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext();
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

let mintedIds = 0;

/** Same contract as `ChatProvider.complete()` (provider.mts): agent.mts calls this without knowing the
 * difference. `messages` already has attachments expanded (agent.mts runs toWireMessage first). */
export async function completeLocal(options: LocalCompletionOptions): Promise<ChatMessage & { content: string }> {
  const chat = await engineFor(options.modelPath);
  const response = await chat.generateResponse(historyFromMessages(options.messages), {
    functions: toGgufFunctions(options.tools ?? []),
    onTextChunk: options.onDelta,
    signal: options.signal,
    maxTokens: options.maxTokens,
  });
  return responseToMessage(response, () => `local-${++mintedIds}`);
}
