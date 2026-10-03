// Test teardown for tests that spawn worker.mjs in a temp directory (not a test file: tests/all.mts does not import it).
//
// node:test runs a test's after-hooks in registration order, and a hook that throws skips every hook after it.
// A temp-dir removal registered before a separate `worker.terminate()` hook therefore ran while the worker was
// still alive and writing (e.g. the background indexing activate_folder starts writes <project>/.openagent/index).
// The removal failed with ENOTEMPTY, the termination was skipped, and the live worker kept the whole run from ever
// exiting (2026-10-03). Here a test's workers and temp dirs share ONE hook: every worker is terminated first, then
// the dirs are removed. maxRetries covers a write the worker had already handed to the OS when it was terminated.
import { rm } from 'node:fs/promises';

interface Terminable { terminate(): Promise<unknown> }
interface TestContextLike { after(fn: () => unknown): void }

const teardowns = new WeakMap<object, { workers: Terminable[]; dirs: string[] }>();

/** Removes `dir` when the test ends, after terminating every worker passed to terminateAtEnd() for this test. */
export function removeAtEnd(t: TestContextLike, dir: string): void {
  const existing = teardowns.get(t);
  if (existing) { existing.dirs.push(dir); return; }
  const state = { workers: [] as Terminable[], dirs: [dir] };
  teardowns.set(t, state);
  t.after(async () => {
    try {
      await Promise.all(state.workers.map(worker => worker.terminate()));
    } finally {
      for (const path of state.dirs) await rm(path, { recursive: true, force: true, maxRetries: 5 });
    }
  });
}

/** Terminates `worker` when the test ends, before the test's removeAtEnd() dirs are removed. */
export function terminateAtEnd<W extends Terminable>(t: TestContextLike, worker: W): W {
  const state = teardowns.get(t);
  // No temp dir registered (yet) for this test: nothing to order against, a plain hook is enough.
  if (state) state.workers.push(worker); else t.after(() => worker.terminate());
  return worker;
}
