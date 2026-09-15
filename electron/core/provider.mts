import { endpoint } from './connections.mts';

export interface ToolCall {
  id: string; type: 'function'; function: { name: string; arguments: string };
  extra_content?: unknown;
}
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'; content: string | unknown[] | null;
  tool_call_id?: string; tool_calls?: ToolCall[]; reasoning_details?: unknown[];
}
export interface ModelConnection { provider: string; model: string; base_url: string; api_key: string }
export interface ToolSchema { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface CompletionOptions {
  connection: ModelConnection; messages: ChatMessage[]; tools?: ToolSchema[];
  signal?: AbortSignal; onDelta?: (text: string) => void; maxTokens?: number;
}

function validateCalls(calls: ToolCall[]) {
  if (calls.length > 64) throw new Error('Trop d’appels outils dans la réponse');
  const ids = new Set<string>();
  for (const call of calls) {
    if (!call || typeof call.id !== 'string' || !call.id || ids.has(call.id) || call.type !== 'function' ||
      !call.function || typeof call.function.name !== 'string' || !/^[\w.-]{1,128}$/.test(call.function.name) ||
      typeof call.function.arguments !== 'string' || call.function.arguments.length > 262144) throw new Error('Appel outil invalide');
    ids.add(call.id);
  }
}
export class ProviderError extends Error {
  status: number; retryAfter: number | null;
  constructor(status: number, retryAfter: string | null) {
    super(status === 401 ? 'Authentification refusée (401). Vérifiez la connexion du projet.' : status === 429 ? 'Quota ou limite de débit atteint (429).' : `Erreur du provider (${status}).`);
    this.status = status;
    this.retryAfter = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
  }
}

export class ChatProvider {
  private fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = fetch) { this.fetcher = fetcher; }
  async complete(options: CompletionOptions): Promise<ChatMessage & { content: string }> {
    const { connection, messages, tools, onDelta } = options;
    if (!connection.model.trim()) throw new Error('Choisissez un modèle dans les paramètres de connexion');
    const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(300000)]);
    signal.throwIfAborted();
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
    if (connection.api_key) headers.Authorization = `Bearer ${connection.api_key}`;
    const body: Record<string, unknown> = { model: connection.model, messages, stream: true };
    if (tools?.length) body.tools = tools;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    const response = await this.fetcher(endpoint(connection.base_url) + '/chat/completions', {
      method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderError(response.status, response.headers.get('retry-after'));
    }
    if (!response.body) throw new Error('Réponse vide du provider');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const jsonResponse = response.headers.get('content-type')?.includes('application/json');
    let buffer = ''; let total = 0; let content = ''; let done = false; let finished = false;
    const calls = new Map<number, ToolCall>();
    const reasoning: unknown[] = [];
    const accept = (data: string) => {
      if (data.trim() === '[DONE]') { done = true; return; }
      let chunk: any;
      try { chunk = JSON.parse(data); } catch { throw new Error('Réponse JSON invalide du provider'); }
      if (chunk.error) throw new Error('Le provider a signalé une erreur pendant le streaming');
      const choice = chunk.choices?.[0];
      if (!choice) return; // usage-only chunks and heartbeat metadata
      if (choice.finish_reason) {
        if (!['stop', 'tool_calls', 'function_call'].includes(choice.finish_reason)) throw new Error('Réponse interrompue par le provider : limite ou filtre');
        finished = true;
      }
      const delta = choice.delta ?? choice.message;
      if (!delta) return;
      if (typeof delta.content === 'string') { content += delta.content; onDelta?.(delta.content); }
      if (Array.isArray(delta.reasoning_details)) reasoning.push(...delta.reasoning_details);
      for (const [position, item] of (delta.tool_calls ?? []).entries()) {
        const index = item.index ?? position;
        if (!Number.isInteger(index) || index < 0 || index >= 64) throw new Error('Index appel outil invalide');
        const call = calls.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (item.id) call.id += item.id;
        if (item.function?.name) call.function.name += item.function.name;
        if (item.function?.arguments) call.function.arguments += item.function.arguments;
        // Gemini's compatibility endpoint can attach thought signatures here.
        if (item.extra_content !== undefined) call.extra_content = item.extra_content;
        calls.set(index, call);
      }
    };
    const flushFrames = () => {
      let match: RegExpExecArray | null;
      while (!done && (match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (data) accept(data);
      }
    };
    try {
      while (!done) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) { buffer += decoder.decode(); break; }
        total += part.value.length;
        if (total > 8 * 1024 * 1024) throw new Error('Réponse provider trop volumineuse');
        buffer += decoder.decode(part.value, { stream: true });
        if (!jsonResponse) flushFrames();
      }
      if (jsonResponse) accept(buffer);
      else flushFrames();
      signal.throwIfAborted();
      if (!done && !finished) throw new Error('Flux interrompu avant la fin de la réponse');
      const tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
      validateCalls(tool_calls);
      if (!content.trim() && !tool_calls.length) throw new Error('Réponse vide du provider');
      return { role: 'assistant', content, ...(tool_calls.length ? { tool_calls } : {}), ...(reasoning.length ? { reasoning_details: reasoning } : {}) };
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
