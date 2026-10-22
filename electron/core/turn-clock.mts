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
  #firstText: number | undefined;
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

  /** The model starts reading a request: the first call is the read start. */
  readStart(): void { this.#readStart ??= this.#now(); }

  /**
   * A piece of the reply. The first one ends readMs; the first 'text' one sets firstTextMs. A 'moved' piece is
   * reasoning that had been streamed as text (a bare </think>, core/reasoning-split.mts): it clears firstTextMs,
   * which the next 'text' piece sets again (ruling S1).
   */
  chunk(kind: 'thought' | 'text' | 'moved'): void {
    const now = this.#now();
    this.#firstChunk ??= now;
    if (kind === 'text') this.#firstText ??= now;
    else if (kind === 'moved') this.#firstText = undefined;
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
