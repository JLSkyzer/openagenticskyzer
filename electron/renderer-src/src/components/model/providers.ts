import type { ProviderName } from '../../ipc/types';

// Mirrors core/connections.mts::providers (default endpoint per provider).
// Online providers only: local models are the .gguf files of the app's own library.
export const PROVIDERS: Array<{ id: ProviderName; label: string; url: string }> = [
  { id: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
  { id: 'together', label: 'Together AI', url: 'https://api.together.xyz/v1' },
  { id: 'groq', label: 'Groq', url: 'https://api.groq.com/openai/v1' },
  { id: 'mistral', label: 'Mistral', url: 'https://api.mistral.ai/v1' },
  { id: 'gemini', label: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai' },
];

export const defaultUrl = (provider: string) => PROVIDERS.find(entry => entry.id === provider)?.url ?? '';
