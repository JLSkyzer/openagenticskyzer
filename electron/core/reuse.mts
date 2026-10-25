// How much of a prompt the engine did not read again (pure): the tokens a context sequence held before a call, the
// tokens it holds after it, and what the call really evaluated (node-llama-cpp's tokenMeter).
//
// Bookkeeping caveats (pre-flight F27, node-llama-cpp 3.21.1): the tokenMeter counts the tokens a context shift moves
// as « input » (LlamaContext.js), and the prompt's last token as « output ». `evaluated` and `prompt` are therefore off
// by about one token, and `evaluated` is inflated after a shift: read a reuse figure after a shift with that in mind.

/** A hybrid or recurrent model's checkpoints, as its sequence reports them; null when it needs none. */
export interface CheckpointFigures { needed: boolean; memoryBytes: number; lastIndex: number }

/** What the promptCheckpoint lever did on one call (Task 3b, core/local-engine.mts::checkpointPromptEnd). `prompt`:
 * LlamaChat's prompt length; `stable`: how many of its first tokens the next turn renders the same; `from`: where the
 * held state stopped matching the prompt (what was evaluated from there); `index`: the checkpoint's last token
 * (`stable` − 1), null when none was taken (the state already held past `stable`, or the prompt fills the window). */
export interface PromptCheckpointFigures { prompt: number; stable: number; from: number; index: number | null }

export interface ReuseFigures {
  /** Tokens the sequence held before the call. */
  held: number;
  /** Common prefix of the held tokens and the tokens after the call: where the new prompt diverged. */
  common: number;
  /** ≈ prompt length: max(evaluated, after.length − outputTokens). */
  prompt: number;
  /** Input tokens actually evaluated (tokenMeter diff). */
  evaluated: number;
  /** What the sequence holds after the call that it did not evaluate nor generate in it: after.length − (Δinput +
   * Δoutput), both from the tokenMeter (M1: a tool call's tokens are not all in the streamed chunks), at least 0. */
  reused: number;
  checkpoints: CheckpointFigures | null;
  /** Only with the promptCheckpoint lever on (absent otherwise, so today's figures are unchanged). */
  promptCheckpoint?: PromptCheckpointFigures | null;
}

export function commonPrefixLength(a: readonly number[], b: readonly number[]): number {
  const end = Math.min(a.length, b.length);
  let i = 0;
  while (i < end && a[i] === b[i]) i++;
  return i;
}

/** `evaluated` and `outputTokens`: the call's tokenMeter deltas (usedInputTokens, usedOutputTokens). */
export function reuseOf(p: { heldTokens: readonly number[]; afterTokens: readonly number[]; evaluated: number; outputTokens: number; checkpoints: CheckpointFigures | null }): ReuseFigures {
  const prompt = Math.max(p.evaluated, p.afterTokens.length - p.outputTokens);
  return {
    held: p.heldTokens.length,
    common: commonPrefixLength(p.heldTokens, p.afterTokens),
    prompt,
    evaluated: p.evaluated,
    reused: Math.max(0, p.afterTokens.length - p.evaluated - p.outputTokens),
    checkpoints: p.checkpoints,
  };
}
