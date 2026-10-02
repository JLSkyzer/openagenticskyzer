import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonStore } from './json-store.mts';

export interface StdioServerConfig {
  id: string;
  name?: string;
  scope: 'global' | 'project';
  command: string;
  args: string[];
  env?: Record<string, string>;
  added_at?: string;
}
export interface RemoteServerConfig {
  id: string;
  name?: string;
  scope: 'global' | 'project';
  type: 'sse' | 'http';
  url: string;
  headers?: Record<string, string>;
  added_at?: string;
}
export type McpServerConfig = StdioServerConfig | RemoteServerConfig;

interface StoredStdioEntry { id: string; command: string; args: string[]; env?: Record<string, string>; added_at: string }
interface StoredRemoteEntry { id: string; type: 'sse' | 'http'; url: string; headers?: Record<string, string>; added_at: string }
type StoredEntry = StoredStdioEntry | StoredRemoteEntry;

function isStringRecord(value: unknown): value is Record<string, string> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value as object).every(v => typeof v === 'string');
}
function isValidEntry(value: unknown): value is StoredEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  if (typeof c.id !== 'string' || typeof c.added_at !== 'string') return false;
  if (typeof c.command === 'string') {
    if (!c.command.trim() || !Array.isArray(c.args) || !c.args.every(a => typeof a === 'string')) return false;
    return c.env === undefined || isStringRecord(c.env);
  }
  if (c.type === 'sse' || c.type === 'http') {
    if (typeof c.url !== 'string' || !c.url.trim()) return false;
    return c.headers === undefined || isStringRecord(c.headers);
  }
  return false;
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
 * MCP server definitions, global scope ("j'ajoute une commande MCP") — same file name and shape as
 * the previous NiceGUI app's mcp.json (settings.py::add_server: a full command line split into
 * command + args), extended with optional `env` (stdio) and a new remote (sse/http) entry shape.
 * The on-disk format stays a flat array (no breaking change for existing users' mcp.json); `list()`
 * tags every entry `scope: 'global'` so it can be merged with project-scope entries elsewhere.
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
  private async validEntries(): Promise<StoredEntry[]> {
    const raw = await this.store.read<unknown>(this.path(), []);
    return Array.isArray(raw) ? raw.filter(isValidEntry) : [];
  }
  /** Saved servers, most recently added first, each tagged `scope: 'global'`. */
  async list(): Promise<McpServerConfig[]> {
    const entries = await this.validEntries();
    return entries
      .slice()
      .sort((a, b) => b.added_at.localeCompare(a.added_at))
      .map(entry => ({ ...entry, scope: 'global' as const }));
  }
  /** Parses a full command line (e.g. "npx -y @modelcontextprotocol/server-filesystem /tmp") into
   * command + args. `env`, when given and non-empty, is persisted alongside. */
  async add(commandLine: string, env?: Record<string, string>): Promise<McpServerConfig[]> {
    const parts = splitCommandLine(commandLine);
    if (!parts.length) throw new Error('Commande vide');
    const entry: StoredStdioEntry = {
      id: randomUUID(), command: parts[0], args: parts.slice(1),
      ...(env && Object.keys(env).length ? { env } : {}),
      added_at: new Date().toISOString(),
    };
    await this.store.update<unknown>(this.path(), [], current => [...(Array.isArray(current) ? current.filter(isValidEntry) : []), entry]);
    return this.list();
  }
  /** Adds a remote SSE/HTTP server definition — the other half of the global scope, alongside stdio. */
  async addRemote(url: string, type: 'sse' | 'http', headers?: Record<string, string>): Promise<McpServerConfig[]> {
    const trimmed = url.trim();
    if (!trimmed) throw new Error('URL vide');
    const entry: StoredRemoteEntry = {
      id: randomUUID(), type, url: trimmed,
      ...(headers && Object.keys(headers).length ? { headers } : {}),
      added_at: new Date().toISOString(),
    };
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

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Claude Code's `.mcp.json` placeholder syntax: `${VAR}` is the variable's value (empty if unset),
 * `${VAR:-default}` falls back to `default` when VAR is unset or empty. This is how a team keeps a
 * secret OUT of a committed `.mcp.json` ("Authorization": "Bearer ${API_KEY}"). The replacement is
 * a function, so a value containing `$&` or `$1` is inserted literally. */
function expandText(text: string, env: NodeJS.ProcessEnv): string {
  return text.replace(PLACEHOLDER, (_match, name: string, fallback: string | undefined) => {
    const value = env[name];
    if (fallback !== undefined) return value ? value : fallback;
    return value ?? '';
  });
}
function expandRecord(record: Record<string, string>, env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expandText(value, env)]));
}

/** A project-scope entry with every placeholder expanded in `command`, `args`, `env` values, `url`
 * and `headers` values — exactly the fields Claude Code expands. Keys are never expanded. */
export function expandServerPlaceholders(server: McpServerConfig, env: NodeJS.ProcessEnv = process.env): McpServerConfig {
  if ('command' in server) {
    return {
      ...server,
      command: expandText(server.command, env),
      args: server.args.map(arg => expandText(arg, env)),
      ...(server.env ? { env: expandRecord(server.env, env) } : {}),
    };
  }
  return { ...server, url: expandText(server.url, env), ...(server.headers ? { headers: expandRecord(server.headers, env) } : {}) };
}

/**
 * Reads `<folder>/.mcp.json` — the real Claude Code project-config schema, for real interop with
 * one known limit: `type: "sse"` is handled like `"http"` (MCP's Streamable HTTP), whereas Claude
 * Code means the LEGACY HTTP+SSE transport by it — a legacy-only SSE endpoint will not work here.
 * Stdio and `"http"` entries, placeholders included, do. Never written by this app: the user edits it by
 * hand or via git, same convention Claude Code itself uses for a file meant to be shared with a
 * team. Tolerant by design: a missing file means simply "no project servers" (empty list), and a
 * malformed one is logged and treated the same way — this must never block folder activation, the
 * same philosophy already applied to this project's other best-effort reads.
 *
 * `${VAR}` / `${VAR:-default}` placeholders are expanded against `process.env` (see
 * `expandServerPlaceholders`) — only here, never for the global store, whose values the user types
 * for real. `expandEnv: false` returns the entries exactly as written, for display: an expanded
 * placeholder is typically a secret.
 */
export async function readProjectMcpConfig(folder: string, { expandEnv = true }: { expandEnv?: boolean } = {}): Promise<McpServerConfig[]> {
  if (!isAbsolute(folder)) throw new Error('Dossier absolu requis');
  const path = join(folder, '.mcp.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error: any) {
    if (error.code === 'ENOENT') return [];
    console.error(`[mcp] .mcp.json illisible (${path}) : ${error.message}`);
    return [];
  }
  return parseProjectMcpConfig(raw, path, { expandEnv });
}

/** The parsing half of `readProjectMcpConfig`, on content the caller already read: lets a caller that
 * must also hash the file work on the very same bytes. Same tolerance: malformed or invalid entries
 * are logged and skipped. */
export function parseProjectMcpConfig(raw: string, path: string, { expandEnv = true }: { expandEnv?: boolean } = {}): McpServerConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`[mcp] .mcp.json invalide (JSON malformé) : ${path}`);
    return [];
  }
  const servers = (parsed as Record<string, unknown> | null)?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
  const result: McpServerConfig[] = [];
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') { console.error(`[mcp] .mcp.json : entrée "${name}" invalide`); continue; }
    const v = value as Record<string, unknown>;
    if (typeof v.command === 'string' && v.command.trim()) {
      const argsOk = v.args === undefined || (Array.isArray(v.args) && v.args.every(a => typeof a === 'string'));
      const envOk = v.env === undefined || isStringRecord(v.env);
      if (!argsOk || !envOk) { console.error(`[mcp] .mcp.json : entrée "${name}" invalide`); continue; }
      result.push({
        id: name, name, scope: 'project', command: v.command, args: (v.args as string[] | undefined) ?? [],
        ...(v.env ? { env: v.env as Record<string, string> } : {}),
      });
    } else if (v.type === 'sse' || v.type === 'http') {
      const headersOk = v.headers === undefined || isStringRecord(v.headers);
      if (typeof v.url !== 'string' || !v.url.trim() || !headersOk) { console.error(`[mcp] .mcp.json : entrée "${name}" invalide`); continue; }
      result.push({
        id: name, name, scope: 'project', type: v.type, url: v.url,
        ...(v.headers ? { headers: v.headers as Record<string, string> } : {}),
      });
    } else {
      console.error(`[mcp] .mcp.json : entrée "${name}" invalide`);
    }
  }
  return expandEnv ? result.map(server => expandServerPlaceholders(server)) : result;
}

/** A server's identity for merge purposes: command+args (stdio) or url (remote) — not `name`,
 * since global entries (added via the UI's single command-line field) have none. */
function serverIdentity(server: McpServerConfig): string {
  return 'command' in server ? `stdio:${server.command}:${JSON.stringify(server.args)}` : `remote:${server.url}`;
}

/** Stands in for every secret value in what the renderer receives. */
const REDACTED = '••••••••';

/** The server list as it may cross to the renderer: every `env` (stdio) and `headers` (remote)
 * VALUE replaced by `REDACTED`, keys kept — the renderer never needs a value (it displays none),
 * and secrets never travel back to it, the same invariant the connection API key and the HF token
 * already follow. The worker keeps using the real values; only this copy is redacted. */
export function redactSecrets(servers: McpServerConfig[]): McpServerConfig[] {
  const mask = (record: Record<string, string>) => Object.fromEntries(Object.keys(record).map(key => [key, REDACTED]));
  return servers.map(server => {
    if ('command' in server) return server.env ? { ...server, env: mask(server.env) } : server;
    return server.headers ? { ...server, headers: mask(server.headers) } : server;
  });
}

/** Unions global + project server lists. On a collision (same identity — see `serverIdentity`),
 * the project entry wins: the more specific scope overrides the more general one. */
export function mergeServerConfigs(global: McpServerConfig[], project: McpServerConfig[]): McpServerConfig[] {
  const projectIdentities = new Set(project.map(serverIdentity));
  const keptGlobal = global.filter(server => !projectIdentities.has(serverIdentity(server)));
  return [...project, ...keptGlobal];
}
