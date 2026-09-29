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

const DISCOVERY_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 60_000;
const MAX_ARGS_BYTES = 1024 * 1024;

/** A short-lived JSON-RPC 2.0 session over stdio — one per discovery, one per call, exactly like
 * mcp_client/adapter.py's own _discover/_invoke (never a persistent connection). */
function openSession(target: McpServerTarget, timeoutMs: number) {
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

async function initialize(target: McpServerTarget, timeoutMs: number) {
  const session = openSession(target, timeoutMs);
  try {
    await session.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'openagent', version: '1.0' } });
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
 * same isolation agent.py's own try/except-per-server already had. */
export async function mcpTools(
  targets: McpServerTarget[],
  options: { discoveryTimeoutMs?: number; callTimeoutMs?: number } = {},
): Promise<{ tools: AgentTool[]; errors: string[] }> {
  const discoveryTimeoutMs = options.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
  const errors: string[] = [];
  const perServer = await Promise.all(targets.map(async target => {
    if (!target.command?.trim()) { errors.push('MCP : commande absente'); return []; }
    let session;
    try {
      session = await initialize(target, discoveryTimeoutMs);
    } catch (error) {
      errors.push(`MCP ${target.command}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    try {
      const result = await session.request('tools/list', {});
      const remote: McpRemoteTool[] = Array.isArray(result?.tools) ? result.tools : [];
      return remote.filter(t => typeof t.name === 'string' && t.name).map(t => toAgentTool(target, t, callTimeoutMs));
    } catch (error) {
      errors.push(`MCP ${target.command}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    } finally {
      await session.close();
    }
  }));
  return { tools: perServer.flat(), errors };
}

function toAgentTool(target: McpServerTarget, remote: McpRemoteTool, callTimeoutMs: number): AgentTool {
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
