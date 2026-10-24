// Shared helpers for tests that drive a real worker (worker.mjs or an inline one) and read its agent events.
import type { Worker } from 'node:worker_threads';

/** Posts {id, op, payload} and resolves with the reply's `result`; rejects with new Error(reply.error). */
export function callWorker(worker: Worker, op: string, payload?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `test-${Math.random()}`;
    const listener = (message: any) => {
      if (message?.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}

/** What hardwareInfo needs of a worker: a Worker, or a test's relay to a worker in another process. */
export interface MessagePortLike {
  on(event: 'message', listener: (message: any) => void): unknown;
  off(event: 'message', listener: (message: any) => void): unknown;
  postMessage(message: unknown): void;
}

/**
 * hardware-info as the Matériel tab reads it. While the engine is still starting — longer than the worker's bounded
 * wait (HARDWARE_WAIT_MS, 5 s), which a machine under load reaches — the first answer is { initializing: true }; the
 * worker then posts one 'engine' event, after which it is read again. A test that asserts the backend on the first
 * answer fails on that loading state (seen 2026-10-24 when several test files ran at once). The 'engine' listener is
 * registered before the request: the event may arrive before the first answer.
 */
export async function hardwareInfo(worker: MessagePortLike, payload: unknown = {}, timeoutMs = 120000): Promise<any> {
  let listener: ((message: any) => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  const engine = new Promise<any>((resolve, reject) => {
    listener = message => { if (message?.type === 'event' && message.event === 'engine') resolve(message); };
    worker.on('message', listener);
    timer = setTimeout(() => reject(new Error(`no 'engine' event within ${timeoutMs} ms after an { initializing } hardware-info`)), timeoutMs);
  });
  engine.catch(() => {}); // awaited only after an { initializing } answer
  try {
    const first = await callWorker(worker as Worker, 'hardware-info', payload);
    if (!first?.initializing) return first;
    const event = await engine;
    if (event.state === 'error') throw new Error(`the engine failed to start: ${event.message}`);
    return await callWorker(worker as Worker, 'hardware-info', payload);
  } finally {
    clearTimeout(timer);
    if (listener) worker.off('message', listener);
  }
}

const END_KINDS: readonly string[] = ['done', 'error', 'stopped'];

export interface AgentRecorder {
  /** That run's agent events, in arrival order (a fresh array). */
  of(runId: string): any[];
  /** Resolves with of(runId) once an event whose kind is in `kinds` (default done/error/stopped) has arrived. */
  until(runId: string, options?: { kinds?: readonly string[]; timeoutMs?: number }): Promise<any[]>;
  /** Resolves with the first event of the run that satisfies `predicate`. */
  first(runId: string, predicate: (event: any) => boolean, timeoutMs?: number): Promise<any>;
  /** Removes the listener. */
  stop(): void;
}

/**
 * Records every {type:'event', event:'agent'} message of every runId, from the moment it is called.
 * Call it BEFORE sending: a worker may post its first events right after the `{runId}` reply, and a listener
 * registered after `await callWorker('send')` is not guaranteed to run before them.
 * `until` and `first` ALSO consider the events recorded BEFORE the call: an event that already arrived
 * satisfies them at once, so `first('delta')` after the delta came does not hang.
 */
export function recordAgentEvents(worker: Worker): AgentRecorder {
  const events: any[] = [];
  const waiters = new Set<() => void>();
  const listener = (message: any) => {
    if (message?.type !== 'event' || message.event !== 'agent') return;
    events.push(message);
    for (const wake of [...waiters]) wake();
  };
  worker.on('message', listener);

  const of = (runId: string) => events.filter(event => event.runId === runId);
  const wait = <T,>(runId: string, probe: () => T | undefined, timeoutMs: number): Promise<T> =>
    new Promise((resolve, reject) => {
      const check = () => {
        const found = probe();
        if (found === undefined) return;
        finish();
        resolve(found);
      };
      const timer = setTimeout(() => {
        finish();
        const last = of(runId).at(-1);
        reject(new Error(`until(${runId}) timed out; last kind: ${last?.kind ?? 'none'}`));
      }, timeoutMs);
      const finish = () => { clearTimeout(timer); waiters.delete(check); };
      waiters.add(check);
      check();
    });

  return {
    of,
    until: (runId, options = {}) => {
      const kinds = options.kinds ?? END_KINDS;
      return wait(runId, () => (of(runId).some(event => kinds.includes(event.kind)) ? of(runId) : undefined), options.timeoutMs ?? 120000);
    },
    first: (runId, predicate, timeoutMs = 120000) =>
      wait(runId, () => of(runId).find(predicate), timeoutMs),
    stop: () => { worker.off('message', listener); },
  };
}

/** The phase names of the `phase` events, consecutive duplicates collapsed. */
export function phasesOf(events: readonly any[]): string[] {
  const phases: string[] = [];
  for (const event of events) {
    if (event?.kind === 'phase' && phases.at(-1) !== event.phase) phases.push(event.phase);
  }
  return phases;
}
