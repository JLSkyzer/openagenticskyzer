// Pure mapping between our OpenAI-shaped agent messages (provider.mts::ChatMessage/ToolSchema) and
// node-llama-cpp's own chat types (ChatHistoryItem, ChatModelFunctions, LlamaChatResponse). Deliberately
// has NO import of node-llama-cpp itself — that native binding lives in local-engine.mts, loaded only on
// first actual use — so every function here is fast and testable with plain fixtures, exactly like
// pdf-text.ts/pdf-loader.ts. `LlamaChat.generateResponse(history, options)` takes the FULL history on
// every call (no session state kept between turns), which matches agent.mts's own stateless loop exactly:
// it rebuilds `messages` fresh every iteration, so there is no session to keep in sync.
import type { ChatMessage, ToolCall, ToolSchema } from './provider.mts';

// ── node-llama-cpp's own shapes, declared locally (structural — no runtime import) ──────────────────────
export interface GgufFunctionSpec { description?: string; params?: unknown }
export type GgufFunctions = Record<string, GgufFunctionSpec>;
export type GgufHistoryItem =
  | { type: 'system'; text: string }
  | { type: 'user'; text: string }
  | { type: 'model'; response: Array<string | GgufFunctionCall> };
export interface GgufFunctionCall { type: 'functionCall'; name: string; params: unknown; result?: unknown }
export interface GgufResponse {
  response: string;
  functionCalls?: readonly { functionName: string; params: unknown }[];
  // node-llama-cpp 3.x: why generation stopped ("maxTokens" = the output cap was reached).
  metadata?: { stopReason?: string };
}

/** OpenAI tool schemas → node-llama-cpp's `functions` option. `undefined` (not `{}`) when there are none:
 * an empty object still turns function-calling grammar ON with nothing to call. */
export function toGgufFunctions(tools: readonly ToolSchema[]): GgufFunctions | undefined {
  if (tools.length === 0) return undefined;
  const functions: GgufFunctions = {};
  for (const tool of tools) functions[tool.function.name] = { description: tool.function.description, params: tool.function.parameters };
  return functions;
}

function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  // A local GGUF text model cannot see an attached image: noted plainly instead of silently vanishing.
  const images = content.filter((part): part is { type: 'image_url' } => (part as { type?: string })?.type === 'image_url').length;
  const text = content.filter((part): part is { type: 'text'; text: string } => (part as { type?: string })?.type === 'text').map(part => part.text).join('\n\n');
  return images ? `[${images} image${images > 1 ? 's' : ''} ignorée${images > 1 ? 's' : ''} — non prise en charge par un modèle local]\n\n${text}` : text;
}
const isUser = (role: string) => role === 'user' || role === 'human';
const isAssistant = (role: string) => role === 'assistant' || role === 'ai';

/**
 * Our flat `messages` array (system, user, assistant-with-tool_calls, tool-with-result, …) → node-llama-cpp's
 * history. A tool-role message is never its own item: it is folded INTO the `functionCall` it answers
 * (matched by id), because node-llama-cpp keeps a call and its result together on the model's own turn.
 */
export function historyFromMessages(messages: readonly ChatMessage[]): GgufHistoryItem[] {
  const resultsByCallId = new Map<string, string>();
  for (const message of messages) if (message.role === 'tool' && message.tool_call_id) resultsByCallId.set(message.tool_call_id, message.content);
  const history: GgufHistoryItem[] = [];
  for (const message of messages) {
    if (message.role === 'system') history.push({ type: 'system', text: textOf(message.content) });
    else if (isUser(message.role)) history.push({ type: 'user', text: textOf(message.content) });
    else if (isAssistant(message.role)) {
      const response: Array<string | GgufFunctionCall> = [];
      const text = textOf(message.content);
      if (text) response.push(text);
      for (const call of message.tool_calls ?? []) {
        const item: GgufFunctionCall = { type: 'functionCall', name: call.function.name, params: JSON.parse(call.function.arguments) };
        if (resultsByCallId.has(call.id)) item.result = resultsByCallId.get(call.id);
        response.push(item);
      }
      history.push({ type: 'model', response });
    }
    // 'tool' messages are consumed above, not appended on their own.
  }
  return history;
}

/** node-llama-cpp's response → our ChatMessage, in the exact shape `ChatProvider.complete()` returns: no
 * `tool_calls` key at all when there are none. `mintId` supplies a fresh, unique id per call (node-llama-cpp
 * does not generate one) — the SAME id then correlates the later 'tool' role message back to this call. */
export function responseToMessage(response: GgufResponse, mintId: () => string): ChatMessage & { content: string } {
  const tool_calls: ToolCall[] = (response.functionCalls ?? []).map(call => ({
    id: mintId(), type: 'function', function: { name: call.functionName, arguments: JSON.stringify(call.params) },
  }));
  // The engine's own finish_reason "length": the same flag a ChatProvider sets (provider.mts).
  const truncated = response.metadata?.stopReason === 'maxTokens';
  return { role: 'assistant', content: response.response, ...(tool_calls.length ? { tool_calls } : {}), ...(truncated ? { truncated: true } : {}) };
}
