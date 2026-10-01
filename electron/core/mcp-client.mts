import { spawn } from 'node:child_process';
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

interface Session {
  request(method: string, params?: unknown): Promise<any>;
  close(): Promise<void>;
}

/** A short-lived JSON-RPC 2.0 session over stdio — one per discovery, one per call, exactly like
 * mcp_client/adapter.py's own _discover/_invoke (never a persistent connection). */
function openStdioSession(target: McpServerTarget, timeoutMs: number): Session {
  const child = spawn(target.command, target.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...target.env },
    windowsHide: true,
  });
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
      if (message.error) waiting.reject(new Error(message.error.message || 'Erreur MCP'));
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

  function request(method: string, params?: unknown): Promise<any> {
    if (startupError) return Promise.reject(startupError);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`délai dépassé (${method})`)); }, timeoutMs);
      pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
      catch (error: any) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  async function close() {
    try { child.stdin.end(); } catch { /* already gone */ }
    await killTree(child).catch(() => {});
  }
  return { request, close };
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

  async function request(method: string, params?: unknown): Promise<any> {
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
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
  return { request, close };
}

function openSession(target: McpTarget, timeoutMs: number): Session {
  return isRemoteTarget(target) ? openRemoteSession(target, timeoutMs) : openStdioSession(target, timeoutMs);
}

async function initialize(target: McpTarget, timeoutMs: number): Promise<Session> {
  const session = openSession(target, timeoutMs);
  try {
    await session.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'openagent', version: '1.0' } });
  } catch (error) {
    await session.close();
    throw error;
  }
  return session;
}

interface McpRemoteTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Discovers every configured server's tools in parallel, isolating a broken/slow/crashing server
 * from the rest — one bad entry in the MCP config must never keep the others from loading, the
 * same isolation agent.py's own try/except-per-server already had. Works identically for stdio and
 * remote (sse/http) targets. */
export async function mcpTools(
  targets: McpTarget[],
  options: { discoveryTimeoutMs?: number; callTimeoutMs?: number } = {},
): Promise<{ tools: AgentTool[]; errors: string[] }> {
  const discoveryTimeoutMs = options.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
  const errors: string[] = [];
  const perServer = await Promise.all(targets.map(async target => {
    const missing = isRemoteTarget(target) ? !target.url?.trim() : !target.command?.trim();
    if (missing) { errors.push(`MCP : ${isRemoteTarget(target) ? 'URL' : 'commande'} absente`); return []; }
    let session: Session;
    try {
      session = await initialize(target, discoveryTimeoutMs);
    } catch (error) {
      errors.push(`MCP ${targetLabel(target)}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    try {
      const result = await session.request('tools/list', {});
      const remote: McpRemoteTool[] = Array.isArray(result?.tools) ? result.tools : [];
      return remote.filter(t => typeof t.name === 'string' && t.name).map(t => toAgentTool(target, t, callTimeoutMs));
    } catch (error) {
      errors.push(`MCP ${targetLabel(target)}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    } finally {
      await session.close();
    }
  }));
  return { tools: perServer.flat(), errors };
}

function toAgentTool(target: McpTarget, remote: McpRemoteTool, callTimeoutMs: number): AgentTool {
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
      const session = await initialize(target, callTimeoutMs);
      try {
        const aborted = new Promise<never>((_, reject) => {
          if (signal.aborted) { reject(signal.reason); return; }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        const result: any = await Promise.race([session.request('tools/call', { name: remote.name, arguments: args }), aborted]);
        const content = result?.content;
        if (Array.isArray(content)) {
          return content.map(part => (typeof part?.text === 'string' ? part.text : JSON.stringify(part))).join('\n') || 'OK (pas de sortie)';
        }
        return typeof content === 'string' ? content : JSON.stringify(content ?? result ?? {});
      } finally {
        await session.close();
      }
    },
  };
}
