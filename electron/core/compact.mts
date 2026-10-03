import type { ChatMessage, ChatProvider, ModelConnection } from './provider.mts';
import { estimateRequestTokens } from './request-context.mts';

/** Same threshold as context_bar.py::trigger_compact. */
export const MIN_MESSAGES = 6;
const MAX_CHARS_PER_MESSAGE = 800;
export const SUMMARY_PREFIX = '**[Résumé de contexte compressé]**\n\n';
const TOO_SHORT = 'Pas assez de messages à compresser.';
export const TOO_LONG_TO_COMPACT = 'Contexte plein : la conversation est trop longue pour être compactée avec ce modèle — efface-la ou change de modèle';

interface Stored { role: string; content: string; [key: string]: unknown }

/**
 * Splits a conversation into the part to summarise and the part to keep.
 *
 * The NiceGUI app kept "the last 2 messages". A Node transcript holds assistant(tool_calls) / tool
 * pairs, and cutting between the two would make the provider reject the next request (a tool
 * message must follow its call) — so the kept part starts at the LAST USER MESSAGE instead, which
 * is always a clean boundary. When that message is the very first one there is one single exchange
 * and nothing left to summarise.
 */
export function planCompaction<T extends Stored>(messages: readonly T[]): { head: T[]; tail: T[] } {
  if (messages.length < MIN_MESSAGES) throw new Error(TOO_SHORT);
  let cut = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user' || messages[index].role === 'human') { cut = index; break; }
  }
  if (cut <= 0) throw new Error(TOO_SHORT);
  return { head: messages.slice(0, cut), tail: messages.slice(cut) };
}

// context_bar.py::_build_compact_history_text: only user and AI text, each cut at 800 characters. Tool
// outputs are left out (the summariser must not read web pages or file contents).
export function buildHistoryText(head: readonly Stored[]): string {
  return head
    .filter(message => (message.role === 'user' || message.role === 'human' || message.role === 'assistant' || message.role === 'ai') && message.content.trim())
    .map(message => `[${message.role === 'user' || message.role === 'human' ? 'USER' : 'AI'}]: ${[...message.content].slice(0, MAX_CHARS_PER_MESSAGE).join('')}`)
    .join('\n\n');
}

// context_bar.py::_build_compact_summary_prompt, word for word.
export function buildSummaryPrompt(historyText: string): string {
  return (
    'Résume cette conversation de manière dense et structurée.\n' +
    'Conserve : décisions prises, fichiers modifiés, problèmes résolus, contexte technique.\n' +
    'Omets : salutations, répétitions, tentatives ratées.\n' +
    'Format : liste à puces, max 400 mots.\n\n' +
    `CONVERSATION :\n${historyText}\n\nRÉSUMÉ :`
  );
}

/**
 * Asks the model for a summary and returns the compacted conversation. Pure with respect to storage:
 * it never writes anything, so a failure leaves the caller's conversation exactly as it was.
 * No tool is offered to the model: what it reads may carry an injection.
 *
 * `contextWindow` (tokens) sizes the request like the agent does (M3): the output asked for is the provider's
 * cap lowered to what the window leaves after the summary prompt, never below 1; a prompt that alone fills the
 * window is refused without calling the provider. No cap (ollama): no maxTokens, as before. Without a window,
 * nothing is sized.
 */
export async function compactMessages<T extends Stored>(options: {
  provider: Pick<ChatProvider, 'complete'> & Partial<Pick<ChatProvider, 'outputCap'>>;
  connection: ModelConnection; messages: readonly T[]; contextWindow?: number; signal?: AbortSignal;
}): Promise<Array<T | Stored>> {
  const { head, tail } = planCompaction(options.messages);
  const prompt = buildSummaryPrompt(buildHistoryText(head));
  const request: ChatMessage[] = [{ role: 'user', content: prompt }];
  let maxTokens: number | undefined;
  if (options.contextWindow !== undefined) {
    const room = options.contextWindow - estimateRequestTokens('', [], request);
    if (room <= 0) throw new Error(TOO_LONG_TO_COMPACT);
    const cap = options.provider.outputCap?.(options.connection);
    if (cap !== undefined) maxTokens = Math.max(1, Math.min(cap, room));
  }
  const answer = await options.provider.complete({
    connection: options.connection,
    messages: request,
    signal: options.signal,
    ...(maxTokens === undefined ? {} : { maxTokens }),
  });
  // A summary cut by the output limit would replace the head of the conversation with half a summary.
  if (answer.truncated) throw new Error('Le résumé a été tronqué par la limite de sortie — contexte inchangé.');
  const summary = answer.content.trim();
  if (!summary) throw new Error('Le modèle n’a renvoyé aucun résumé — contexte inchangé.');
  return [{ role: 'assistant', content: SUMMARY_PREFIX + summary }, ...tail];
}
