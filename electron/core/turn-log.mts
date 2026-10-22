// The turn log (spec objective 5): one JSON Lines file per local day, <dataHome>/logs/turns/AAAA-MM-JJ.jsonl, written
// by the worker — one line per event of a turn. A diagnostic, not a backup: the conversation stays saved in the project.
// No secret may ever reach it, at any level: every event goes through the same pipeline before it is written —
// sensitive file tools masked, then exact secrets and token patterns masked (redaction BEFORE the truncation, so a token
// cut in two by the truncation is already gone), then the level (metadata drops the contents, full truncates them).
import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { TurnTiming } from './model-types.mts';
import { expandServerPlaceholders, type McpServerConfig } from './mcp-config.mts';

export const TURN_LOG_LEVELS = ['full', 'metadata', 'off'] as const;
export type TurnLogLevel = typeof TURN_LOG_LEVELS[number];
export const TURN_LOG_FIELD_LIMIT = 20_000;
export const TURN_LOG_RETENTION_DAYS = 14;
export const MASK = '[masqué]';
export const SENSITIVE_FILE_MASK = '[masqué : fichier sensible]';
/** The content keys of an event: dropped by 'metadata', truncated by 'full'. */
export const CONTENT_FIELDS = ['text', 'reasoning', 'arguments', 'result'] as const;

const DAY_FILE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function turnLogDir(dataHome: string): string {
  return join(dataHome, 'logs', 'turns');
}

/** The day file of `at`, by its LOCAL date (the day the user lived the turn). */
export function turnLogFile(dataHome: string, at: Date): string {
  return join(turnLogDir(dataHome), `${localDay(at)}.jsonl`);
}

/**
 * Known token shapes, each replaced by MASK. The prefixes that only tokens use (hf_, ghp_…, github_pat_, xox?-, AKIA)
 * are matched even glued to a preceding word (« aghp_… »): masking too much is the safe side. `sk-` and `Bearer` keep
 * their word boundary, since « task-… » or « risk-… » start ordinary words and identifiers.
 */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /hf_[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
];

function redactText(text: string, secrets: readonly string[]): string {
  let result = text;
  // split/join, never replace() with a string: a secret holding `$&` would be read as a pattern (lesson 2026-09-22).
  for (const secret of secrets) if (secret && result.includes(secret)) result = result.split(secret).join(MASK);
  for (const pattern of TOKEN_PATTERNS) result = result.replace(pattern, () => MASK);
  return result;
}

/** A deep copy of `value` in which every string has its exact secrets (longest first) then its token patterns
 * replaced by MASK. Object keys are kept as they are. */
export function redact(value: unknown, secrets: readonly string[]): unknown {
  const ordered = [...new Set(secrets.filter(secret => typeof secret === 'string' && secret.length > 0))].sort((a, b) => b.length - a.length);
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') return redactText(item, ordered);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, walk(inner)]));
    return item;
  };
  return walk(value);
}

/** A deep copy of `value` in which every string longer than `limit` keeps its first `limit` characters, followed by
 * how many were cut. */
export function truncateFields(value: unknown, limit: number = TURN_LOG_FIELD_LIMIT): unknown {
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') return item.length > limit ? `${item.slice(0, limit)}…[tronqué : ${item.length - limit} caractères de plus]` : item;
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, walk(inner)]));
    return item;
  };
  return walk(value);
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
// An auth header's credential, after its scheme: the model or the user often repeats the token alone (ruling B2).
const AUTH_SCHEME = /^(?:Bearer|Basic|Token|Bot)\s+(\S+)$/i;

/**
 * The values of the MCP servers' configs that a turn log must mask: every `env` and `headers` value, as written and
 * after expandServerPlaceholders, with the credential after an auth scheme on its own (ruling B2); and, from every
 * field (command, args, url too), the value each `${VAR}` expands to (ruling M5: an expanded secret in args or url).
 * Only values of at least 6 characters, deduplicated: a shorter one would mask ordinary words.
 */
export function mcpSecretValues(servers: readonly McpServerConfig[], env: NodeJS.ProcessEnv = process.env): string[] {
  const values = new Set<string>();
  const add = (value: string | undefined) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    for (const candidate of [value, trimmed, AUTH_SCHEME.exec(trimmed)?.[1]]) {
      if (typeof candidate === 'string' && candidate.length >= 6) values.add(candidate);
    }
  };
  const placeholders = (text: string) => {
    for (const [, name, fallback] of text.matchAll(PLACEHOLDER)) {
      add(env[name]);
      if (fallback !== undefined) add(fallback);
    }
  };
  for (const server of servers) {
    const expanded = expandServerPlaceholders(server, env);
    const records: Array<Record<string, string> | undefined> = 'command' in server
      ? [server.env, (expanded as typeof server).env]
      : [server.headers, (expanded as typeof server).headers];
    for (const record of records) for (const value of Object.values(record ?? {})) add(value);
    const fields = 'command' in server ? [server.command, ...server.args] : [server.url];
    for (const field of fields) placeholders(field);
    for (const record of records.slice(0, 1)) for (const value of Object.values(record ?? {})) placeholders(value);
  }
  return [...values];
}

export type TurnLogEvent =
  | { event: 'turn-start'; model: string | null; text: string; attachments: number; keep?: number }
  | { event: 'model-ready'; backend: string | null; gpuLayers?: number; totalLayers?: number; contextSize: number; wrapper?: string; segments?: unknown; loadMs?: number }
  | { event: 'phase'; phase: string; previous: string | null; previousMs: number | null; progress?: number; tool?: string }
  | { event: 'generation'; step: number; inputTokens: number; outputTokens: number; generationMs: number }
  | { event: 'tool'; tool: string; category?: string; arguments: unknown; durationMs?: number; ok: boolean; result: string }
  | { event: 'reply'; step: number; reasoning?: string; text: string; toolCalls: number }
  | { event: 'end'; kind: 'done' | 'stopped' | 'error'; timing: TurnTiming; stopLatencyMs?: number; message?: string };

/** A turn's writer. `write` never throws; lines are appended in the order written; `flush` resolves (never rejects)
 * once every line written so far is on disk or has failed. */
export interface TurnLogger { write(event: TurnLogEvent): void; flush(): Promise<void> }

export interface TurnLogInput {
  runId: string;
  folder: string;
  level: TurnLogLevel;
  /** Exact values to mask (hf_token, the MCP servers' secrets). */
  secrets: readonly string[];
  /** True for a path whose file tool arguments and result must not be logged (sensitive or protected file). */
  isProtected: (path: string) => boolean;
}

const NO_LOG: TurnLogger = { write() {}, flush: async () => {} };

// The argument keys that name a file: `path` (the workspace tools), `file` (git_diff, git_blame, git_log) and `files`
// (git_add: names separated by spaces, quotes around a name with spaces).
const PATH_KEYS = ['path', 'file', 'files'] as const;

/** The string path arguments of a tool call, under their own keys; null when it names none. */
function namedPaths(args: unknown): Record<string, string> | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const named: Record<string, string> = {};
  for (const key of PATH_KEYS) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === 'string') named[key] = value;
  }
  return Object.keys(named).length ? named : null;
}

/** Every path those arguments name: `files` also word by word, quotes removed (more paths tested is the safe side). */
function pathsOf(named: Record<string, string>): string[] {
  const paths = Object.values(named);
  if (named.files !== undefined) paths.push(...named.files.split(/\s+/).map(word => word.replace(/^["']|["']$/g, '')).filter(Boolean));
  return paths;
}

/** The event as it may be written: the pipeline of the module header, in that order. A file tool whose path is
 * protected keeps only its path arguments, and its result is masked; an isProtected that throws counts as protected. */
function prepare(event: TurnLogEvent, input: TurnLogInput): Record<string, unknown> {
  let current: Record<string, unknown> = { ...event };
  if (event.event === 'tool') {
    const named = namedPaths(event.arguments);
    if (named && pathsOf(named).some(path => { try { return input.isProtected(path); } catch { return true; } })) {
      current = { ...current, arguments: named, result: SENSITIVE_FILE_MASK };
    }
  }
  current = redact(current, input.secrets) as Record<string, unknown>;
  if (input.level === 'metadata') for (const key of CONTENT_FIELDS) delete current[key];
  else current = truncateFields(current) as Record<string, unknown>;
  return current;
}

export class TurnLog {
  readonly #dataHome: string;
  readonly #now: () => Date;
  #suspended = false;

  constructor(dataHome: string, now: () => Date = () => new Date()) {
    this.#dataHome = dataHome;
    this.#now = now;
  }

  get suspended(): boolean { return this.#suspended; }

  /** After a data-folder migration: the data home moved away, so every logger, existing or new, writes nothing more
   * (a line would recreate logs/turns in the old home) until the worker restarts on the new one. */
  suspend(): void { this.#suspended = true; }

  begin(input: TurnLogInput): TurnLogger {
    if (input.level !== 'full' && input.level !== 'metadata') return NO_LOG;
    let chain: Promise<void> = Promise.resolve();
    let reported = false;
    const report = (error: unknown) => {
      if (reported) return;
      reported = true;
      console.error(`[turn-log] journal des tours non écrit : ${error instanceof Error ? error.message : String(error)}`);
    };
    return {
      write: event => {
        if (this.#suspended) return;
        let line: string;
        let file: string;
        try {
          const at = this.#now();
          line = JSON.stringify({ at: at.toISOString(), runId: input.runId, folder: input.folder, ...prepare(event, input) }) + '\n';
          file = turnLogFile(this.#dataHome, at);
        } catch (error) {
          report(error);
          return;
        }
        chain = chain.then(async () => {
          if (this.#suspended) return;
          await mkdir(turnLogDir(this.#dataHome), { recursive: true });
          await appendFile(file, line, 'utf8');
        }).catch(report);
      },
      flush: () => chain,
    };
  }
}

/** Removes the day files of `<dataHome>/logs/turns/` older than `days` days before `now`'s local day — only regular
 * files named exactly AAAA-MM-JJ.jsonl with a real date; anything else stays. Returns the removed names, sorted. A
 * missing folder removes nothing. Deleted, not archived: an app-written diagnostic, not user data. */
export async function pruneTurnLogs(dataHome: string, now: Date, days: number = TURN_LOG_RETENTION_DAYS): Promise<string[]> {
  const dir = turnLogDir(dataHome);
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error: any) { if (error?.code === 'ENOENT') return []; throw error; }
  const cutoff = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days));
  const removed: string[] = [];
  for (const entry of entries) {
    const match = DAY_FILE.exec(entry.name);
    if (!match || !entry.isFile()) continue;
    const [, y, m, d] = match;
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    if (localDay(date) !== `${y}-${m}-${d}`) continue; // not a real date: not one of ours
    if (`${y}-${m}-${d}` >= cutoff) continue;
    await unlink(join(dir, entry.name));
    removed.push(entry.name);
  }
  return removed.sort();
}
