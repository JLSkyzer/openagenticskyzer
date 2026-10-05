import { test } from 'node:test';
import assert from 'node:assert/strict';

const { unifiedDiff, boundedDiff, DIFF_MAX_LINES, DIFF_MAX_CHARS, DIFF_TRUNCATED } = await import('../core/unified-diff.mts');

test('one changed line: headers, one hunk, three lines of context each side', () => {
  const before = ['l1', 'l2', 'l3', 'l4', 'five', 'l6', 'l7', 'l8', 'l9'].join('\n') + '\n';
  const after = before.replace('five', 'FIVE');
  assert.equal(unifiedDiff('src/a.txt', before, after), [
    '--- a/src/a.txt', '+++ b/src/a.txt', '@@ -2,7 +2,7 @@', ' l2', ' l3', ' l4', '-five', '+FIVE', ' l6', ' l7', ' l8',
  ].join('\n'));
});

test('a multi-line replacement prefixes every removed and added line, and a CRLF file diffs by line', () => {
  assert.equal(unifiedDiff('f.txt', 'a\r\nb\r\nc\r\n', 'a\r\nX\r\nY\r\nZ\r\nc\r\n'), [
    '--- a/f.txt', '+++ b/f.txt', '@@ -1,3 +1,5 @@', ' a', '-b', '+X', '+Y', '+Z', ' c',
  ].join('\n'));
});

test('identical texts give no diff, and a change on the first or last line has context on one side only', () => {
  assert.equal(unifiedDiff('f', 'same\n', 'same\n'), '');
  const text = 'a\nb\nc\nd\ne';
  assert.equal(unifiedDiff('f', text, text.replace('a', 'A')), ['--- a/f', '+++ b/f', '@@ -1,4 +1,4 @@', '-a', '+A', ' b', ' c', ' d'].join('\n'));
  assert.equal(unifiedDiff('f', text, text.replace('e', 'E')), ['--- a/f', '+++ b/f', '@@ -2,4 +2,4 @@', ' b', ' c', ' d', '-e', '+E'].join('\n'));
});

test('boundedDiff keeps a diff of up to 60 lines and 4 000 characters whole, and cuts a longer one to those bounds, « [diff tronqué] » included', () => {
  assert.equal(DIFF_MAX_LINES, 60);
  assert.equal(DIFF_MAX_CHARS, 4000);
  assert.equal(DIFF_TRUNCATED, '[diff tronqué]');
  const sixty = Array.from({ length: 60 }, (_, i) => `+${i}`).join('\n');
  assert.equal(boundedDiff(sixty), sixty, 'exactly at the bound: whole');
  const many = Array.from({ length: 200 }, (_, i) => `+ligne ${i}`).join('\n');
  const byLines = boundedDiff(many).split('\n');
  assert.equal(byLines.length, 60);
  assert.equal(byLines[58], '+ligne 58');
  assert.equal(byLines[59], '[diff tronqué]');
  const wide = Array.from({ length: 10 }, () => '+' + 'x'.repeat(999)).join('\n');
  const byChars = boundedDiff(wide);
  assert.equal(byChars.length, 4000);
  assert.ok(byChars.endsWith('\n[diff tronqué]'));
});
