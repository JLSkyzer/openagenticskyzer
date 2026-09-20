interface RoleContent {
  role: string;
  content: string;
}

export interface ContextUsage {
  tokens: number;
  pct: number;
}

// Copied from utils.py::_DEFAULT_CTX_LIMITS (the NiceGUI app) — context windows the app assumes
// when the user has not set max_tokens. Local providers default to a small window on purpose.
export const CONTEXT_WINDOWS: Record<string, number> = {
  together: 128_000,
  groq: 128_000,
  mistral: 32_000,
  gemini: 1_000_000,
  openrouter: 128_000,
  ollama: 32_000,
  lmstudio: 32_000,
  llamacpp: 32_000,
};
const DEFAULT_WINDOW = 32_000;
// Provider-less fallback of storage.py::compute_context_pct.
const DEFAULT_PROVIDER = 'ollama';

// Python's len() counts characters, JS's .length counts UTF-16 units: an emoji would weigh 2.
function characters(text: string): number {
  return text.length - (text.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0);
}

// storage.py::compute_context_pct: user + assistant text only, 4 characters per token. Tool
// outputs are left out like in the original, so this underestimates what the model really receives.
export function estimateTokens(messages: readonly RoleContent[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'assistant' || message.role === 'human' || message.role === 'ai') {
      total += characters(message.content);
    }
  }
  return Math.floor(total / 4);
}

export function contextLimit(provider: string | null, maxTokens: number | null, reservedTokens: number): number {
  const window = CONTEXT_WINDOWS[provider ?? DEFAULT_PROVIDER] ?? DEFAULT_WINDOW;
  return Math.max(1, (maxTokens || window) - reservedTokens);
}

export function computeContext(
  messages: readonly RoleContent[],
  settings: { provider: string | null; max_tokens: number | null; reserved_tokens: number },
): ContextUsage {
  const tokens = estimateTokens(messages);
  const limit = contextLimit(settings.provider, settings.max_tokens, settings.reserved_tokens);
  return { tokens, pct: Math.min(100, (tokens / limit) * 100) };
}

export type ContextLevel = 'normal' | 'warning' | 'critical';

// context_bar.py: purple under 70 %, yellow under 90 %, red beyond.
export function contextLevel(pct: number): ContextLevel {
  return pct < 70 ? 'normal' : pct < 90 ? 'warning' : 'critical';
}

export function shouldCompact(pct: number, threshold: number): boolean {
  return pct >= threshold;
}

// input_bar.py: the automatic compaction needs the setting AND the threshold; the manual button
// (shouldCompact alone) does not depend on the setting.
export function shouldAutoCompact(settings: { auto_compact: boolean; compact_threshold: number }, pct: number): boolean {
  return settings.auto_compact && shouldCompact(pct, settings.compact_threshold);
}

export function formatContextLabel(usage: ContextUsage): string {
  return `${Math.round(usage.pct)}% · ~${usage.tokens.toLocaleString('en-US')} tokens`;
}
