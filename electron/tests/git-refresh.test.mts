import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLatestWins, shouldRefreshGitOn } from '../renderer-src/src/state/git-refresh.ts';

// A promise the test settles by hand: no timers, the order of resolution is the test's own.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('latest wins: a slow first read (dirty) resolving after a refresh read (clean) leaves the state clean', async () => {
  const applied: Array<{ dirty: boolean }> = [];
  const reads = createLatestWins<{ dirty: boolean }>(value => applied.push(value));
  const first = deferred<{ dirty: boolean }>();
  const second = deferred<{ dirty: boolean }>();
  reads.run(() => first.promise);
  reads.run(() => second.promise);

  second.resolve({ dirty: false });
  await settle();
  first.resolve({ dirty: true });
  await settle();

  assert.deepEqual(applied, [{ dirty: false }], 'the stale first read is never applied');
});

test('latest wins: the latest read is applied whatever the order, and a failed read applies nothing', async () => {
  const applied: string[] = [];
  const reads = createLatestWins<string>(value => applied.push(value));
  const first = deferred<string>();
  const second = deferred<string>();
  reads.run(() => first.promise);
  reads.run(() => second.promise);
  first.resolve('stale');
  await settle();
  assert.deepEqual(applied, [], 'an older read resolving first is dropped too');
  second.resolve('fresh');
  await settle();
  assert.deepEqual(applied, ['fresh']);

  const failing = deferred<string>();
  reads.run(() => failing.promise);
  failing.reject(new Error('git absent'));
  await settle();
  assert.deepEqual(applied, ['fresh'], 'an error is swallowed, the last good value stays');
});

test('cancel(): a read in flight when the folder changes is never applied', async () => {
  const applied: string[] = [];
  const reads = createLatestWins<string>(value => applied.push(value));
  const pending = deferred<string>();
  reads.run(() => pending.promise);
  reads.cancel();
  pending.resolve('old folder');
  await settle();
  assert.deepEqual(applied, []);
});

test('index events: only ready/error of the ACTIVE folder trigger a git refresh', () => {
  const active = 'C:\\projets\\alpha';
  assert.equal(shouldRefreshGitOn({ folder: active, state: 'ready' }, active), true);
  assert.equal(shouldRefreshGitOn({ folder: active, state: 'error' }, active), true, 'an error also ends the writes');
  assert.equal(shouldRefreshGitOn({ folder: 'C:\\projets\\beta', state: 'ready' }, active), false, 'another folder');
  assert.equal(shouldRefreshGitOn({ folder: active, state: 'indexing' }, active), false, 'still writing');
  assert.equal(shouldRefreshGitOn({ folder: active, state: 'idle' }, active), false);
  assert.equal(shouldRefreshGitOn({ folder: active, state: 'ready' }, null), false, 'no active folder');
});
