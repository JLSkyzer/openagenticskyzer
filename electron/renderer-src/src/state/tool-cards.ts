import type { ChatMessage } from '../ipc/types';

// Tool cards (parity row 6, 2026-10-05): the name, badge and detail a tool result shows, the same whether the turn is
// live or the conversation was reopened. The agent loop saves each result with the tool's `name` and `category`
// (core/agent.mts). A conversation saved before that has neither: the name is read from the assistant's tool call that
// precedes the result, the category stays unknown (the card shows a neutral badge).

export const TOOL_DETAIL_MAX = 120;

// The argument a card shows beside the tool name: the path for the file tools, the command for run_command, the query
// or the URL for search and the web. Every other tool shows none.
const DETAIL_ARGUMENT: Readonly<Record<string, string>> = {
  read_file: 'path', view_file: 'path', list_dir: 'path', create_file: 'path', edit_file: 'path', create_dir: 'path',
  delete_file: 'path', delete_dir: 'path', grep_file: 'path', glob_files: 'path', grep_codebase: 'path',
  run_command: 'command',
  internet_search: 'query', semantic_search: 'query', knowledge_search: 'query',
  fetch_url: 'url',
};

export interface ToolCallInfo { name: string; arguments: string }

/** A message as the chat shows it: on a tool result, `_tool`, `_category` and `_detail` are set only when known. */
export type RenderedMessage = ChatMessage & { _tool?: string; _category?: string; _detail?: string };

/** The detail of a call to `tool` with these raw (JSON) arguments, cut to TOOL_DETAIL_MAX characters; undefined when
 * the tool shows none, or the argument is missing, empty or unreadable. */
export function toolDetail(tool: string | undefined, rawArguments: string | undefined): string | undefined {
  const field = tool === undefined ? undefined : DETAIL_ARGUMENT[tool];
  if (!field || rawArguments === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(rawArguments); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const value = (parsed as Record<string, unknown>)[field];
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.slice(0, TOOL_DETAIL_MAX);
}

function toolCallsOf(message: ChatMessage): Array<[string, ToolCallInfo]> {
  if (!Array.isArray(message.tool_calls)) return [];
  const found: Array<[string, ToolCallInfo]> = [];
  for (const raw of message.tool_calls as unknown[]) {
    const call = raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } } | null;
    if (!call || typeof call.id !== 'string' || typeof call.function?.name !== 'string') continue;
    found.push([call.id, { name: call.function.name, arguments: typeof call.function.arguments === 'string' ? call.function.arguments : '' }]);
  }
  return found;
}

/** Every tool call of `messages`, by id. */
export function callsById(messages: readonly ChatMessage[]): Map<string, ToolCallInfo> {
  const calls = new Map<string, ToolCallInfo>();
  for (const message of messages) for (const [id, call] of toolCallsOf(message)) calls.set(id, call);
  return calls;
}

/** `message` with its card: the name and category it was saved with, else those of the live tool-start, else the
 * name of its call; the detail from its call's arguments. Anything but a tool result is returned as is. */
export function toolCard(message: ChatMessage, calls: ReadonlyMap<string, ToolCallInfo>, live?: { tool: string; category?: string }): RenderedMessage {
  if (message.role !== 'tool') return message;
  const call = typeof message.tool_call_id === 'string' ? calls.get(message.tool_call_id) : undefined;
  const tool = (typeof message.name === 'string' && message.name) || live?.tool || call?.name;
  const category = (typeof message.category === 'string' && message.category) || live?.category;
  const detail = toolDetail(call?.name ?? tool, call?.arguments);
  return { ...message, ...(tool ? { _tool: tool } : {}), ...(category ? { _category: category } : {}), ...(detail ? { _detail: detail } : {}) };
}

/** A conversation as loaded (folder, branch, compaction): each tool result with its card, from the calls before it. */
export function withToolCards(messages: readonly ChatMessage[]): RenderedMessage[] {
  const calls = new Map<string, ToolCallInfo>();
  return messages.map(message => {
    for (const [id, call] of toolCallsOf(message)) calls.set(id, call);
    return toolCard(message, calls);
  });
}

export type DiffLineKind = 'header' | 'hunk' | 'added' | 'removed' | 'context';

/** How a card styles each line of a result that looks like a diff. The diff starts at its first line beginning with
 * `-`, `+` or `@@` (edit_file's result opens with its `Modifié : …` line). Only its first two lines can be file
 * headers, and only as a `--- ` / `+++ ` pair followed by a hunk header (core/unified-diff.mts). Any other `---` or
 * `+++` line — deeper in the diff, or in a result saved before the unified diff — is the removal or addition it is. */
export function diffLineKinds(lines: readonly string[]): DiffLineKind[] {
  const start = lines.findIndex(line => /^[-+]|^@@/.test(line));
  const headers = start >= 0 && lines[start].startsWith('--- ') && !!lines[start + 1]?.startsWith('+++ ') && !!lines[start + 2]?.startsWith('@@');
  return lines.map((line, index) => {
    if (headers && (index === start || index === start + 1)) return 'header';
    if (line.startsWith('+')) return 'added';
    if (line.startsWith('-')) return 'removed';
    if (line.startsWith('@@')) return 'hunk';
    return 'context';
  });
}
