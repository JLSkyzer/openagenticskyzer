import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { object } from './json-store.mts';
import { killTree } from './process.mts';
import type { AgentTool } from './agent.mts';

export interface McpServerTarget {
  command: string;
  args: string[];
  env?: Record<string, string>;
}
export interface McpRemoteTarget {
  type: 'sse' | 'http';
  url: string;
  headers?: Record<string, string>;
}
export type McpTarget = McpServerTarget | McpRemoteTarget;

function isRemoteTarget(target: McpTarget): target is McpRemoteTarget {
  return 'url' in target;
}
function targetLabel(target: McpTarget): string {
  return isRemoteTarget(target) ? target.url : target.command;
}

const DISCOVERY_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 60_000;
const MAX_ARGS_BYTES = 1024 * 1024;
const PROTOCOL_VERSION = '2024-11-05';

export interface Session {
  /** `requestTimeoutMs`: this request's own limit; by default the one the session was opened with. */
  request(method: string, params?: unknown, requestTimeoutMs?: number): Promise<any>;
  close(): Promise<void>;
  /** False once the session can no longer answer: its process ended, or its pipe or connection broke. */
  alive(): boolean;
}

/** The server's own JSON-RPC answer that a request failed: the process that said so is fine, and a kept one stays. */
class McpAnswerError extends Error {}

// Every stdio MCP process still running — a discovery or a call in flight — so the app can stop them when it quits: a
// worker thread's termination does not end the processes it spawned, and a server that ignores its stdin closing (some
// real servers, `npx` wrappers) would outlive the app.
const liveChildren = new Set<ChildProcess>();

/** Kills every MCP process still running, whole process trees included — worker.mjs's 'shutdown' calls it. */
export async function stopAllMcpServers(): Promise<void> {
  const children = [...liveChildren];
  liveChildren.clear();
  await Promise.all(children.map(child => killTree(child).catch(() => {})));
}

/** A JSON-RPC 2.0 session over stdio. Short-lived by default — one per discovery, one per call, exactly like
 * mcp_client/adapter.py's own _discover/_invoke; `kept` is the McpPool's long-lived one. */
function openStdioSession(target: McpServerTarget, timeoutMs: number, kept = false): Session {
  const child = spawn(target.command, target.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...target.env },
    windowsHide: true,
  });
  liveChildren.add(child);
  child.on('exit', () => liveChildren.delete(child));
  child.on('error', () => liveChildren.delete(child));
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let buffer = '';
  let startupError: Error | null = null;

  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message: any;
      try { message = JSON.parse(line); } catch { continue; }
      const waiting = typeof message.id === 'string' && pending.get(message.id);
      if (!waiting) continue;
      pending.delete(message.id);
      if (message.error) waiting.reject(new McpAnswerError(message.error.message || 'Erreur MCP'));
      else waiting.resolve(message.result);
    }
  });
  const fail = (error: Error) => {
    startupError = startupError ?? error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  child.on('error', (error: NodeJS.ErrnoException) => fail(error?.code === 'ENOENT' ? new Error(`commande introuvable : ${target.command}`) : error));
  child.on('exit', code => fail(new Error(`serveur MCP terminé (code ${code})`)));
  if (kept) {
    // Alive for hours, unlike a one-shot session: a server that logs must not fill its unread pipe and block, and a
    // write to one that has just died (EPIPE) must fail its requests, not raise an uncaught error in the worker.
    child.stderr.resume();
    child.stdin.on('error', () => fail(new Error('serveur MCP terminé (écriture impossible)')));
  }

  function request(method: string, params?: unknown, requestTimeoutMs = timeoutMs): Promise<any> {
    if (startupError) return Promise.reject(startupError);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`délai dépassé (${method})`)); }, requestTimeoutMs);
      pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
      catch (error: any) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  async function close() {
    try { child.stdin.end(); } catch { /* already gone */ }
    await killTree(child).catch(() => {});
  }
  return { request, close, alive: () => startupError === null };
}

/** Reads a Streamable-HTTP SSE response body until it finds the JSON-RPC message whose `id`
 * matches the request — the spec allows the server to send other messages first, but the matching
 * response SHOULD eventually arrive on this same stream before it closes. */
async function readSseJsonRpcResponse(response: Response, id: string): Promise<any> {
  if (!response.body) throw new Error('Flux SSE vide');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('Flux SSE terminé sans réponse');
      buffer += decoder.decode(value, { stream: true });
      // SSE allows CRLF, LF or CR line endings, and the official Python SDK (sse-starlette) sends
      // CRLF: normalize to LF so a single '\n\n' search finds every event boundary. A trailing '\r'
      // may be the first half of a CRLF split across two chunks — held back until the next one,
      // or it would become '\n' and its '\n' a second, fake one (a premature event boundary).
      const heldCr = buffer.endsWith('\r');
      buffer = (heldCr ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, '\n') + (heldCr ? '\r' : '');
      let index: number;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const rawEvent = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const dataLines = rawEvent.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim());
        if (!dataLines.length) continue;
        let message: any;
        try { message = JSON.parse(dataLines.join('\n')); } catch { continue; }
        if (message?.id === id) return message;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** A short-lived MCP "Streamable HTTP" session — same one-shot philosophy as the stdio session
 * above (one per discovery, one per call), but over `fetch` instead of a spawned process. Verified
 * against the official spec (modelcontextprotocol.io/specification/2025-06-18/basic/transports)
 * before implementing: every JSON-RPC message is its own POST, the server may answer with a plain
 * JSON object or an SSE stream (both handled), and a server-assigned `Mcp-Session-Id` is captured
 * from `initialize` and replayed on every later request in the same session. */
function openRemoteSession(target: McpRemoteTarget, timeoutMs: number): Session {
  let sessionId: string | null = null;
  let startupError: Error | null = null;

  async function request(method: string, params?: unknown, requestTimeoutMs = timeoutMs): Promise<any> {
    if (startupError) throw startupError;
    const id = randomUUID();
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
      ...target.headers,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const controller = new AbortController();
    // The timer must stay armed until the response BODY is fully read, not just until headers
    // arrive: a server that sends 200 + headers promptly but then stalls the body (never finishes
    // an SSE event, dribbles a JSON response) must still be caught by discoveryTimeoutMs/
    // callTimeoutMs. Node's fetch keeps the body stream tied to the same AbortSignal through body
    // consumption, so aborting here still interrupts an in-progress readSseJsonRpcResponse/
    // response.json() — cleared in `finally` so it covers every exit path.
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const asTimeoutOrError = (error: any) =>
      error?.name === 'AbortError' ? new Error(`délai dépassé (${method})`) : error instanceof Error ? error : new Error(String(error));
    try {
      let response: Response;
      try {
        response = await fetch(target.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: controller.signal });
      } catch (error: any) {
        const wrapped = asTimeoutOrError(error);
        startupError = startupError ?? wrapped;
        throw wrapped;
      }
      if (!response.ok) {
        const error = new Error(`serveur MCP distant : HTTP ${response.status}`);
        startupError = startupError ?? error;
        throw error;
      }
      const returnedSessionId = response.headers.get('mcp-session-id');
      if (returnedSessionId) sessionId = returnedSessionId;
      const contentType = response.headers.get('content-type') || '';
      let message: any;
      try {
        message = contentType.includes('text/event-stream') ? await readSseJsonRpcResponse(response, id) : await response.json();
      } catch (error: any) {
        const wrapped = asTimeoutOrError(error);
        startupError = startupError ?? wrapped;
        throw wrapped;
      }
      if (message?.error) throw new Error(message.error.message || 'Erreur MCP');
      return message?.result;
    } finally {
      clearTimeout(timer);
    }
  }
  // No persistent connection to tear down over HTTP; an idle session simply expires server-side —
  // matches the stdio session's own "ephemeral, closed right after use" design, just with nothing
  // to actively close on this side.
  async function close() { /* no-op */ }
  return { request, close, alive: () => startupError === null };
}

function openSession(target: McpTarget, timeoutMs: number, kept = false): Session {
  return isRemoteTarget(target) ? openRemoteSession(target, timeoutMs) : openStdioSession(target, timeoutMs, kept);
}

async function handshake(session: Session): Promise<Session> {
  try {
    await session.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'openagent', version: '1.0' } });
  } catch (error) {
    await session.close();
    throw error;
  }
  return session;
}

async function initialize(target: McpTarget, timeoutMs: number): Promise<Session> {
  return handshake(openSession(target, timeoutMs));
}

/** What makes two kept sessions one: the whole target, env included. Secrets are in it: it is never logged. A stdio
 * server is spawned with nothing else of a project's (no cwd of its own), so an identical target is an identical process. */
export const mcpTargetKey = (target: McpTarget): string => JSON.stringify(target);

interface KeptSession {
  target: McpTarget;
  session: Session;
  ready: Promise<Session>;
  idle: NodeJS.Timeout;
}

/** One live session per target, kept between turns and calls (lever mcpKeepAlive). Its processes are also in
 * liveChildren, so stopAllMcpServers reaches them. */
export class McpPool {
  private readonly idleMs: number;
  private readonly kept = new Map<string, KeptSession>();
  /** The targets opened and not closed by closeWhere since. */
  private readonly known = new Map<string, McpTarget>();
  /** Closed by closeWhere (removed, changed, no longer trusted): a turn still holding the tools must not start it again. */
  private readonly retired = new Set<string>();
  private closing = false;

  constructor({ idleMs = 600_000 }: { idleMs?: number } = {}) {
    this.idleMs = idleMs;
  }

  /** The live session of this exact target, opened and initialised once; a dead one is reopened. For a discovery: it
   * follows the current configuration, so it may bring back a target closeWhere retired. */
  async session(target: McpTarget, timeoutMs: number): Promise<Session> {
    const key = mcpTargetKey(target);
    this.retired.delete(key);
    return this.live(key, target, timeoutMs);
  }

  /** The same for a tool call, from tools a discovery gave earlier: refused if the server has been retired since. */
  async sessionForCall(target: McpTarget, timeoutMs: number): Promise<Session> {
    const key = mcpTargetKey(target);
    if (this.retired.has(key)) throw new Error('serveur MCP arrêté (retiré, configuration changée ou projet non approuvé)');
    return this.live(key, target, timeoutMs);
  }

  /** Synchronous up to the map insert: concurrent callers for a target share one process, its promise. */
  private live(key: string, target: McpTarget, timeoutMs: number): Promise<Session> {
    if (this.closing) return Promise.reject(new Error('application en cours de fermeture'));
    const current = this.kept.get(key);
    if (current?.session.alive()) {
      current.idle.refresh();
      return current.ready;
    }
    if (current) void this.drop(key, current);
    this.known.set(key, target);
    const session = openSession(target, timeoutMs, true);
    const entry: KeptSession = {
      target, session, ready: handshake(session),
      // unref: an unused session's timer never keeps the worker alive.
      idle: setTimeout(() => void this.drop(key, entry), this.idleMs).unref(),
    };
    // A failed start is not kept: the next caller tries again.
    entry.ready = entry.ready.catch(error => { void this.drop(key, entry); throw error; });
    this.kept.set(key, entry);
    return entry.ready;
  }

  private async drop(key: string, entry: KeptSession): Promise<void> {
    clearTimeout(entry.idle);
    if (this.kept.get(key) === entry) this.kept.delete(key);
    await entry.session.close();
  }

  /** Ends this session if it is still the target's: a call stopped or timed out, a discovery with no answer. */
  async discard(target: McpTarget, session: Session): Promise<void> {
    const key = mcpTargetKey(target);
    const entry = this.kept.get(key);
    if (entry?.session === session) await this.drop(key, entry);
  }

  async closeWhere(predicate: (target: McpTarget) => boolean): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const [key, target] of this.known) {
      if (!predicate(target)) continue;
      this.known.delete(key);
      this.retired.add(key);
      const entry = this.kept.get(key);
      if (entry) closing.push(this.drop(key, entry));
    }
    await Promise.all(closing);
  }

  /** Ends every session; none opens afterwards. */
  async closeAll(): Promise<void> {
    this.closing = true;
    await this.closeWhere(() => true);
  }
}

interface McpRemoteTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** One configured server's discovery: the tools it exposed, or why it failed (the bare reason — the caller knows
 * which server it is). worker.mjs remembers it for the Outils tab, which never starts a server itself (parity row 33). */
export interface McpServerOutcome {
  target: McpTarget;
  tools: AgentTool[] | null;
  error: string | null;
}

/** Discovers every configured server's tools in parallel, isolating a broken/slow/crashing server
 * from the rest — one bad entry in the MCP config must never keep the others from loading, the
 * same isolation agent.py's own try/except-per-server already had. Works identically for stdio and
 * remote (sse/http) targets. `servers` holds one outcome per target, in `targets` order; a server's
 * `tools` are the very objects listed in `tools`. With `pool`, a stdio server is discovered and called on its kept
 * session and nothing is closed here; a remote one has no process to keep and goes on as without a pool. */
export async function mcpTools(
  targets: McpTarget[],
  options: { discoveryTimeoutMs?: number; callTimeoutMs?: number; pool?: McpPool } = {},
): Promise<{ tools: AgentTool[]; errors: string[]; servers: McpServerOutcome[] }> {
  const discoveryTimeoutMs = options.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
  const errors: string[] = [];
  const servers = await Promise.all(targets.map(async (target): Promise<McpServerOutcome> => {
    const failed = (reason: string, label = targetLabel(target)) => {
      errors.push(`MCP ${label}: ${reason}`);
      return { target, tools: null, error: reason };
    };
    const missing = isRemoteTarget(target) ? !target.url?.trim() : !target.command?.trim();
    if (missing) return failed(`${isRemoteTarget(target) ? 'URL' : 'commande'} absente`, '');
    const pool = isRemoteTarget(target) ? undefined : options.pool;
    for (let retry = pool !== undefined; ; retry = false) {
      let session: Session;
      try {
        session = pool ? await pool.session(target, discoveryTimeoutMs) : await initialize(target, discoveryTimeoutMs);
      } catch (error) {
        return failed(error instanceof Error ? error.message : String(error));
      }
      try {
        const result = await session.request('tools/list', {}, discoveryTimeoutMs);
        const remote: McpRemoteTool[] = Array.isArray(result?.tools) ? result.tools : [];
        return { target, tools: remote.filter(t => typeof t.name === 'string' && t.name).map(t => toAgentTool(target, t, callTimeoutMs, pool)), error: null };
      } catch (error) {
        if (pool && !(error instanceof McpAnswerError)) {
          const died = !session.alive();
          await pool.discard(target, session);
          // Dead before its death was seen here: one new process. One that is alive and silent is not started again.
          if (retry && died) continue;
        }
        return failed(error instanceof Error ? error.message : String(error));
      } finally {
        if (!pool) await session.close();
      }
    }
  }));
  return { tools: servers.flatMap(server => server.tools ?? []), errors, servers };
}

function toAgentTool(target: McpTarget, remote: McpRemoteTool, callTimeoutMs: number, pool?: McpPool): AgentTool {
  const name = `mcp_${remote.name}`;
  const parameters = remote.inputSchema && typeof remote.inputSchema === 'object'
    ? remote.inputSchema
    : { type: 'object', properties: {} };
  return {
    name,
    description: remote.description || `Outil MCP ${remote.name}`,
    category: 'extension',
    parameters,
    validate(args) {
      object(args);
      if (JSON.stringify(args).length > MAX_ARGS_BYTES) throw new Error('Arguments trop volumineux');
      // Structural validation beyond "is an object" is left to the MCP server itself: its
      // inputSchema is arbitrary JSON Schema, and this app has no general-purpose JSON-Schema
      // validator — a bad call fails clearly with the server's own error instead of ours.
    },
    async execute(args, signal) {
      const session = pool ? await pool.sessionForCall(target, callTimeoutMs) : await initialize(target, callTimeoutMs);
      try {
        const aborted = new Promise<never>((_, reject) => {
          if (signal.aborted) { reject(signal.reason); return; }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        const result: any = await Promise.race([session.request('tools/call', { name: remote.name, arguments: args }, callTimeoutMs), aborted]);
        const content = result?.content;
        if (Array.isArray(content)) {
          return content.map(part => (typeof part?.text === 'string' ? part.text : JSON.stringify(part))).join('\n') || 'OK (pas de sortie)';
        }
        return typeof content === 'string' ? content : JSON.stringify(content ?? result ?? {});
      } catch (error) {
        // A call stopped or timed out ends its process, as it does without a pool: the server must not go on working
        // for nobody. The server's own « this call failed » leaves it running.
        if (pool && !(error instanceof McpAnswerError)) await pool.discard(target, session);
        throw error;
      } finally {
        if (!pool) await session.close();
      }
    },
  };
}
