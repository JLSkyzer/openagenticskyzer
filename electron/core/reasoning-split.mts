// Separates a model's reasoning from its answer, as the reply streams (pure: no import).
// Two sources: the chat wrapper's own segments (node-llama-cpp's onResponseChunk, `type: 'segment'`), and, for a
// template that does not declare them, the <think>…</think> tags read in the plain text. A template that opens
// <think> itself (in the prompt) leaves the model writing only the closing </think>: everything shown before it was
// reasoning, and is taken back (`moved`).

export type SplitPiece = { kind: 'text'; text: string } | { kind: 'thought'; text: string } | { kind: 'moved'; text: string };

const OPEN = '<think>';
const CLOSE = '</think>';

/**
 * The <think> fallback, fed chunk by chunk. The rules:
 * - in text, <think> switches to thought; in thought, </think> switches back to text;
 * - the first </think> met in text, before any tag, emits `moved` (all the text emitted so far) and turns the text
 *   since the last emission into thought;
 * - after a first tag, back in text, both tags are literal text (an answer that quotes a tag keeps its tail);
 * - a chunk's tail that may start a tag is held until the next push; end() flushes it as the current kind, so an
 *   unterminated <think> stays reasoning;
 * - no empty piece, and the tags themselves are never part of a piece.
 */
export class ReasoningSplitter {
  #mode: 'text' | 'thought' = 'text';
  #sawTag = false;
  #held = '';
  #text = '';
  #reasoning = '';

  /** The answer so far: the text pieces, minus what a `moved` piece took back. */
  get text(): string { return this.#text; }
  /** The thought and moved pieces so far. */
  get reasoning(): string { return this.#reasoning; }

  push(chunk: string): SplitPiece[] {
    const pieces: SplitPiece[] = [];
    let rest = this.#held + chunk;
    this.#held = '';
    for (;;) {
      const tags = this.#activeTags();
      let at = -1;
      let tag = '';
      for (const candidate of tags) {
        const index = rest.indexOf(candidate);
        if (index !== -1 && (at === -1 || index < at)) { at = index; tag = candidate; }
      }
      if (at === -1) {
        const hold = heldTail(rest, tags);
        this.#emit(pieces, this.#mode, rest.slice(0, rest.length - hold));
        this.#held = rest.slice(rest.length - hold);
        return pieces;
      }
      const before = rest.slice(0, at);
      rest = rest.slice(at + tag.length);
      if (tag === OPEN) {
        this.#emit(pieces, 'text', before);
        this.#mode = 'thought';
      } else if (this.#mode === 'thought') {
        this.#emit(pieces, 'thought', before);
        this.#mode = 'text';
      } else {
        // A bare </think>: what was shown as the answer was the reasoning.
        if (this.#text) {
          pieces.push({ kind: 'moved', text: this.#text });
          this.#reasoning += this.#text;
          this.#text = '';
        }
        this.#emit(pieces, 'thought', before);
      }
      this.#sawTag = true;
    }
  }

  end(): SplitPiece[] {
    const pieces: SplitPiece[] = [];
    this.#emit(pieces, this.#mode, this.#held);
    this.#held = '';
    return pieces;
  }

  #activeTags(): string[] {
    if (this.#mode === 'thought') return [CLOSE];
    return this.#sawTag ? [] : [OPEN, CLOSE];
  }

  #emit(pieces: SplitPiece[], kind: 'text' | 'thought', text: string): void {
    if (!text) return;
    pieces.push({ kind, text });
    if (kind === 'text') this.#text += text;
    else this.#reasoning += text;
  }
}

/** The length of `text`'s longest tail that is a proper prefix of one of `tags`. */
function heldTail(text: string, tags: readonly string[]): number {
  for (let length = Math.min(text.length, Math.max(0, ...tags.map(t => t.length - 1))); length > 0; length--) {
    const tail = text.slice(text.length - length);
    if (tags.some(tag => tag.length > length && tag.startsWith(tail))) return length;
  }
  return 0;
}

/** A whole reply split at once: one push(full), then end(). */
export function splitReasoning(full: string): { reasoning: string; text: string } {
  const splitter = new ReasoningSplitter();
  splitter.push(full);
  splitter.end();
  return { reasoning: splitter.reasoning, text: splitter.text };
}

/** One onResponseChunk chunk as pieces: a segment (thought or comment) is reasoning as it is, a plain chunk goes
 * through the <think> fallback. A segment chunk with no text (a segment start or end) gives no piece. */
export function piecesOfChunk(chunk: { type?: 'segment'; segmentType?: string; text: string }, splitter: ReasoningSplitter): SplitPiece[] {
  if (chunk.type === 'segment') return chunk.text ? [{ kind: 'thought', text: chunk.text }] : [];
  return splitter.push(chunk.text);
}

/**
 * One reply as it streams: its answer, its reasoning from BOTH sources in arrival order (segment thoughts are not the
 * splitter's, ruling S2), and how long the reasoning took (`now` in ms, injected for the tests):
 * - from the first thought piece to the first text piece after it;
 * - a moved reasoning (bare </think>) from the reply's first chunk to that </think> (ruling S1);
 * - a reasoning never followed by text: to end().
 */
export class ReplyAccumulator {
  readonly #splitter = new ReasoningSplitter();
  readonly #now: () => number;
  #reasoning = '';
  #firstChunkAt: number | undefined;
  #reasoningStart: number | undefined;
  #reasoningEnd: number | undefined;
  #endedAt: number | undefined;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  get text(): string { return this.#splitter.text; }
  get reasoning(): string { return this.#reasoning; }
  get reasoningMs(): number | undefined {
    if (this.#reasoningStart === undefined) return undefined;
    const end = this.#reasoningEnd ?? this.#endedAt ?? this.#now();
    return Math.max(0, Math.round(end - this.#reasoningStart));
  }

  chunk(chunk: { type?: 'segment'; segmentType?: string; text: string }): SplitPiece[] {
    const now = this.#now();
    this.#firstChunkAt ??= now;
    return this.#record(piecesOfChunk(chunk, this.#splitter), now);
  }

  end(): SplitPiece[] {
    const now = this.#now();
    const pieces = this.#record(this.#splitter.end(), now);
    this.#endedAt = now;
    return pieces;
  }

  #record(pieces: SplitPiece[], now: number): SplitPiece[] {
    for (const piece of pieces) {
      if (piece.kind === 'text') {
        if (this.#reasoningStart !== undefined) this.#reasoningEnd ??= now;
        continue;
      }
      this.#reasoning += piece.text;
      if (piece.kind === 'moved') {
        this.#reasoningStart ??= this.#firstChunkAt ?? now;
        this.#reasoningEnd ??= now;
      } else {
        this.#reasoningStart ??= now;
      }
    }
    return pieces;
  }
}
