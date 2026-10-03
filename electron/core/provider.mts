import { endpoint } from './connections.mts';

export interface ToolCall {
  id: string; type: 'function'; function: { name: string; arguments: string };
  extra_content?: unknown;
}
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'; content: string | unknown[] | null;
  tool_call_id?: string; tool_calls?: ToolCall[]; reasoning_details?: unknown[];
  // A user message's files, kept beside what was typed (see attachments.mts). Never sent as such: they are
  // expanded into `content` (toWireMessage) just before the provider is called.
  attachments?: unknown[];
  // Set on a reply the output limit cut (finish_reason "length"). agent.mts turns it into a visible notice;
  // the flag itself is never stored nor sent back to a provider.
  truncated?: boolean;
}
export interface ModelConnection { provider: string; model: string; base_url: string; api_key: string }
export interface ToolSchema { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface CompletionOptions {
  connection: ModelConnection; messages: ChatMessage[]; tools?: ToolSchema[];
  signal?: AbortSignal; onDelta?: (text: string) => void;
  // Overrides the output cap of connection.provider (outputCap) when set.
  maxTokens?: number;
}
export interface ProviderOptions {
  // Longest silence tolerated: not a single byte, before the response or between two pieces of the stream.
  idleTimeoutMs?: number;
  // Wait before each new attempt when the provider gives no Retry-After; its length is the number of retries.
  retryDelaysMs?: readonly number[];
}

/** Python's output cap per provider (utils/utils.py:663-791). ollama, and any id not listed, gets none. */
export const OUTPUT_CAPS: Readonly<Record<string, number>> = Object.freeze({
  together: 16384, mistral: 16384, gemini: 16384, openrouter: 16384,
  groq: 8192, lmstudio: 8192, llamacpp: 8192,
});
export function outputCap(provider: string): number | undefined {
  return Object.hasOwn(OUTPUT_CAPS, provider) ? OUTPUT_CAPS[provider] : undefined;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = Object.freeze([1000, 3000]);
const MAX_RETRY_AFTER_MS = 30_000;
const MAX_ERROR_BODY_BYTES = 65_536;
const MAX_DETAIL_CHARS = 500;

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

/** Retry-After in milliseconds (seconds or an HTTP date), capped at 30 s; null when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.min(Math.max(0, date - now), MAX_RETRY_AFTER_MS);
}

const mask = (text: string, apiKey: string) => (apiKey ? text.split(apiKey).join('***') : text);

/**
 * The provider's own explanation, safe to show: `error.message` of a JSON body (an `error` string too, as
 * Ollama sends), else the raw text; the connection's API key masked BEFORE the cut, so not even a fragment
 * of it survives; whitespace collapsed; 500 characters at most.
 */
export function errorDetail(raw: string, apiKey: string): string {
  let text = raw;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.error?.message === 'string') text = parsed.error.message;
    else if (typeof parsed?.error === 'string') text = parsed.error;
  } catch { /* not JSON: the raw text is the message */ }
  return mask(text, apiKey).replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_CHARS);
}

function providerMessage(status: number | string, detail: string): string {
  const hint = status === 401 ? 'authentification refusée, vérifiez la connexion du projet' : status === 429 ? 'quota ou limite de débit atteint' : '';
  const text = [detail, hint].filter(Boolean).join(' — ');
  return text ? `Erreur du provider (${status}) : ${text}` : `Erreur du provider (${status}).`;
}

export class ProviderError extends Error {
  status: number; retryAfter: number | null;
  constructor(status: number, retryAfter: string | null, detail = '') {
    super(providerMessage(status, detail));
    this.status = status;
    this.retryAfter = retryAfter && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : null;
  }
}

const retryable = (status: number) => status === 408 || status === 409 || status === 429 || status >= 500;
// A connection refused, reset or cut before any byte: undici reports a TypeError whose cause carries a system
// or undici code (ECONNREFUSED, UND_ERR_SOCKET…). A refused redirect (redirect: 'error') has no code: never retried.
const networkFailure = (error: unknown) =>
  error instanceof TypeError && typeof (error.cause as { code?: unknown } | undefined)?.code === 'string';

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}

async function readErrorBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_ERROR_BODY_BYTES) {
      const part = await reader.read();
      if (part.done) break;
      parts.push(part.value);
      size += part.value.length;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(parts).subarray(0, MAX_ERROR_BODY_BYTES).toString('utf8');
}

export class ChatProvider {
  private fetcher: typeof fetch;
  private idleTimeoutMs: number;
  private retryDelaysMs: readonly number[];
  constructor(fetcher: typeof fetch = fetch, options: ProviderOptions = {}) {
    this.fetcher = fetcher;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  async complete(options: CompletionOptions): Promise<ChatMessage & { content: string }> {
    const { connection, messages, tools } = options;
    if (!connection.model.trim()) throw new Error('Choisissez un modèle dans les paramètres de connexion');
    const userSignal = options.signal ?? new AbortController().signal;
    userSignal.throwIfAborted();
    // Silence watchdog: re-armed by every byte, so a slow but living stream is never cut (the former fixed
    // 300 s cap killed long local generations).
    const idle = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const quiet = () => clearTimeout(timer);
    const touch = () => { quiet(); timer = setTimeout(() => idle.abort(), this.idleTimeoutMs); };
    const signal = AbortSignal.any([userSignal, idle.signal]);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
    if (connection.api_key) headers.Authorization = `Bearer ${connection.api_key}`;
    const body: Record<string, unknown> = { model: connection.model, messages, stream: true };
    if (tools?.length) body.tools = tools;
    const cap = options.maxTokens ?? outputCap(connection.provider);
    if (cap !== undefined) body.max_tokens = cap;
    const init: RequestInit = { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal };
    try {
      const response = await this.open(endpoint(connection.base_url) + '/chat/completions', init, userSignal, connection.api_key, touch, quiet);
      return await this.read(response, signal, touch, connection.api_key, options.onDelta);
    } catch (error) {
      if (idle.signal.aborted && !userSignal.aborted) throw new Error(`Le fournisseur ne répond plus (${this.idleTimeoutMs / 1000} s)`);
      throw error;
    } finally { quiet(); }
  }

  /** The response, after up to retryDelaysMs.length new attempts on a network failure or a 408/409/429/5xx. */
  private async open(url: string, init: RequestInit, userSignal: AbortSignal, apiKey: string, touch: () => void, quiet: () => void): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      touch();
      let response: Response;
      try {
        response = await this.fetcher(url, init);
      } catch (error) {
        if (!networkFailure(error) || attempt >= this.retryDelaysMs.length) throw error;
        quiet();
        await pause(this.retryDelaysMs[attempt], userSignal);
        continue;
      }
      if (response.ok) return response;
      const retryAfter = response.headers.get('retry-after');
      const failure = new ProviderError(response.status, retryAfter, errorDetail(await readErrorBody(response), apiKey));
      if (!retryable(response.status) || attempt >= this.retryDelaysMs.length) throw failure;
      quiet();
      await pause(retryAfterMs(retryAfter) ?? this.retryDelaysMs[attempt], userSignal);
    }
  }

  private async read(response: Response, signal: AbortSignal, touch: () => void, apiKey: string, onDelta?: (text: string) => void): Promise<ChatMessage & { content: string }> {
    if (!response.body) throw new Error('Réponse vide du provider');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const jsonResponse = response.headers.get('content-type')?.includes('application/json');
    let buffer = ''; let total = 0; let content = ''; let done = false; let finished = false; let truncated = false;
    const calls = new Map<number, ToolCall>();
    const reasoning: unknown[] = [];
    const accept = (data: string) => {
      if (data.trim() === '[DONE]') { done = true; return; }
      let chunk: any;
      try { chunk = JSON.parse(data); } catch { throw new Error('Réponse JSON invalide du provider'); }
      if (chunk.error) {
        const code = typeof chunk.error?.code === 'number' || typeof chunk.error?.code === 'string' ? mask(String(chunk.error.code), apiKey).slice(0, 40) : 'flux';
        throw new Error(providerMessage(code, errorDetail(data, apiKey)));
      }
      const choice = chunk.choices?.[0];
      if (!choice) return; // usage-only chunks and heartbeat metadata
      if (choice.finish_reason) {
        // "length" = the output cap was reached: what came so far is returned, flagged. Anything else
        // that is not a normal end (content_filter, unknown) stays an error.
        if (choice.finish_reason === 'length') truncated = true;
        else if (!['stop', 'tool_calls', 'function_call'].includes(choice.finish_reason)) throw new Error(`Réponse interrompue par le provider (${String(choice.finish_reason).slice(0, 40)})`);
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
        touch();
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
      if (!content.trim() && !tool_calls.length && !truncated) throw new Error('Réponse vide du provider');
      return {
        role: 'assistant', content,
        ...(tool_calls.length ? { tool_calls } : {}),
        ...(reasoning.length ? { reasoning_details: reasoning } : {}),
        ...(truncated ? { truncated: true } : {}),
      };
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
