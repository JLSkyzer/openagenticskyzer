// The background estimates of a worker: one at a time, cancellable. A new key cancels the running job, and its run
// starts only once the cancelled run has settled, so two estimates never overlap. A cancelled run still finishes the
// native step it is in (the resolver only checks its signal between steps), so its overlap with whatever runs next
// is bounded by one step, not zero, unless that caller waits for idle() first (a turn's load does).
import { randomUUID } from 'node:crypto';
import type { Placement } from './placement.mts';

export type EstimateOutcome =
  | { id: string; state: 'done'; estimate: Placement }
  | { id: string; state: 'cancelled' }
  | { id: string; state: 'error'; message: string };

interface Job { id: string; key: string; controller: AbortController }

export class EstimateJobs {
  private current: Job | null = null;
  private tail: Promise<void> = Promise.resolve();

  /** Starts `run` for `key`. The same key while it runs → the same job (reused). Another key → the running job is
   * cancelled first. `onEnd` is called once: an abort ends 'cancelled', never 'error'. */
  start(key: string, run: (signal: AbortSignal) => Promise<Placement>, onEnd: (outcome: EstimateOutcome) => void): { id: string; reused: boolean } {
    if (this.current && this.current.key === key) return { id: this.current.id, reused: true };
    this.cancelAll();
    const job: Job = { id: randomUUID(), key, controller: new AbortController() };
    this.current = job;
    const { signal } = job.controller;
    this.tail = this.tail.then(async () => {
      let outcome: EstimateOutcome;
      try {
        signal.throwIfAborted();
        const estimate = await run(signal);
        outcome = signal.aborted ? { id: job.id, state: 'cancelled' } : { id: job.id, state: 'done', estimate };
      } catch (error) {
        outcome = signal.aborted
          ? { id: job.id, state: 'cancelled' }
          : { id: job.id, state: 'error', message: error instanceof Error ? error.message : String(error) };
      }
      // Ended jobs are forgotten.
      if (this.current === job) this.current = null;
      try { onEnd(outcome); } catch { /* a listener's failure never stops the next job */ }
    });
    return { id: job.id, reused: false };
  }

  /** Aborts the running job `id`; true if it was running. */
  cancel(id: string): boolean {
    if (!this.current || this.current.id !== id) return false;
    this.cancelAll();
    return true;
  }

  cancelAll(): void {
    const job = this.current;
    this.current = null;
    job?.controller.abort();
  }

  /** Resolves once every run started so far has ended, cancelled ones included. Never rejects. */
  idle(): Promise<void> {
    return this.tail;
  }

  /** 0 or 1: the job not yet ended nor cancelled. */
  get running(): number {
    return this.current ? 1 : 0;
  }
}
