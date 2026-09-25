// input_bar.py::_find_last_user_index and chat.py's `last_ai_idx`, over the messages on screen.
interface RoleContent { role: string; content: string }

const isUser = (role: string) => role === 'user' || role === 'human';
const isAssistant = (role: string) => role === 'assistant' || role === 'ai';

/** Index of the last user message, or -1: what 🔄 sends again. */
export function lastUserIndex(messages: readonly RoleContent[]): number {
  for (let index = messages.length - 1; index >= 0; index--) if (isUser(messages[index].role)) return index;
  return -1;
}

/** Index of the last assistant message that has text, or -1: the one 🔄 sits under. A tool-only turn
 * shows no bubble (ChatView skips it), so it can never be the one the button is attached to. */
export function lastAssistantIndex(messages: readonly RoleContent[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isAssistant(messages[index].role) && messages[index].content.trim()) return index;
  }
  return -1;
}
