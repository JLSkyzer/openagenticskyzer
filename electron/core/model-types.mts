// The message and tool shapes every model engine speaks (the agent loop, compaction, the local engine). Types only:
// no model client lives here.

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
/** `opensThought`: the chat template opens <think> in the generation prompt (core/thought-prefill.mts). */
export interface ChatWrapperInfo { name: string; segments: unknown; opensThought: boolean }
/** A model load as it happens: started, progress in (0, 1], ended (its time and chat wrapper). Only a real load
 * reports: a reused warm engine reports nothing. */
export type LoadEvent = { kind: 'start' } | { kind: 'progress'; progress: number } | { kind: 'end'; ms: number; wrapper: ChatWrapperInfo };
/** One generation's figures: tokens read (the prompt, as evaluated), tokens written, and the time from the first
 * chunk to the end. Reported once, a stopped generation included. */
export interface GenerationStats { inputTokens: number; outputTokens: number; generationMs: number }
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
}
/** What the agent loop and compaction need from a model: the built-in engine (local-engine.mts::localProvider). */
export interface ModelProvider {
  complete(options: CompletionOptions): Promise<ChatMessage & { content: string }>;
  /** The context window the requests are sized against, in tokens. It may load the model: `options` stops and
   * follows that load. */
  contextWindow(options?: WindowOptions): Promise<number>;
  /** The output cap applied when no maxTokens is passed; undefined = none. */
  outputCap(): number | undefined;
}
