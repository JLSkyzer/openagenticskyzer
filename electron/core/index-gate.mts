// The gate the background indexing passes between files (Task 13, lever indexDuringTurns). A turn or a compaction
// pauses it while it runs, so the ONNX runs of the indexing never compete with the model's own threads; the indexing
// waits at its next file and goes on once nothing holds the gate. A file already being embedded finishes first.

export class IndexGate {
  #holds = 0;
  #waiters = new Set<() => void>();

  /** Holds the gate until the returned resume is called. Holds add up (a counter); each resume counts once, however
   * many times it is called. */
  pause(): () => void {
    this.#holds++;
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.#holds--;
      if (this.#holds === 0) for (const wake of [...this.#waiters]) wake();
    };
  }

  /** Resolves at once when nothing holds the gate, else once the last hold is resumed. An aborted `signal` rejects
   * with its reason. */
  wait(signal?: AbortSignal): Promise<void> {
    if (this.#holds === 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const onAbort = () => { this.#waiters.delete(wake); reject(signal!.reason); };
      const wake = () => { this.#waiters.delete(wake); signal?.removeEventListener('abort', onAbort); resolve(); };
      this.#waiters.add(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  get paused(): boolean {
    return this.#holds > 0;
  }
}
