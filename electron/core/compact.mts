import type { ChatMessage, ChatProvider, ModelConnection } from './provider.mts';

/** Same threshold as context_bar.py::trigger_compact. */
export const MIN_MESSAGES = 6;
const MAX_CHARS_PER_MESSAGE = 800;
export const SUMMARY_PREFIX = '**[Résumé de contexte compressé]**\n\n';
const TOO_SHORT = 'Pas assez de messages à compresser.';

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
 */
export async function compactMessages<T extends Stored>(options: {
  provider: Pick<ChatProvider, 'complete'>; connection: ModelConnection; messages: readonly T[]; signal?: AbortSignal;
}): Promise<Array<T | Stored>> {
  const { head, tail } = planCompaction(options.messages);
  const prompt = buildSummaryPrompt(buildHistoryText(head));
  const answer = await options.provider.complete({
    connection: options.connection,
    messages: [{ role: 'user', content: prompt } satisfies ChatMessage],
    signal: options.signal,
  });
  const summary = answer.content.trim();
  if (!summary) throw new Error('Le modèle n’a renvoyé aucun résumé — contexte inchangé.');
  return [{ role: 'assistant', content: SUMMARY_PREFIX + summary }, ...tail];
}
