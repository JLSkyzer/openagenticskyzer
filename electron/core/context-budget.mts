// ONE source for the context budget and the token estimate. The worker sizes every request with it
// (core/request-context.mts, through agent.mts) and the renderer's gauge imports this file as is
// (renderer-src/src/state/context.ts — Vite bundles it). It must stay pure: no import at all.

// The context size the built-in engine runs a small model with at least (core/local-engine.mts), and the window
// assumed for the active .gguf before its engine has loaded (core/active-model.mts::modelStatus).
export const MIN_LOCAL_CONTEXT = 16_384;

// « Contexte des modèles locaux » (settings.mts::local_context): 16k, 32k, 64k, 128k or the model's own maximum.
export const LOCAL_CONTEXT_CHOICES = [16384, 32768, 65536, 131072, 'max'] as const;
export type LocalContextSetting = typeof LOCAL_CONTEXT_CHOICES[number];
export const DEFAULT_LOCAL_CONTEXT = 32768;

/**
 * The context size the built-in engine is created with: the setting (for 'max', the model's train size, or the
 * default when that is unknown), capped by the train size, then floored at MIN_LOCAL_CONTEXT — so a small model
 * keeps 16 384 even above what it was trained on, as before.
 * max_tokens deliberately takes no part: it stays a cap on the request window only (effectiveWindow), not on
 * the engine (ruling F6). Never rounded: every choice is already a multiple of 256, llama.cpp's n_ctx padding.
 */
export function localContextSize(input: { setting: LocalContextSetting; trainContextSize: number | undefined }): number {
  const { setting, trainContextSize } = input;
  const requested = setting === 'max' ? trainContextSize ?? DEFAULT_LOCAL_CONTEXT : setting;
  return Math.max(MIN_LOCAL_CONTEXT, Math.min(requested, trainContextSize ?? requested));
}

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
