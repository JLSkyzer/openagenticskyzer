// Test teardown for tests that spawn worker.mjs in a temp directory (not a test file: tests/all.mts does not import it).
//
// node:test runs a test's after-hooks in registration order, and a hook that throws skips every hook after it.
// A temp-dir removal registered before a separate `worker.terminate()` hook therefore ran while the worker was
// still alive and writing (e.g. the background indexing activate_folder starts writes <project>/.openagent/index).
// The removal failed with ENOTEMPTY, the termination was skipped, and the live worker kept the whole run from ever
// exiting (2026-10-03). Here a test's workers and temp dirs share ONE hook: every worker is terminated first, then
// the dirs are removed. maxRetries covers a write the worker had already handed to the OS when it was terminated.
//
// A removal that still fails is REPORTED (t.diagnostic), never thrown: a throw here would skip the hooks registered
// after this one — a `server.close()` hook, for one — and that live server would hang the run the same way. A
// leftover temp dir must never fail or hang the run.
import { rm } from 'node:fs/promises';

interface Terminable { terminate(): Promise<unknown> }
// diagnostic is optional only so the structural `{ after(fn) }` types some test helpers declare still fit;
// a real node:test TestContext always has it.
interface TestContextLike { after(fn: () => unknown): void; diagnostic?(message: string): void }

const teardowns = new WeakMap<object, { workers: Terminable[]; dirs: string[] }>();

/** Removes `dir` when the test ends, after terminating every worker passed to terminateAtEnd() for this test. */
export function removeAtEnd(t: TestContextLike, dir: string): void {
  const existing = teardowns.get(t);
  if (existing) { existing.dirs.push(dir); return; }
  const state = { workers: [] as Terminable[], dirs: [dir] };
  teardowns.set(t, state);
  t.after(async () => {
    // allSettled: every worker is really gone before any removal starts, even if one terminate() rejects.
    const terminations = await Promise.allSettled(state.workers.map(worker => worker.terminate()));
    for (const path of state.dirs) {
      try {
        await rm(path, { recursive: true, force: true, maxRetries: 5 });
      } catch (error) {
        const message = `temp dir left behind: ${path} (${error instanceof Error ? error.message : String(error)})`;
        if (t.diagnostic) t.diagnostic(message); else console.warn(message);
      }
    }
    // A failed termination stays a visible failure, raised only after the removal so it cannot be masked by it.
    const failed = terminations.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  });
}

/** Terminates `worker` when the test ends, before the test's removeAtEnd() dirs are removed. */
export function terminateAtEnd<W extends Terminable>(t: TestContextLike, worker: W): W {
  const state = teardowns.get(t);
  // No temp dir registered (yet) for this test: nothing to order against, a plain hook is enough.
  if (state) state.workers.push(worker); else t.after(() => worker.terminate());
  return worker;
}
