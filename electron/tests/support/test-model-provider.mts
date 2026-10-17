// TEST-ONLY model client. worker.mjs imports this module only when its workerData carries testProviderModule,
// which main.cjs never sets (workerOptions, proven by tests/test-seam.test.mts) and tests/** is never packaged.
// It speaks the OpenAI chat protocol to the tests' own fake servers, and to nothing else: any base_url that is
// not http://127.0.0.1 is refused.
import { fileURLToPath } from 'node:url';
import { ChatProvider, type ChatMessage, type ToolSchema } from '../../core/provider.mts';

export interface TestModelSpec {
  base_url: string; model?: string; contextWindow?: number; outputCap?: number;
  idleTimeoutMs?: number; retryDelaysMs?: readonly number[];
}

// The window the former 'test' provider had: an id absent from the table got openrouter's default.
export const TEST_MODEL_DEFAULT_WINDOW = 128_000;
export const TEST_PROVIDER_MODULE: string = fileURLToPath(import.meta.url);

export function createTestProvider(spec: TestModelSpec) {
  let url: URL | undefined;
  try { url = new URL(spec?.base_url); } catch { /* refused below */ }
  if (!url || url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw new Error('Fournisseur de test : seule une adresse http://127.0.0.1 est acceptée');
  }
  const client = new ChatProvider(fetch, { idleTimeoutMs: spec.idleTimeoutMs, retryDelaysMs: spec.retryDelaysMs });
  const connection = { provider: 'test', model: spec.model ?? 'test-model', base_url: spec.base_url, api_key: '' };
  return {
    complete(options: { messages: ChatMessage[]; tools?: ToolSchema[]; signal?: AbortSignal; onDelta?: (text: string) => void; maxTokens?: number }): Promise<ChatMessage & { content: string }> {
      const { messages, tools, signal, onDelta, maxTokens } = options;
      return client.complete({ connection, messages, tools, signal, onDelta, maxTokens });
    },
    contextWindow: async (): Promise<number> => spec.contextWindow ?? TEST_MODEL_DEFAULT_WINDOW,
    outputCap: (): number | undefined => spec.outputCap,
  };
}

/** Worker options for a test: an isolated data home, plus the seam. */
export function testWorkerOptions(home: string, env: Record<string, string> = {}): { env: NodeJS.ProcessEnv; workerData: { testProviderModule: string } } {
  return { env: { ...process.env, OPENAGENT_HOME: home, ...env }, workerData: { testProviderModule: TEST_PROVIDER_MODULE } };
}
