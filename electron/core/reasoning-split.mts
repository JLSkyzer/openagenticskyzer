// Separates a model's reasoning from its answer, as the reply streams (pure: no import).
// Two sources: the chat wrapper's own segments (node-llama-cpp's onResponseChunk, `type: 'segment'`), and, for a
// template that does not declare them, the <think>…</think> tags read in the plain text. A template that opens
// <think> itself (in the prompt) leaves the model writing only the closing </think>: everything shown before it was
// reasoning, and is taken back (`moved`) — or, when that template was detected at load (core/thought-prefill.mts), the
// reply starts as reasoning (`startInThought`) and, if no </think> ever comes, is given back as the answer (`movedBack`).

export type SplitPiece =
  | { kind: 'text'; text: string }
  | { kind: 'thought'; text: string }
  /** All the text shown so far was reasoning (a bare </think>). */
  | { kind: 'moved'; text: string }
  /** All the reasoning shown so far was the answer (startInThought and no </think>, or a wrapper segment came). */
  | { kind: 'movedBack'; text: string };

export interface SplitOptions {
  /** The chat template opened <think> in the generation prompt: the reply is reasoning until its first </think>. */
  startInThought?: boolean;
}

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
 * With `startInThought`, the reply begins in thought, provisionally:
 * - the first </think> switches to text (the reasoning is kept), and the rules above apply from there;
 * - a <think> the model writes anyway before any reasoning is dropped (it opens the thought explicitly);
 * - with no </think> by end(), or when a wrapper segment comes first (segmentSeen), the provisional reasoning, held
 *   tail included, is given back as text in ONE `movedBack` piece: no answer is ever hidden;
 * - whitespace before any provisional reasoning is held, not streamed: it joins the reasoning's first real piece, and a
 *   reply that is only whitespace is given back silently — no piece, so no phase flip, no first word, no leading
 *   newline in the answer (ruling 5b-m1).
 */
export class ReasoningSplitter {
  #mode: 'text' | 'thought' = 'text';
  #sawTag = false;
  /** startInThought, before any tag or segment: the reasoning so far may still be the answer. */
  #provisional = false;
  #held = '';
  /** Provisional whitespace not streamed yet (ruling 5b-m1). */
  #quiet = '';
  #text = '';
  #reasoning = '';

  constructor(options: SplitOptions = {}) {
    if (options.startInThought) {
      this.#mode = 'thought';
      this.#provisional = true;
    }
  }

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
      if (tag === OPEN && this.#mode === 'thought') {
        // Provisional only (#activeTags): the model opened the thought itself, unless reasoning came first — then
        // the tag is quoted text and stays in the reasoning.
        if ((this.#reasoning + before).trim()) {
          this.#emit(pieces, 'thought', before + OPEN);
          continue;
        }
        this.#emit(pieces, 'thought', before);
        this.#provisional = false;
      } else if (tag === OPEN) {
        this.#emit(pieces, 'text', before);
        this.#mode = 'thought';
      } else if (this.#mode === 'thought') {
        this.#emit(pieces, 'thought', before);
        this.#mode = 'text';
        this.#provisional = false;
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

  /** The chat wrapper sent a segment: it handles the thoughts itself, so the <think> fallback is off from here on,
   * as after a first tag (ruling T2-m1) — a stray </think> in the answer stays text.
   * A provisional reasoning (startInThought) was the answer after all: it is given back (`movedBack`). */
  segmentSeen(): SplitPiece[] {
    this.#sawTag = true;
    if (!this.#provisional) return [];
    this.#mode = 'text';
    return this.#giveBack();
  }

  end(): SplitPiece[] {
    if (this.#provisional) return this.#giveBack();
    const pieces: SplitPiece[] = [];
    this.#emit(pieces, this.#mode, this.#held);
    this.#held = '';
    return pieces;
  }

  /** The provisional reasoning and the held tail, as text, in one piece. */
  #giveBack(): SplitPiece[] {
    const text = this.#reasoning + this.#held;
    this.#provisional = false;
    this.#reasoning = '';
    this.#held = '';
    this.#quiet = '';
    if (!text.trim()) return [];
    this.#text += text;
    return [{ kind: 'movedBack', text }];
  }

  #activeTags(): string[] {
    if (this.#mode === 'thought') return this.#provisional ? [OPEN, CLOSE] : [CLOSE];
    return this.#sawTag ? [] : [OPEN, CLOSE];
  }

  #emit(pieces: SplitPiece[], kind: 'text' | 'thought', text: string): void {
    if (!text) return;
    if (kind === 'thought') {
      text = this.#quiet + text;
      this.#quiet = '';
      if (this.#provisional && !this.#reasoning && !text.trim()) {
        this.#quiet = text;
        return;
      }
    }
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
 * through the <think> fallback, which any segment turns off (ReasoningSplitter.segmentSeen). A segment chunk with no
 * text (a segment start or end) gives no piece. */
export function piecesOfChunk(chunk: { type?: 'segment'; segmentType?: string; text: string }, splitter: ReasoningSplitter): SplitPiece[] {
  if (chunk.type === 'segment') {
    const given = splitter.segmentSeen();
    return chunk.text ? [...given, { kind: 'thought', text: chunk.text }] : given;
  }
  return splitter.push(chunk.text);
}

/**
 * One reply as it streams: its answer, its reasoning from BOTH sources in arrival order (segment thoughts are not the
 * splitter's, ruling S2), and how long the reasoning took (`now` in ms, injected for the tests):
 * - from the first thought piece to the first text piece after it;
 * - a moved reasoning (bare </think>) from the reply's first chunk to that </think> (ruling S1);
 * - a reasoning never followed by text: to end();
 * - with startInThought, from the first chunk (the first thought piece) to the </think>; a reasoning given back
 *   (`movedBack`) is no reasoning at all: no text, no duration.
 */
export class ReplyAccumulator {
  readonly #splitter: ReasoningSplitter;
  readonly #now: () => number;
  #reasoning = '';
  #firstChunkAt: number | undefined;
  #reasoningStart: number | undefined;
  #reasoningEnd: number | undefined;
  #endedAt: number | undefined;

  constructor(now: () => number = () => performance.now(), options: SplitOptions = {}) {
    this.#now = now;
    this.#splitter = new ReasoningSplitter(options);
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
      if (piece.kind === 'movedBack') {
        // Only a provisional reasoning is given back, and it comes before any other: none is left.
        this.#reasoning = '';
        this.#reasoningStart = undefined;
        this.#reasoningEnd = undefined;
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
