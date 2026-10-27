// The message and tool shapes every model engine speaks (the agent loop, compaction, the local engine). Types only:
// no model client lives here.
import type { ReuseFigures } from './reuse.mts';

export interface ToolCall {
  id: string; type: 'function'; function: { name: string; arguments: string };
  extra_content?: unknown;
}
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'; content: string | unknown[] | null;
  tool_call_id?: string; tool_calls?: ToolCall[]; reasoning_details?: unknown[];
  // A user message's files, kept beside what was typed (see attachments.mts). Never sent as such: they are
  // expanded into `content` (toWireMessage) just before the model is called.
  attachments?: unknown[];
  // Set on a reply the output limit cut (finish_reason "length", or the local engine's stopReason "maxTokens").
  // agent.mts turns it into a visible notice; the flag itself is never stored nor sent back to a model.
  truncated?: boolean;
  // A tool result's tool name and category (agent.mts), saved so a reopened conversation shows the same card. Never
  // sent: request-context.mts sends a tool result as role, tool_call_id and content only.
  name?: string; category?: string;
  // A reply's reasoning (core/reasoning-split.mts), how long it took, and the turn's figures: saved for the screen,
  // never sent to a model (request-context.mts keeps them out of every request).
  reasoning?: string; reasoningMs?: number; timing?: TurnTiming;
}
/** A turn's figures, in ms: load, reading the request, first word of the answer, whole turn; output tokens and rate. */
export interface TurnTiming { loadMs?: number; readMs?: number; firstTextMs?: number; totalMs: number; outputTokens?: number; tokensPerSecond?: number }
/** The chat wrapper node-llama-cpp chose for a loaded model: its name and its segments (thought tags), as logged. */
/** `opensThought`: the chat template opens <think> in the generation prompt (core/thought-prefill.mts).
 * `toolsAfterSystem`: it renders the tools after the system text, before the first message (core/prompt-layout.mts),
 * so the project context can follow the tool block (the contextPlacement lever).
 * `thoughtKept`: where a thought sent back is rendered where the model wrote it (the keepThought lever). */
export interface ChatWrapperInfo { name: string; segments: unknown; opensThought: boolean; toolsAfterSystem: boolean; thoughtKept: { previousTurn: boolean; currentTurn: boolean } }
/** A model load as it happens: started, progress in (0, 1], ended (its time and chat wrapper). Only a real load
 * reports: a reused warm engine reports nothing. `retry`: a second native load begins, its progress starting again
 * from 0 — with fewer layers on the card (`fewer-layers`, the context did not fit) or on the processor (`cpu`). */
export type LoadEvent = { kind: 'start' } | { kind: 'progress'; progress: number } | { kind: 'retry'; mode: LoadRetry }
  | { kind: 'end'; ms: number; wrapper: ChatWrapperInfo; stages: LoadStage[]; architecture: ModelArchitecture };
/** One timed stage of a real load, in order: the runtime (`engine`), the pre-checks, one `loadModel` and one
 * `createContext` per attempt (`ok: false`: refused for memory; `gpuLayers`: what a loaded model put on the card),
 * the chat. */
export interface LoadStage { stage: 'engine' | 'precheck' | 'loadModel' | 'createContext' | 'chat'; ms: number; ok: boolean; gpuLayers?: number }
/** What the model file says of its architecture (GgufInsights): hybrid or recurrent layers, a sliding window, MTP. */
export interface ModelArchitecture { hybrid: boolean; recurrent: boolean; swaSize: number | null; mtpWeights: boolean }
export type LoadRetry = 'fewer-layers' | 'cpu';
/** One generation's figures: tokens read (the prompt, as evaluated), tokens written, and the time from the first
 * chunk to the end. Reported once, a stopped generation included. `promptMs`: from the call's start to the first chunk
 * carrying tokens (null when none came); `reuse`: what the engine did not read again (core/reuse.mts);
 * `generationId`: this generation's id, on its `[perf]` marker too (the bench aligns timings by it); `predictions`: the
 * sequence's token predictions over this call, only when it has a predictor (the inputLookup lever, Task 10). */
export interface GenerationStats { inputTokens: number; outputTokens: number; generationMs: number; promptMs?: number | null; reuse?: ReuseFigures; generationId?: string; predictions?: TokenPredictions }
/** node-llama-cpp's `LlamaContextSequence.tokenPredictions` over one call: drafted tokens the model confirmed
 * (`validated`) or rejected (`refuted`), and of the confirmed ones those the generation consumed (`used`) or not. */
export interface TokenPredictions { validated: number; refuted: number; used: number; unused: number }
/** What getting the window may involve: a load, which `signal` stops and `onLoad` follows. */
export interface WindowOptions { signal?: AbortSignal; onLoad?: (event: LoadEvent) => void }
export interface ToolSchema { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface CompletionOptions {
  messages: ChatMessage[]; tools?: ToolSchema[]; signal?: AbortSignal; onDelta?: (text: string) => void;
  // The output asked for; the engine's own cap (outputCap) when absent.
  maxTokens?: number;
  // The reasoning as it streams, apart from the answer; `moved: true` takes back everything onDelta sent so far
  // (a bare </think>, core/reasoning-split.mts); `movedBack: true` is the reverse: all the reasoning sent so far was
  // the answer, `text` (the template opened <think> and no </think> came).
  onReasoning?: (piece: { text: string; moved?: true; movedBack?: true }) => void;
  onStats?: (stats: GenerationStats) => void;
  // The project's context (instructions, memory, learnings: context.mts) apart from the system message, which then
  // holds the base alone. Passed only to a provider that declares `rendersProjectContext` (agent.mts).
  projectContext?: string;
}
/** What the agent loop and compaction need from a model: the built-in engine (local-engine.mts::localProvider). */
export interface ModelProvider {
  complete(options: CompletionOptions): Promise<ChatMessage & { content: string }>;
  /** The context window the requests are sized against, in tokens. It may load the model: `options` stops and
   * follows that load. */
  contextWindow(options?: WindowOptions): Promise<number>;
  /** The output cap applied when no maxTokens is passed; undefined = none. */
  outputCap(): number | undefined;
  /** It places `projectContext` itself (the local engine). Otherwise the agent folds the context back into the system
   * message, as before (ruling F7). */
  rendersProjectContext?: boolean;
}
