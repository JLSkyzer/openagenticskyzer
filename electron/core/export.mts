// Conversation export: exporter.py, ported field for field. `renderEntries` is the single
// source of truth every format (Markdown/HTML/JSON) reads from — exactly what NiceGUI's
// `state.messages` already was (a flat list with tool name/tag resolved once).

interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ExportMessage {
  role: string; content: string; tool_call_id?: string; tool_calls?: ToolCall[]; [key: string]: unknown;
}

export interface RenderedEntry {
  kind: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
  tag?: string;
  detail?: string;
}

// gui_callback.py::_TOOL_TAGS — every category maps to the SAME tag vocabulary the original used,
// derived here from the tool's real registered category (AgentTool.category) rather than a second
// hardcoded table that could drift from it. An unregistered/unknown tool defaults to "read", like
// `_TOOL_TAGS.get(tool_name, "read")`.
function tagFor(category: string | undefined): string {
  if (category === 'shell') return 'run';
  if (category === 'network') return 'search';
  if (category === 'write') return 'write';
  return 'read';
}

const MAX_DETAIL = 120;

// on_tool_start: prefers path, then command, then query from the parsed arguments, falls back to the
// raw arguments string; each truncated to 120 characters.
function detailFor(rawArguments: string): string {
  try {
    const parsed = JSON.parse(rawArguments);
    const preferred = parsed?.path ?? parsed?.command ?? parsed?.query;
    if (preferred !== undefined && preferred !== null) return String(preferred).slice(0, MAX_DETAIL);
  } catch { /* not JSON: fall through to the raw string, same as the original's except: pass */ }
  return rawArguments.slice(0, MAX_DETAIL);
}

function roleOf(role: string): 'user' | 'assistant' | 'tool' | 'system' | null {
  if (role === 'user' || role === 'human') return 'user';
  if (role === 'assistant' || role === 'ai') return 'assistant';
  if (role === 'tool') return 'tool';
  if (role === 'system') return 'system';
  return null;
}

/**
 * Flattens a persisted conversation into the entries every export format renders. An assistant turn
 * with no text (it only called a tool) is skipped — ChatView.tsx already never shows that bubble on
 * screen, and the NiceGUI app never stored one either. A tool call's name/category is looked up by
 * `tool_call_id` on the assistant message that made it, not from the current session's live events,
 * so a conversation reloaded from disk exports exactly as well as one just produced.
 */
export function renderEntries(messages: readonly ExportMessage[], categoryOf: (name: string) => string | undefined): RenderedEntry[] {
  const calls = new Map<string, { name: string; arguments: string }>();
  const entries: RenderedEntry[] = [];
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) calls.set(call.id, { name: call.function.name, arguments: call.function.arguments });
    const kind = roleOf(message.role);
    if (kind === 'system' || kind === null) continue;
    if (kind === 'assistant' && !message.content.trim()) continue; // tool-call-only turn: nothing to show
    if (kind === 'tool') {
      const call = message.tool_call_id ? calls.get(message.tool_call_id) : undefined;
      entries.push({
        kind: 'tool', content: message.content, toolName: call?.name,
        tag: tagFor(call ? categoryOf(call.name) : undefined),
        detail: call ? detailFor(call.arguments) : undefined,
      });
      continue;
    }
    entries.push({ kind, content: message.content });
  }
  return entries;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}
function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function exportFilename(ext: string, date: Date): string {
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `conversation_${stamp}.${ext}`;
}

// exporter.py::export_markdown, string for string.
export function buildMarkdown(entries: readonly RenderedEntry[], options: { folder: string; model: string; provider: string; date: Date }): string {
  const lines = [`# Conversation — ${formatDate(options.date)}\n`, `Dossier : \`${options.folder}\`\n`, `Modèle : \`${options.model}\` (${options.provider})\n\n---\n`];
  for (const entry of entries) {
    if (entry.kind === 'user') lines.push(`\n## 👤 Utilisateur\n\n${entry.content}\n`);
    else if (entry.kind === 'assistant') lines.push(`\n## 🤖 Assistant\n\n${entry.content}\n`);
    else {
      // Every line quoted, blank lines included: a Markdown blockquote closes at the first line that
      // is not prefixed, and a plain blank line would end it before the block does.
      const quoted = entry.content.split('\n').map(line => `> ${line}`).join('\n');
      lines.push(`\n> **[${(entry.tag ?? 'read').toUpperCase()}]** \`${entry.toolName ?? ''}\` —\n${quoted}\n`);
    }
  }
  return lines.join('');
}

// html.escape(s, quote=True): & first, then < > " ' — order matters, & must not double-escape the
// entities produced by the later replacements.
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

const CODE_FENCE = /(```\w*\n[\s\S]*?```)/g;
const CODE_FENCE_PARTS = /```(\w*)\n([\s\S]*?)```/;

// exporter.py::_render_ai_content — split on code fences BEFORE escaping, so each segment (code or
// plain text) is escaped exactly once. Escaping the whole string first and re-escaping the fenced
// capture group double-escaped it (a documented regression, see tasks/lessons.md).
function renderAiContent(raw: string): string {
  return raw
    .split(CODE_FENCE)
    .map(segment => {
      const fence = CODE_FENCE_PARTS.exec(segment);
      if (!fence) return escapeHtml(segment);
      const [, lang, code] = fence;
      return `<pre><code class='language-${lang}'>${escapeHtml(code)}</code></pre>`;
    })
    .join('');
}

// exporter.py::export_html, string for string (same CSS, same CDN, same structure).
export function buildHtml(entries: readonly RenderedEntry[], options: { model: string; date: Date }): string {
  const css = `
    body{background:#0d0d0d;color:#e0e0e0;font-family:system-ui;max-width:900px;margin:0 auto;padding:24px}
    .user{background:#1a0a2e;border-radius:12px;padding:12px 16px;margin:8px 0;text-align:right}
    .ai{background:#111;border:1px solid #222;border-radius:12px;padding:12px 16px;margin:8px 0}
    .tool{background:#0a0a1a;border-left:2px solid #4a4a8a;padding:6px 12px;margin:4px 0;font-size:.8em}
    pre{background:#1e1e2e;border-radius:8px;padding:12px;overflow-x:auto}
    code{font-family:'JetBrains Mono',monospace;font-size:.8em}
    .role{font-size:.7em;color:#666;margin-bottom:4px}
    `;
  const hljs = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0';
  const parts = [
    "<!DOCTYPE html><html><head><meta charset='utf-8'>",
    `<link rel='stylesheet' href='${hljs}/styles/atom-one-dark.min.css'>`,
    `<script src='${hljs}/highlight.min.js'></script>`,
    `<style>${css}</style></head><body>`,
    `<h1 style='color:#7c3aed'>Conversation — ${formatDate(options.date)}</h1>`,
    `<p style='color:#666'>Modèle : <code>${escapeHtml(options.model)}</code></p><hr style='border-color:#222'>`,
  ];
  for (const entry of entries) {
    if (entry.kind === 'user') parts.push(`<div class='user'><div class='role'>Utilisateur</div>${escapeHtml(entry.content)}</div>`);
    else if (entry.kind === 'assistant') parts.push(`<div class='ai'><div class='role'>Assistant</div>${renderAiContent(entry.content)}</div>`);
    else parts.push(`<div class='tool'>[${(entry.tag ?? 'read').toUpperCase()}] <b>${escapeHtml(entry.toolName ?? '')}</b> — ${escapeHtml(entry.content)}</div>`);
  }
  parts.push('<script>hljs.highlightAll();</script></body></html>');
  return parts.join('');
}

// exporter.py::export_json — one object per entry, the same four fields always present.
export function buildJson(entries: readonly RenderedEntry[]): string {
  const data = entries.map(entry => ({
    role: entry.kind === 'user' ? 'user' : entry.kind === 'assistant' ? 'ai' : 'tool',
    content: entry.content,
    tool_name: entry.toolName ?? null,
    tool_tag: entry.kind === 'tool' ? entry.tag ?? null : null,
    tool_detail: entry.detail ?? null,
  }));
  return JSON.stringify(data, null, 2);
}
