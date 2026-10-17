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
}
export interface ToolSchema { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface CompletionOptions {
  messages: ChatMessage[]; tools?: ToolSchema[]; signal?: AbortSignal; onDelta?: (text: string) => void;
  // The output asked for; the engine's own cap (outputCap) when absent.
  maxTokens?: number;
}
/** What the agent loop and compaction need from a model: the built-in engine (local-engine.mts::localProvider). */
export interface ModelProvider {
  complete(options: CompletionOptions): Promise<ChatMessage & { content: string }>;
  /** The context window the requests are sized against, in tokens. */
  contextWindow(): Promise<number>;
  /** The output cap applied when no maxTokens is passed; undefined = none. */
  outputCap(): number | undefined;
}
