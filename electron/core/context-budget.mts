// ONE source for the context budget and the token estimate. The worker sizes every request with it
// (core/request-context.mts, through agent.mts) and the renderer's gauge imports this file as is
// (renderer-src/src/state/context.ts — Vite bundles it). It must stay pure: no import at all.

// The context size the built-in engine runs a small model with at least (core/local-engine.mts), and the window
// assumed for the active .gguf before its engine has loaded (core/active-model.mts::modelStatus).
export const MIN_LOCAL_CONTEXT = 16_384;

/** The window a request must fit in: the engine's real context size, capped by the user's max_tokens when set. */
export function effectiveWindow(engineWindow: number, maxTokens: number | null): number {
  return maxTokens ? Math.min(engineWindow, maxTokens) : engineWindow;
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
