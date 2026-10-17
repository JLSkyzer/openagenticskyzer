// The budget rule and the estimate are the worker's own (core/context-budget.mts): one source, imported as is —
// Vite bundles the core file into the renderer (verified with a real build), so there is no copy to keep in step.
import { characters, contextBudget, effectiveWindow, tokensFor } from '../../../core/context-budget.mts';

interface RoleContent {
  role: string;
  content: string;
}

export interface ContextUsage {
  tokens: number;
  pct: number;
}

// storage.py::compute_context_pct: user + assistant text, 4 characters per token. Since 2026-10-03 this is also
// exactly what the next request sends of the earlier turns (core/request-context.mts drops their tool calls and
// results); the system prompt and the tool schemas, sent on top of it, are not counted here.
export function estimateTokens(messages: readonly RoleContent[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'assistant' || message.role === 'human' || message.role === 'ai') {
      total += characters(message.content);
    }
  }
  return tokensFor(total);
}

// The worker's rule (worker.mjs::windowFor): the engine window (the 'model' event / model-status), capped by max_tokens
// when the user set one — never raised by it — minus reserved_tokens.
export function contextLimit(contextWindow: number, maxTokens: number | null, reservedTokens: number): number {
  return contextBudget(effectiveWindow(contextWindow, maxTokens), reservedTokens);
}

export function computeContext(
  messages: readonly RoleContent[],
  settings: { contextWindow: number; max_tokens: number | null; reserved_tokens: number },
): ContextUsage {
  const tokens = estimateTokens(messages);
  const limit = contextLimit(settings.contextWindow, settings.max_tokens, settings.reserved_tokens);
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
