// The window a turn's or a compaction's requests must fit in, got without competing with a background estimate.
import type { ModelProvider, WindowOptions } from './model-types.mts';
import { untilAborted } from './abortable.mts';
import { effectiveWindow } from './context-budget.mts';

/** What turnWindow needs of the worker's estimate queue (core/estimate-jobs.mts::EstimateJobs). */
export interface EstimateQueue { cancelAll(): void; idle(): Promise<void> }

/**
 * The engine's real context size (which may load the model), capped by max_tokens when the user set one
 * (context-budget.mts::effectiveWindow). Every estimate is cancelled first, and the load waits until a cancelled run
 * has really ended — the native resolver only notices its abort between its own steps — so the load never overlaps
 * an estimate. `options.signal` cuts that wait short (ruling S5) and stops the load; `options.onLoad` follows it.
 */
export async function turnWindow(jobs: EstimateQueue, provider: ModelProvider, maxTokens: number | null, options: WindowOptions = {}): Promise<number> {
  jobs.cancelAll();
  await untilAborted(jobs.idle(), options.signal);
  return effectiveWindow(await provider.contextWindow(options), maxTokens);
}
