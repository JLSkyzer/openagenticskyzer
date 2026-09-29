import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonStore } from './json-store.mts';

export interface McpServerConfig {
  id: string;
  command: string;
  args: string[];
  added_at: string;
}

function isValidEntry(value: unknown): value is McpServerConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return typeof c.id === 'string' && typeof c.command === 'string' && c.command.trim().length > 0
    && Array.isArray(c.args) && c.args.every(a => typeof a === 'string') && typeof c.added_at === 'string';
}

/** shlex-like split: quotes group words, so a path with spaces can still be one argument. */
function splitCommandLine(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null; else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) { parts.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * MCP stdio server definitions ("j'ajoute une commande MCP") — same file name and shape as the
 * previous NiceGUI app's mcp.json (settings.py::add_server: a full command line split into
 * command + args), with an id + timestamp added so the UI can remove an entry, which the
 * reference implementation could not do at all.
 */
export class McpConfigStore {
  private home: string;
  private store = new JsonStore();
  constructor(home: string) {
    if (!isAbsolute(home)) throw new Error('Répertoire de données absolu requis');
    this.home = home;
  }
  private path() {
    return join(this.home, 'mcp.json');
  }
  private async validEntries(): Promise<McpServerConfig[]> {
    const raw = await this.store.read<unknown>(this.path(), []);
    return Array.isArray(raw) ? raw.filter(isValidEntry) : [];
  }
  /** Saved servers, most recently added first. */
  async list(): Promise<McpServerConfig[]> {
    const entries = await this.validEntries();
    return entries.slice().sort((a, b) => b.added_at.localeCompare(a.added_at));
  }
  /** Parses a full command line (e.g. "npx -y @modelcontextprotocol/server-filesystem /tmp") into command + args. */
  async add(commandLine: string): Promise<McpServerConfig[]> {
    const parts = splitCommandLine(commandLine);
    if (!parts.length) throw new Error('Commande vide');
    const entry: McpServerConfig = { id: randomUUID(), command: parts[0], args: parts.slice(1), added_at: new Date().toISOString() };
    await this.store.update<unknown>(this.path(), [], current => [...(Array.isArray(current) ? current.filter(isValidEntry) : []), entry]);
    return this.list();
  }
  /** Forgets a server by id — an unknown id is a harmless no-op. */
  async remove(id: string): Promise<McpServerConfig[]> {
    await this.store.update<unknown>(this.path(), [], current =>
      (Array.isArray(current) ? current.filter(isValidEntry) : []).filter(e => e.id !== id),
    );
    return this.list();
  }
}
