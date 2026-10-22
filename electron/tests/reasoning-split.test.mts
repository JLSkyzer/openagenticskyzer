import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReasoningSplitter, splitReasoning, piecesOfChunk, ReplyAccumulator, type SplitPiece } from '../core/reasoning-split.mts';

/** Streams `chunks` through a fresh splitter: the final answer and reasoning, every piece, and the text a screen
 * would show (text pieces appended, a `moved` piece taking back everything shown so far). */
function stream(chunks: readonly string[]) {
  const splitter = new ReasoningSplitter();
  const pieces: SplitPiece[] = [];
  for (const chunk of chunks) pieces.push(...splitter.push(chunk));
  pieces.push(...splitter.end());
  let shown = '';
  for (const piece of pieces) {
    if (piece.kind === 'text') shown += piece.text;
    if (piece.kind === 'moved') {
      assert.equal(piece.text, shown, 'a moved piece takes back exactly what was shown');
      shown = '';
    }
  }
  return { text: splitter.text, reasoning: splitter.reasoning, pieces, shown };
}

test('no tags: every chunking passes the text through, with no reasoning', () => {
  const full = 'Il était une fois';
  for (let i = 0; i <= full.length; i++) {
    const { text, reasoning, pieces, shown } = stream([full.slice(0, i), full.slice(i)]);
    assert.equal(shown, full);
    assert.equal(text, full);
    assert.equal(reasoning, '');
    assert.equal(pieces.some(p => p.kind !== 'text'), false, `split at ${i}`);
    assert.equal(pieces.some(p => p.text === ''), false, 'no empty piece');
  }
});

test('a complete <think>…</think> pair becomes reasoning, the rest stays the answer', () => {
  assert.deepEqual(splitReasoning('<think>je réfléchis</think>Bonjour'), { reasoning: 'je réfléchis', text: 'Bonjour' });
});

test('a bare </think> with no opening tag moves what came before into the reasoning', () => {
  const s = new ReasoningSplitter();
  assert.deepEqual(s.push('I think'), [{ kind: 'text', text: 'I think' }]);
  assert.deepEqual(s.push(' hard</think>Salut'), [{ kind: 'moved', text: 'I think' }, { kind: 'thought', text: ' hard' }, { kind: 'text', text: 'Salut' }]);
  assert.deepEqual(s.end(), []);
  assert.equal(s.text, 'Salut');
  assert.equal(s.reasoning, 'I think hard');
});

test('tags split across chunks at every position give the same result as the whole string', () => {
  for (const full of ['x<think>y</think>z', 'r</think>a', '<think>pensée', 'a</thi']) {
    const whole = splitReasoning(full);
    for (let i = 0; i <= full.length; i++) {
      for (let j = i; j <= full.length; j++) {
        const parts = j === i ? [full.slice(0, i), full.slice(i)] : [full.slice(0, i), full.slice(i, j), full.slice(j)];
        const { text, reasoning, shown, pieces } = stream(parts);
        assert.deepEqual({ text, reasoning }, whole, `${JSON.stringify(parts)}`);
        assert.equal(shown, whole.text, `the text pieces minus the moved one are the answer: ${JSON.stringify(parts)}`);
        assert.equal(pieces.some(p => p.text === ''), false, 'no empty piece');
        assert.equal(pieces.some(p => /<\/?think>/.test(p.text)), false, 'no tag inside a piece');
      }
    }
  }
});

test('after a first tag, later tags are literal text; an unterminated <think> stays reasoning; a held partial tag flushes as text', () => {
  assert.deepEqual(splitReasoning('<think>a</think>b </think> c'), { reasoning: 'a', text: 'b </think> c' });
  assert.deepEqual(splitReasoning('<think>a</think>b <think> c'), { reasoning: 'a', text: 'b <think> c' });
  assert.deepEqual(splitReasoning('r</think>a <think>b</think>'), { reasoning: 'r', text: 'a <think>b</think>' });
  assert.deepEqual(splitReasoning('<think>pensée'), { reasoning: 'pensée', text: '' });
  assert.deepEqual(splitReasoning('a</thi'), { reasoning: '', text: 'a</thi' });
});

test('piecesOfChunk: a thought or comment segment is reasoning, a plain chunk goes through the splitter', () => {
  const s = new ReasoningSplitter();
  assert.deepEqual(piecesOfChunk({ type: 'segment', segmentType: 'thought', text: 'p' }, s), [{ kind: 'thought', text: 'p' }]);
  assert.deepEqual(piecesOfChunk({ type: 'segment', segmentType: 'comment', text: 'p' }, s), [{ kind: 'thought', text: 'p' }]);
  assert.deepEqual(piecesOfChunk({ text: 't' }, s), [{ kind: 'text', text: 't' }]);
  assert.deepEqual(piecesOfChunk({ type: 'segment', segmentType: 'thought', text: '' }, s), [], 'a segment-start chunk with no text gives no piece');
});

test('piecesOfChunk: once the wrapper sent a segment, the <think> fallback is off — a stray </think> in the answer stays text (ruling T2-m1)', () => {
  const s = new ReasoningSplitter();
  assert.deepEqual(piecesOfChunk({ type: 'segment', segmentType: 'thought', text: 'je pense' }, s), [{ kind: 'thought', text: 'je pense' }]);
  const pieces = [...piecesOfChunk({ text: 'Réponse ' }, s), ...piecesOfChunk({ text: 'avec </think> dedans' }, s), ...s.end()];
  assert.deepEqual(pieces.map(piece => piece.kind).filter(kind => kind !== 'text'), [], 'no moved piece, no thought');
  assert.equal(s.text, 'Réponse avec </think> dedans');

  const empty = new ReasoningSplitter();
  assert.deepEqual(piecesOfChunk({ type: 'segment', segmentType: 'thought', text: '' }, empty), [], 'a segment start with no text gives no piece');
  piecesOfChunk({ text: 'a</think>b' }, empty);
  empty.end();
  assert.deepEqual({ text: empty.text, reasoning: empty.reasoning }, { text: 'a</think>b', reasoning: '' }, 'it marks the splitter all the same');
});

test('ReplyAccumulator: segment thoughts and a bare </think> both reach the reasoning, in arrival order, with their duration', () => {
  let now = 0;
  const segments = new ReplyAccumulator(() => now);
  now = 100; segments.chunk({ type: 'segment', segmentType: 'thought', text: '' });
  now = 110; assert.deepEqual(segments.chunk({ type: 'segment', segmentType: 'thought', text: 'je ' }), [{ kind: 'thought', text: 'je ' }]);
  now = 150; segments.chunk({ type: 'segment', segmentType: 'thought', text: 'pense' });
  now = 400; assert.deepEqual(segments.chunk({ text: 'Bonjour' }), [{ kind: 'text', text: 'Bonjour' }]);
  now = 500; segments.chunk({ text: ' toi' });
  segments.end();
  assert.equal(segments.reasoning, 'je pense', 'segment thoughts are kept, not only the splitter\'s own');
  assert.equal(segments.text, 'Bonjour toi');
  assert.equal(segments.reasoningMs, 290, 'from the first thought piece to the first text piece after it');

  now = 0;
  const bare = new ReplyAccumulator(() => now);
  now = 1000; bare.chunk({ text: 'I think' });
  now = 3000; assert.deepEqual(bare.chunk({ text: ' hard</think>Salut' }), [{ kind: 'moved', text: 'I think' }, { kind: 'thought', text: ' hard' }, { kind: 'text', text: 'Salut' }]);
  now = 3500; bare.end();
  assert.equal(bare.reasoning, 'I think hard');
  assert.equal(bare.text, 'Salut');
  assert.equal(bare.reasoningMs, 2000, 'a moved reasoning runs from the step\'s first chunk to the </think>');

  now = 0;
  const open = new ReplyAccumulator(() => now);
  now = 10; open.chunk({ text: '<think>pensée' });
  now = 70; open.end();
  assert.equal(open.reasoningMs, 60, 'a reasoning never closed runs to the end');

  const plain = new ReplyAccumulator(() => 0);
  plain.chunk({ text: 'Il était' });
  plain.end();
  assert.equal(plain.reasoning, '');
  assert.equal(plain.reasoningMs, undefined, 'no reasoning, no duration');
});
