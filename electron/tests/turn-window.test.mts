import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EstimateJobs } from '../core/estimate-jobs.mts';
import { turnWindow } from '../core/turn-window.mts';
import type { Placement } from '../core/placement.mts';

// Ruling S5: a stop while a turn waits for a cancelled estimate to end releases the turn at once, and the model is
// never asked for its window (no load). The estimate's run ignores its signal, like a native step that does not
// check it before it ends.
test('turnWindow: a stop during the wait for a cancelled estimate releases the turn at once, before any load', { timeout: 10000 }, async () => {
  const jobs = new EstimateJobs();
  let finishEstimate!: () => void;
  const outcomes: string[] = [];
  let running!: () => void;
  const started = new Promise<void>(resolve => { running = resolve; });
  jobs.start('k', () => new Promise<Placement>(resolve => { finishEstimate = () => resolve({} as Placement); running(); }), outcome => outcomes.push(outcome.state));
  await started; // the run is under way: a job cancelled before it starts never runs at all
  let asked = 0;
  const provider = { complete: async () => { throw new Error('unused'); }, contextWindow: async () => { asked++; return 4096; }, outputCap: () => undefined };
  const controller = new AbortController();
  const waiting = turnWindow(jobs, provider, null, { signal: controller.signal });
  let settled = false;
  waiting.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(settled, false, 'the turn waits for the cancelled estimate to end');
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.deepEqual(outcomes, [], 'released while the estimate is still running');
  assert.equal(asked, 0, 'the window (and so the load) is never asked for');
  finishEstimate();
  await jobs.idle();
  assert.deepEqual(outcomes, ['cancelled']);

  // Without a stop, the same wait ends with the window, capped by max_tokens.
  assert.equal(await turnWindow(jobs, provider, 1000), 1000);
  assert.equal(asked, 1);
});
