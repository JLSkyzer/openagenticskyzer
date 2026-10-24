import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commonPrefixLength, reuseOf } from '../core/reuse.mts';

test('reuseOf: an attention model keeps the common prefix — reused equals the prompt minus what was evaluated', () => {
  const held = [1, 2, 3, 4, 5, 6, 7, 8];          // previous prompt 1..6 + reply 7, 8
  const after = [1, 2, 3, 4, 5, 6, 9, 10, 11, 12]; // new prompt 1..6, 9, 10 + 2 generated
  const r = reuseOf({ heldTokens: held, afterTokens: after, evaluated: 2, outputTokens: 2, checkpoints: null });
  assert.deepEqual(r, { held: 8, common: 6, prompt: 8, evaluated: 2, reused: 6, checkpoints: null });
});
test('reuseOf: a hybrid model without a usable checkpoint matched 6 tokens but re-read all 8', () => {
  const r = reuseOf({ heldTokens: [1, 2, 3, 4, 5, 6, 7, 8], afterTokens: [1, 2, 3, 4, 5, 6, 9, 10, 11, 12], evaluated: 8, outputTokens: 2,
    checkpoints: { needed: true, memoryBytes: 156237824, lastIndex: 7 } });
  assert.equal(r.common, 6);
  assert.equal(r.reused, 0);
  assert.equal(r.checkpoints?.needed, true);
});
test('commonPrefixLength and a cold call: nothing held, nothing reused', () => {
  assert.equal(commonPrefixLength([], [1, 2]), 0);
  assert.equal(commonPrefixLength([1, 2, 3], [1, 2, 4]), 2);
  assert.deepEqual(reuseOf({ heldTokens: [], afterTokens: [1, 2, 3, 4], evaluated: 3, outputTokens: 1, checkpoints: null }),
    { held: 0, common: 0, prompt: 3, evaluated: 3, reused: 0, checkpoints: null });
});
