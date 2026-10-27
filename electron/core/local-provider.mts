// Pure mapping between our OpenAI-shaped agent messages (model-types.mts::ChatMessage/ToolSchema) and
// node-llama-cpp's own chat types (ChatHistoryItem, ChatModelFunctions, LlamaChatResponse). Deliberately
// has NO import of node-llama-cpp itself — that native binding lives in local-engine.mts, loaded only on
// first actual use — so every function here is fast and testable with plain fixtures, exactly like
// pdf-text.ts/pdf-loader.ts. `LlamaChat.generateResponse(history, options)` takes the FULL history on
// every call (no session state kept between turns), which matches agent.mts's own stateless loop exactly:
// it rebuilds `messages` fresh every iteration, so there is no session to keep in sync.
import type { ChatMessage, ToolCall, ToolSchema } from './model-types.mts';
import { contextItem, type ThoughtKept } from './prompt-layout.mts';
import { currentTurnStart } from './request-context.mts';
import { perfLevers } from './perf-levers.mts';

// ── node-llama-cpp's own shapes, declared locally (structural — no runtime import) ──────────────────────
export interface GgufFunctionSpec { description?: string; params?: unknown }
export type GgufFunctions = Record<string, GgufFunctionSpec>;
export type GgufHistoryItem =
  | { type: 'system'; text: string }
  | { type: 'user'; text: string }
  | { type: 'model'; response: GgufModelPart[] };
export type GgufModelPart = string | GgufFunctionCall | GgufThoughtSegment;
export interface GgufFunctionCall { type: 'functionCall'; name: string; params: unknown; result?: unknown }
/** A reply's reasoning sent back (the keepThought lever): the thought segment the model generated, closed. */
export interface GgufThoughtSegment { type: 'segment'; segmentType: 'thought'; text: string; ended: true }
export interface GgufResponse {
  response: string;
  functionCalls?: readonly { functionName: string; params: unknown }[];
  // node-llama-cpp 3.x: why generation stopped ("maxTokens" = the output cap was reached).
  metadata?: { stopReason?: string };
}

/** The keys a JSON schema carries for people, not for the model's arguments: dropped by compactSchema. */
const SCHEMA_NOISE = new Set(['$schema', 'title', 'examples', '$comment']);
/** The keys whose value is argument data, not a schema: copied as they are. */
const SCHEMA_DATA = new Set(['enum', 'const', 'default']);

/** `schema` without its noise, recursively: `$schema`, `title`, `examples`, `$comment` and an empty `required: []`.
 * Everything else stays — types, enums, limits, a non-empty `required`, `additionalProperties`, descriptions. A
 * `properties` map's keys are parameter names, never schema keys: a parameter named `title` is kept; `enum`, `const`
 * and `default` hold data, copied untouched. */
export function compactSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(compactSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_NOISE.has(key) || (key === 'required' && Array.isArray(value) && value.length === 0)) continue;
    if (SCHEMA_DATA.has(key)) kept[key] = value;
    else if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      kept[key] = Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, compactSchema(inner)]));
    } else kept[key] = compactSchema(value);
  }
  return kept;
}

/** OpenAI tool schemas → node-llama-cpp's `functions` option. `undefined` (not `{}`) when there are none:
 * an empty object still turns function-calling grammar ON with nothing to call. `compact` (the slimToolDefinitions
 * lever by default, shipped off) passes every tool's parameters through compactSchema, MCP tools included. */
export function toGgufFunctions(tools: readonly ToolSchema[], compact: boolean = perfLevers().slimToolDefinitions): GgufFunctions | undefined {
  if (tools.length === 0) return undefined;
  const functions: GgufFunctions = {};
  for (const tool of tools) functions[tool.function.name] = { description: tool.function.description, params: compact ? compactSchema(tool.function.parameters) : tool.function.parameters };
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
 * `projectContext` (the project's instructions, memory, learnings: context.mts) goes where `placement` says: `'system'`
 * (the default) heads the system text as today (`context\n\nbase`); `'after-tools'` is its own item right after the
 * system one (prompt-layout.mts), where a template that renders the tools inside the system part puts it after them.
 * An assistant message's `reasoning` (present only when request-context.mts kept it: the keepThought lever) is its model
 * item's first part, as the thought segment it was generated as.
 */
export function historyFromMessages(messages: readonly ChatMessage[], options: { projectContext?: string; placement?: 'system' | 'after-tools' } = {}): GgufHistoryItem[] {
  const resultsByCallId = new Map<string, string>();
  for (const message of messages) if (message.role === 'tool' && message.tool_call_id) resultsByCallId.set(message.tool_call_id, message.content);
  const history: GgufHistoryItem[] = [];
  for (const message of messages) {
    if (message.role === 'system') history.push({ type: 'system', text: textOf(message.content) });
    else if (isUser(message.role)) history.push({ type: 'user', text: textOf(message.content) });
    else if (isAssistant(message.role)) {
      const response: GgufModelPart[] = [];
      if (typeof message.reasoning === 'string' && message.reasoning) response.push({ type: 'segment', segmentType: 'thought', text: message.reasoning, ended: true });
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
  const context = options.projectContext;
  if (!context) return history;
  const system = history[0]?.type === 'system' ? 1 : 0;
  if (options.placement === 'after-tools') history.splice(system, 0, contextItem(context));
  else if (system) history[0] = { type: 'system', text: [context, (history[0] as { text: string }).text].filter(Boolean).join('\n\n') };
  else history.unshift({ type: 'system', text: context });
  return history;
}

/** `messages` without the reasoning a template would not render back where the model wrote it (prompt-layout.mts
 * `thoughtKept`, F15): before the last user message unless `kept.previousTurn`, from it on unless `kept.currentTurn`.
 * The same array when both are kept; never modified. */
export function thoughtsWhereKept(messages: readonly ChatMessage[], kept: Readonly<ThoughtKept>): readonly ChatMessage[] {
  if (kept.previousTurn && kept.currentTurn) return messages;
  const start = currentTurnStart(messages);
  return messages.map((message, index) => {
    if (!('reasoning' in message) || (index < start ? kept.previousTurn : kept.currentTurn)) return message;
    const { reasoning: _reasoning, ...rest } = message;
    return rest;
  });
}

/** node-llama-cpp's response → our ChatMessage, in the exact shape `ModelProvider.complete()` returns: no
 * `tool_calls` key at all when there are none. `mintId` supplies a fresh, unique id per call (node-llama-cpp
 * does not generate one) — the SAME id then correlates the later 'tool' role message back to this call. */
export function responseToMessage(response: GgufResponse, mintId: () => string): ChatMessage & { content: string } {
  const tool_calls: ToolCall[] = (response.functionCalls ?? []).map(call => ({
    id: mintId(), type: 'function', function: { name: call.functionName, arguments: JSON.stringify(call.params) },
  }));
  // The engine's own finish_reason "length": the `truncated` flag of model-types.mts::ChatMessage.
  const truncated = response.metadata?.stopReason === 'maxTokens';
  return { role: 'assistant', content: response.response, ...(tool_calls.length ? { tool_calls } : {}), ...(truncated ? { truncated: true } : {}) };
}
