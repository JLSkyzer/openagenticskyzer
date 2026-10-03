import { ChatProvider } from './provider.mts';
import type { ChatMessage, ModelConnection } from './provider.mts';
import { object } from './json-store.mts';
import { fitToBudget, requestMessages } from './request-context.mts';
import { contextBudget } from './context-budget.mts';

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
  // The model's context window in tokens (core/context-budget.mts). Absent: no budget is applied.
  contextWindow?: number;
  confirm: (request: { tool: string; arguments: Record<string, unknown> }, signal: AbortSignal) => Promise<boolean>;
  emit?: (event: { type: string; [key: string]: unknown }) => void;
}

/** The one rule for a tool name, from any source. Exported so the plugin loader rejects a bad name
 * up front (one file's error) instead of letting it reach runAgent, which fails the whole turn. */
export const TOOL_NAME_PATTERN = /^[\w.-]{1,128}$/;
/** Model calls per turn. Python's recursion_limit of 300 graph steps is about 150 calls (audit H2). */
export const DEFAULT_MAX_STEPS = 100;
export const MAX_STEPS_LIMIT = 150;
export const TRUNCATED_NOTICE = '[Réponse tronquée : limite de sortie atteinte]';
export const TRUNCATED_ARGUMENTS = 'arguments tronqués par la limite de sortie — découpe le travail en appels plus petits';

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
  // The "Exécution shell" setting: only an explicit false skips the prompt (unset asks). Plan,
  // ask and strict were already denied above, so this can never widen them.
  if (tool.category === 'shell' && settings.shell_ask === false) return 'allow';
  // Arbitrary extensions always ask unless the user enabled auto mode.
  return 'ask';
}

export async function runAgent(options: AgentOptions): Promise<ChatMessage[]> {
  const { provider, connection, instructions, tools, confirm, emit } = options;
  const settings = structuredClone(options.settings);
  if (!['ask', 'auto', 'plan'].includes(settings.mode) || !['demander', 'auto', 'strict'].includes(settings.permission_mode)) throw new Error('Politique agent invalide');
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_STEPS_LIMIT) throw new Error('Limite de tours invalide');
  const signal = options.signal ?? new AbortController().signal;
  if (options.contextWindow !== undefined && !(Number.isInteger(options.contextWindow) && options.contextWindow > 0)) throw new Error('Fenêtre de contexte invalide');
  const budgetTokens = options.contextWindow === undefined ? undefined : contextBudget(options.contextWindow, settings.reserved_tokens ?? 0);
  const messages: ChatMessage[] = [{ role: 'system', content: instructions }, ...structuredClone(options.messages.filter(m => m.role !== 'system'))];
  const registry = new Map<string, AgentTool>();
  for (const tool of tools) {
    if (!TOOL_NAME_PATTERN.test(tool.name) || registry.has(tool.name)) throw new Error('Nom outil invalide ou dupliqué');
    registry.set(tool.name, tool);
  }
  const schemas = tools.filter(tool => policy(tool, settings) !== 'deny').map(tool => ({
    type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  const executed = new Set<string>();
  // A loop is the SAME call repeated back to back. Counting identical calls over the whole run
  // (as before) refused a legitimate git_status before and after every edit; alternating
  // between calls is bounded by maxSteps instead.
  let lastSignature = '';
  let streak = 0;
  for (let step = 0; step < maxSteps; step++) {
    signal.throwIfAborted();
    emit?.({ type: 'turn', step });
    // `messages` keeps the saved shape (files beside the typed text); the request is built here (H3): earlier
    // turns condensed, the turn in progress whole with its files expanded, fitted to the budget — or
    // CONTEXT_FULL, sending nothing. No maxTokens: the provider applies its own cap (provider.mts::outputCap);
    // reserved_tokens only sizes the context budget now (H1).
    const outgoing = requestMessages(messages.slice(1));
    const fitted = budgetTokens === undefined ? outgoing : fitToBudget(outgoing, { system: instructions, tools: schemas, budgetTokens });
    const answer = await provider.complete({ connection, messages: [messages[0], ...fitted], tools: schemas, signal,
      onDelta: text => emit?.({ type: 'delta', text }),
    });
    signal.throwIfAborted();
    // The cut is the provider's report: the conversation keeps a visible notice, never the flag itself.
    const { truncated, ...reply } = answer;
    if (truncated) reply.content = reply.content ? `${reply.content}\n\n${TRUNCATED_NOTICE}` : TRUNCATED_NOTICE;
    messages.push(reply); emit?.({ type: 'message', message: reply });
    if (!reply.tool_calls?.length) return messages.slice(1);
    for (const call of reply.tool_calls) {
      signal.throwIfAborted();
      let output: string;
      try {
        // A call cut by the output limit has incomplete arguments: never executed, whatever the permissions.
        if (truncated) throw new Error(TRUNCATED_ARGUMENTS);
        const tool = registry.get(call.function.name);
        if (!tool) throw new Error('Outil inconnu : exécution refusée');
        if (executed.has(call.id)) throw new Error('Appel outil dupliqué : exécution refusée');
        executed.add(call.id);
        const signature = call.function.name + ':' + call.function.arguments;
        streak = signature === lastSignature ? streak + 1 : 1; lastSignature = signature;
        if (streak > 3) throw new Error('Boucle d’outils détectée : exécution refusée');
        // The refusal names the field and the rule (tool-kit.mts), so the model can fix its call.
        let args: Record<string, unknown>;
        try { args = JSON.parse(call.function.arguments); }
        catch { throw new Error(`Arguments invalides pour ${tool.name} : JSON illisible`); }
        try { object(args); tool.validate(args); }
        catch (e) { throw new Error(`Arguments invalides pour ${tool.name} : ${e instanceof Error ? e.message : 'refusés'}`); }
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
  throw new Error(`Limite de tours atteinte (${maxSteps} appels au modèle). La génération a été arrêtée — réponds « continue » pour reprendre.`);
}
