import type { ProviderName } from '../../ipc/types';

// Mirrors core/connections.mts::providers (default endpoint per provider).
export const PROVIDERS: Array<{ id: ProviderName; label: string; url: string; local: boolean }> = [
  { id: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', local: false },
  { id: 'together', label: 'Together AI', url: 'https://api.together.xyz/v1', local: false },
  { id: 'groq', label: 'Groq', url: 'https://api.groq.com/openai/v1', local: false },
  { id: 'mistral', label: 'Mistral', url: 'https://api.mistral.ai/v1', local: false },
  { id: 'gemini', label: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai', local: false },
  { id: 'ollama', label: 'Ollama (local)', url: 'http://localhost:11434/v1', local: true },
  { id: 'lmstudio', label: 'LM Studio (local)', url: 'http://localhost:1234/v1', local: true },
  { id: 'llamacpp', label: 'llama.cpp (local)', url: 'http://localhost:8080/v1', local: true },
];

export const defaultUrl = (provider: string) => PROVIDERS.find(entry => entry.id === provider)?.url ?? '';
