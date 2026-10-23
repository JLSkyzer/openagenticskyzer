// A turn's figures (pure: `now` is injected for the tests): how long the load took, how long the model read the
// request, when the first word of the answer came, the whole turn, and the output rate. The worker (runSend) feeds it
// the turn's events and joins timing() to `done`, to `stopped` and to the saved reply.
import type { GenerationStats, TurnTiming } from './model-types.mts';

export type { TurnTiming } from './model-types.mts';

const round1 = (value: number) => Math.round(value * 10) / 10;

export class TurnClock {
  readonly #startedAt: number;
  readonly #now: () => number;
  #loadStart: number | undefined;
  #loadEnd: number | undefined;
  #readStart: number | undefined;
  #firstChunk: number | undefined;
  /** The current step's first piece (a step starts at readStart). */
  #stepFirstChunk: number | undefined;
  #firstText: number | undefined;
  /** The current step's reasoning: its start, and its end (the first text piece after it), for reasoningMs. */
  #reasoningStart: number | undefined;
  #reasoningEnd: number | undefined;
  #stats = false;
  #outputTokens = 0;
  #generationMs = 0;

  constructor(startedAt: number, now: () => number = Date.now) {
    this.#startedAt = startedAt;
    this.#now = now;
  }

  /** A real load began. loadMs exists only once loadEnd ran: a load stopped or failed midway reports none. */
  loadStart(): void { this.#loadStart ??= this.#now(); }
  loadEnd(): void { if (this.#loadStart !== undefined) this.#loadEnd ??= this.#now(); }

  /** The model starts reading a request (one per step): the first call is the read start. */
  readStart(): void {
    this.#readStart ??= this.#now();
    this.#stepFirstChunk = undefined;
    this.#reasoningStart = undefined;
    this.#reasoningEnd = undefined;
  }

  /**
   * A piece of the reply. The first one ends readMs; the first 'text' one sets firstTextMs. A 'moved' piece is
   * reasoning that had been streamed as text (a bare </think>, core/reasoning-split.mts): it clears firstTextMs,
   * which the next 'text' piece sets again (ruling S1). A 'movedBack' piece is the reverse: a reply streamed as
   * reasoning (the template opened <think>, and no </think> came) was the answer, whose first word was the step's
   * first piece.
   */
  chunk(kind: 'thought' | 'text' | 'moved' | 'movedBack'): void {
    const now = this.#now();
    this.#firstChunk ??= now;
    this.#stepFirstChunk ??= now;
    if (kind === 'text') this.#firstText ??= now;
    else if (kind === 'moved') this.#firstText = undefined;
    else if (kind === 'movedBack') this.#firstText ??= this.#stepFirstChunk;
    // The step's reasoning, as the engine's ReplyAccumulator measures it, from the pieces alone (M-b: a stopped reply
    // keeps its reasoning's duration): a thought starts it, the first text after it ends it, a bare </think> (moved)
    // dates it from the step's first chunk to now, a reasoning given back (movedBack) was none.
    if (kind === 'thought') this.#reasoningStart ??= now;
    else if (kind === 'moved') { this.#reasoningStart = this.#stepFirstChunk; this.#reasoningEnd = now; }
    else if (kind === 'movedBack') { this.#reasoningStart = undefined; this.#reasoningEnd = undefined; }
    else if (this.#reasoningStart !== undefined) this.#reasoningEnd ??= now;
  }

  /** The current step's reasoning time: up to its end, or to now while it is still open (a stop); undefined when the
   * step has none. */
  reasoningMs(): number | undefined {
    if (this.#reasoningStart === undefined) return undefined;
    return Math.max(0, (this.#reasoningEnd ?? this.#now()) - this.#reasoningStart);
  }

  /** One generation's figures, summed over the turn's steps. Not the end of the stream: pieces may still follow. */
  stats(stats: GenerationStats): void {
    this.#stats = true;
    this.#outputTokens += stats.outputTokens;
    this.#generationMs += stats.generationMs;
  }

  timing(): TurnTiming {
    const timing: TurnTiming = { totalMs: Math.max(0, this.#now() - this.#startedAt) };
    if (this.#loadStart !== undefined && this.#loadEnd !== undefined) timing.loadMs = this.#loadEnd - this.#loadStart;
    if (this.#readStart !== undefined && this.#firstChunk !== undefined) timing.readMs = Math.max(0, this.#firstChunk - this.#readStart);
    if (this.#firstText !== undefined) timing.firstTextMs = this.#firstText - this.#startedAt;
    if (this.#stats) {
      timing.outputTokens = this.#outputTokens;
      // Never a division by 0: a step that wrote nothing (a tool call alone) reports 0 ms (ruling T2-m3).
      if (this.#outputTokens > 0 && this.#generationMs > 0) timing.tokensPerSecond = round1(this.#outputTokens / (this.#generationMs / 1000));
    }
    return timing;
  }
}
