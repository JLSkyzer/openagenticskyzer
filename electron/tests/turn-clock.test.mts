import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnClock } from '../core/turn-clock.mts';

const stats = (outputTokens: number, generationMs: number) => ({ inputTokens: 10, outputTokens, generationMs });

test('TurnClock: load, read, first thought then first text, stats over two steps', () => {
  let t = 1000;
  const clock = new TurnClock(1000, () => t);
  clock.loadStart();
  t = 36000; clock.loadEnd();
  t = 36100; clock.readStart();
  t = 40000; clock.chunk('thought');
  t = 41200; clock.chunk('text');
  t = 42000; clock.stats(stats(50, 4000));
  t = 43000; clock.readStart(); clock.chunk('text');
  clock.stats(stats(33, 6000));
  t = 13800 + 35000;
  assert.deepEqual(clock.timing(), { loadMs: 35000, readMs: 3900, firstTextMs: 40200, totalMs: 47800, outputTokens: 83, tokensPerSecond: 8.3 });
});

test('TurnClock: a stop during the load has only totalMs; a warm turn has no loadMs', () => {
  let t = 1000;
  const stopped = new TurnClock(1000, () => t);
  stopped.loadStart();
  t = 3500;
  assert.deepEqual(stopped.timing(), { totalMs: 2500 }, 'a load that never ended reports no loadMs, nothing was read');

  t = 0;
  const warm = new TurnClock(0, () => t);
  t = 20; warm.readStart();
  t = 120; warm.chunk('text');
  t = 300;
  const timing = warm.timing();
  assert.deepEqual(timing, { readMs: 100, firstTextMs: 120, totalMs: 300 });
  assert.equal(Object.hasOwn(timing, 'loadMs'), false);
  assert.equal(Object.hasOwn(timing, 'outputTokens'), false, 'no stats came (the scripted provider): no tokens, no rate');
});

test('TurnClock: a moved piece clears firstTextMs until the next text (ruling S1); a step that wrote nothing in 0 ms gives no rate', () => {
  let t = 0;
  const clock = new TurnClock(0, () => t);
  clock.readStart();
  t = 100; clock.chunk('text');      // the reasoning, streamed as the answer until </think>
  t = 900; clock.chunk('moved');     // </think>: it was reasoning
  t = 950; clock.chunk('thought');
  t = 1000; clock.chunk('text');     // the first word of the real answer
  t = 1500;
  assert.deepEqual(clock.timing(), { readMs: 100, firstTextMs: 1000, totalMs: 1500 });

  const toolOnly = new TurnClock(0, () => 10);
  toolOnly.stats(stats(0, 0));
  assert.deepEqual(toolOnly.timing(), { totalMs: 10, outputTokens: 0 }, 'never a division by 0 (ruling T2-m3)');
  const instant = new TurnClock(0, () => 10);
  instant.stats(stats(5, 0));
  assert.equal(Object.hasOwn(instant.timing(), 'tokensPerSecond'), false, 'no rate when generationMs is 0');
});

test('TurnClock: a movedBack piece (startInThought with no </think>) sets firstTextMs to the step\'s first chunk', () => {
  let t = 0;
  const clock = new TurnClock(0, () => t);
  clock.readStart();
  t = 200; clock.chunk('thought');   // provisional reasoning: no first word yet
  t = 600; clock.chunk('thought');
  assert.equal(Object.hasOwn(clock.timing(), 'firstTextMs'), false);
  t = 900; clock.chunk('movedBack'); // the end: it was the answer all along
  t = 1000;
  assert.deepEqual(clock.timing(), { readMs: 200, firstTextMs: 200, totalMs: 1000 });

  t = 0;
  const twoSteps = new TurnClock(0, () => t);
  twoSteps.readStart();
  t = 100; twoSteps.chunk('thought');
  t = 300; twoSteps.readStart();     // the next step after a tool
  t = 500; twoSteps.chunk('thought');
  t = 800; twoSteps.chunk('movedBack');
  assert.equal(twoSteps.timing().firstTextMs, 500, 'the first chunk of the step given back, not of the turn');
});
