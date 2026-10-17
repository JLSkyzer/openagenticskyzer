// ONE source for the context windows and the token estimate. The worker sizes every request with it
// (core/request-context.mts, through agent.mts) and the renderer's gauge imports this file as is
// (renderer-src/src/state/context.ts — Vite bundles it). It must stay pure: no import at all.

// utils.py::_DEFAULT_CTX_LIMITS (the NiceGUI app): the window assumed when the user has not set max_tokens.
// Only the online providers: a local .gguf model is sized by its own engine (worker.mjs), not by this table.
export const CONTEXT_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  together: 128_000, groq: 128_000, mistral: 32_000, gemini: 1_000_000,
  openrouter: 128_000,
});
// No provider known, or one the app no longer offers: the window of the app's default provider.
const DEFAULT_PROVIDER = 'openrouter';

/** The window in tokens: the user's max_tokens when set, else the provider's entry, else openrouter's (128 000). */
export function contextWindow(provider: string | null, maxTokens: number | null): number {
  if (maxTokens) return maxTokens;
  const id = provider !== null && Object.hasOwn(CONTEXT_WINDOWS, provider) ? provider : DEFAULT_PROVIDER;
  return CONTEXT_WINDOWS[id];
}

/** What a request may use: the window minus reserved_tokens (kept free for the answer), never below 1. */
export function contextBudget(window: number, reservedTokens: number): number {
  return Math.max(1, window - reservedTokens);
}

/** Characters as Python's len() counts them: an emoji (two UTF-16 units) is one. */
export function characters(text: string): number {
  return text.length - (text.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0);
}

/** 4 characters per token, rounded down like Python's //. */
export function tokensFor(characterCount: number): number {
  return Math.floor(characterCount / 4);
}
