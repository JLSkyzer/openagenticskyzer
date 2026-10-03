// What the provider receives, built from the conversation as it is saved (audit H3/H4, 2026-10-03). The
// saved and displayed conversation never changes; only the request does.
import { toWireMessage, type Attachment } from './attachments.mts';
import { characters, tokensFor } from './context-budget.mts';
import type { ChatMessage, ToolSchema } from './provider.mts';

export const CONTEXT_FULL = 'Contexte plein : compacte ou efface la conversation';

const isUser = (message: ChatMessage) => message.role === 'user' || (message.role as string) === 'human';
const isAssistant = (message: ChatMessage) => message.role === 'assistant' || (message.role as string) === 'ai';
const textOf = (content: ChatMessage['content']) => (typeof content === 'string' ? content : '');

/** Where the turn in progress starts: the last user message (-1 when there is none: everything is current). */
export function currentTurnStart(messages: readonly ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) if (isUser(messages[index])) return index;
  return -1;
}

/** An earlier user message: what was typed, each of its files reduced to one `[pièce jointe : <nom>]` line. */
function withPlaceholders(message: ChatMessage): string {
  const files = Array.isArray(message.attachments) ? (message.attachments as Attachment[]) : [];
  return [...files.map(file => `[pièce jointe : ${file.name}]`), textOf(message.content)].filter(Boolean).join('\n');
}

/**
 * The messages to send (system message excluded). Earlier turns — before the last user message — keep only
 * the user messages and the TEXT of the assistant ones (tool calls, tool results and text-less assistant
 * messages are dropped, as Python sent them); the turn in progress is sent whole, its attachments expanded.
 */
export function requestMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const start = Math.max(0, currentTurnStart(messages));
  const earlier: ChatMessage[] = [];
  for (const message of messages.slice(0, start)) {
    if (isUser(message)) earlier.push({ role: 'user', content: withPlaceholders(message) });
    else if (isAssistant(message) && textOf(message.content).trim()) earlier.push({ role: 'assistant', content: textOf(message.content) });
  }
  const current = messages.slice(start).map(message => toWireMessage(message as never) as unknown as ChatMessage);
  return [...earlier, ...current];
}

function messageCharacters(message: ChatMessage): number {
  let total = 0;
  if (typeof message.content === 'string') total += characters(message.content);
  else if (Array.isArray(message.content)) {
    // An image part is not text: providers bill it in their own unit, it is not estimated here.
    for (const part of message.content as Array<{ type?: string; text?: unknown }>) {
      if (part?.type === 'text' && typeof part.text === 'string') total += characters(part.text);
    }
  }
  for (const call of message.tool_calls ?? []) total += characters(call.function.name) + characters(call.function.arguments);
  return total;
}

/** Estimated tokens of a whole request: system prompt, tool schemas and messages (text, arguments, results). */
export function estimateRequestTokens(system: string, tools: readonly ToolSchema[], messages: readonly ChatMessage[]): number {
  let total = characters(system) + (tools.length ? characters(JSON.stringify(tools)) : 0);
  for (const message of messages) total += messageCharacters(message);
  return tokensFor(total);
}

/**
 * `messages` (from requestMessages) fitted into `budgetTokens`: the oldest tool results OF THE TURN IN PROGRESS
 * are replaced, one by one, by a short notice until the request fits. Earlier turns are never cut here: if
 * the request still does not fit, nothing is sent (CONTEXT_FULL). The input array is not modified.
 */
export function fitToBudget(messages: readonly ChatMessage[], options: { system: string; tools: readonly ToolSchema[]; budgetTokens: number }): ChatMessage[] {
  const fitted = messages.slice();
  const fits = () => estimateRequestTokens(options.system, options.tools, fitted) <= options.budgetTokens;
  if (fits()) return fitted;
  const start = Math.max(0, currentTurnStart(fitted));
  const names = new Map<string, string>();
  for (const message of fitted.slice(start)) for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name);
  for (let index = start; index < fitted.length; index++) {
    const message = fitted[index];
    if (message.role !== 'tool' || typeof message.content !== 'string') continue;
    const tool = names.get(message.tool_call_id ?? '') ?? 'outil';
    fitted[index] = { ...message, content: `[sortie de ${tool} retirée pour tenir dans le contexte : ${characters(message.content)} caractères]` };
    if (fits()) return fitted;
  }
  throw new Error(CONTEXT_FULL);
}

/**
 * Every tool call left without a result (Stop during a permission prompt or a running tool, an error) gets
 * one, placed right after the results its message already has, in call order: the saved transcript stays a
 * valid sequence for providers that enforce the pairing. `added` lists what was created, in order.
 */
export function closeDanglingCalls(messages: readonly ChatMessage[], reason: string): { messages: ChatMessage[]; added: ChatMessage[] } {
  const answered = new Set(messages.filter(message => message.role === 'tool' && message.tool_call_id).map(message => message.tool_call_id));
  const repaired: ChatMessage[] = [];
  const added: ChatMessage[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    repaired.push(message);
    if (!isAssistant(message) || !message.tool_calls?.length) continue;
    while (index + 1 < messages.length && messages[index + 1].role === 'tool') repaired.push(messages[++index]);
    for (const call of message.tool_calls) {
      if (answered.has(call.id)) continue;
      const closing: ChatMessage = { role: 'tool', tool_call_id: call.id, content: reason };
      repaired.push(closing); added.push(closing); answered.add(call.id);
    }
  }
  return { messages: repaired, added };
}
