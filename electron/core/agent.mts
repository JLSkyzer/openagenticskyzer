import { ChatProvider } from './provider.mts';
import type { ChatMessage, ModelConnection } from './provider.mts';
import { object } from './json-store.mts';

export interface AgentTool {
  name: string; description: string; parameters: Record<string, unknown>;
  category: 'read' | 'write' | 'shell' | 'network' | 'extension';
  validate(args: Record<string, unknown>): void;
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}
export interface AgentSettings {
  mode: 'ask' | 'auto' | 'plan'; permission_mode: 'demander' | 'auto' | 'strict';
  files_ask?: boolean; shell_ask?: boolean; search_ask?: boolean; reserved_tokens?: number;
}
export interface AgentOptions {
  provider: ChatProvider; connection: ModelConnection; messages: ChatMessage[]; instructions: string;
  tools: AgentTool[]; settings: AgentSettings; signal?: AbortSignal; maxSteps?: number;
  confirm: (request: { tool: string; arguments: Record<string, unknown> }, signal: AbortSignal) => Promise<boolean>;
  emit?: (event: { type: string; [key: string]: unknown }) => void;
}

async function approval<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true });
  });
  try { return await Promise.race([promise, interrupted]); }
  finally { signal.removeEventListener('abort', cancel); }
}
function policy(tool: AgentTool, settings: AgentSettings): 'allow' | 'ask' | 'deny' {
  if (!['read', 'write', 'shell', 'network', 'extension'].includes(tool.category)) return 'deny';
  if ((settings.mode !== 'auto' || settings.permission_mode === 'strict') && tool.category !== 'read') return 'deny';
  if (settings.permission_mode === 'auto' || tool.category === 'read') return 'allow';
  if (tool.category === 'write' && settings.files_ask === false) return 'allow';
  if (tool.category === 'network' && settings.search_ask === false) return 'allow';
  // Shell and arbitrary extensions always ask unless the user enabled auto mode.
  return 'ask';
}

export async function runAgent(options: AgentOptions): Promise<ChatMessage[]> {
  const { provider, connection, instructions, tools, confirm, emit } = options;
  const settings = structuredClone(options.settings);
  if (!['ask', 'auto', 'plan'].includes(settings.mode) || !['demander', 'auto', 'strict'].includes(settings.permission_mode)) throw new Error('Politique agent invalide');
  const maxSteps = options.maxSteps ?? 24;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) throw new Error('Limite de tours invalide');
  const signal = options.signal ?? new AbortController().signal;
  const messages: ChatMessage[] = [{ role: 'system', content: instructions }, ...structuredClone(options.messages.filter(m => m.role !== 'system'))];
  const registry = new Map<string, AgentTool>();
  for (const tool of tools) {
    if (!/^[\w.-]{1,128}$/.test(tool.name) || registry.has(tool.name)) throw new Error('Nom outil invalide ou dupliqué');
    registry.set(tool.name, tool);
  }
  const schemas = tools.filter(tool => policy(tool, settings) !== 'deny').map(tool => ({
    type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  const executed = new Set<string>();
  const repeated = new Map<string, number>();
  for (let step = 0; step < maxSteps; step++) {
    signal.throwIfAborted();
    emit?.({ type: 'turn', step });
    const answer = await provider.complete({ connection, messages, tools: schemas, signal, maxTokens: settings.reserved_tokens,
      onDelta: text => emit?.({ type: 'delta', text }),
    });
    signal.throwIfAborted();
    messages.push(answer); emit?.({ type: 'message', message: answer });
    if (!answer.tool_calls?.length) return messages.slice(1);
    for (const call of answer.tool_calls) {
      signal.throwIfAborted();
      let output: string;
      try {
        const tool = registry.get(call.function.name);
        if (!tool) throw new Error('Outil inconnu : exécution refusée');
        if (executed.has(call.id)) throw new Error('Appel outil dupliqué : exécution refusée');
        executed.add(call.id);
        const signature = call.function.name + ':' + call.function.arguments;
        const count = (repeated.get(signature) ?? 0) + 1; repeated.set(signature, count);
        if (count > 3) throw new Error('Boucle d’outils détectée : exécution refusée');
        let args: Record<string, unknown>;
        try { args = JSON.parse(call.function.arguments); object(args); tool.validate(args); }
        catch { throw new Error('Arguments outil invalides : exécution refusée'); }
        const decision = policy(tool, settings);
        if (decision === 'deny' || (decision === 'ask' && !await approval(confirm({ tool: tool.name, arguments: structuredClone(args) }, signal), signal))) {
          throw new Error('Exécution refusée par les permissions');
        }
        signal.throwIfAborted();
        emit?.({ type: 'tool-start', id: call.id, tool: tool.name });
        output = await tool.execute(args, signal);
        signal.throwIfAborted();
      } catch (e: any) {
        signal.throwIfAborted();
        output = `Erreur : ${e instanceof Error ? e.message : 'échec de l’outil'}`;
      }
      if (output.length > 50000) output = output.slice(0, 50000) + '\n[Sortie tronquée]';
      const result: ChatMessage = { role: 'tool', tool_call_id: call.id, content: output };
      messages.push(result); emit?.({ type: 'message', message: result });
    }
  }
  throw new Error('Limite de tours atteinte. La génération a été arrêtée.');
}
