// How much of a prompt the engine did not read again (pure): the tokens a context sequence held before a call, the
// tokens it holds after it, and what the call really evaluated (node-llama-cpp's tokenMeter).
//
// Bookkeeping caveats (pre-flight F27, node-llama-cpp 3.21.1): the tokenMeter counts the tokens a context shift moves
// as « input » (LlamaContext.js), and the prompt's last token as « output ». `evaluated` and `prompt` are therefore off
// by about one token, and `evaluated` is inflated after a shift: read a reuse figure after a shift with that in mind.

/** A hybrid or recurrent model's checkpoints, as its sequence reports them; null when it needs none. */
export interface CheckpointFigures { needed: boolean; memoryBytes: number; lastIndex: number }

export interface ReuseFigures {
  /** Tokens the sequence held before the call. */
  held: number;
  /** Common prefix of the held tokens and the tokens after the call: where the new prompt diverged. */
  common: number;
  /** ≈ prompt length: max(evaluated, after.length − outputTokens). */
  prompt: number;
  /** Input tokens actually evaluated (tokenMeter diff). */
  evaluated: number;
  /** max(0, prompt − evaluated). */
  reused: number;
  checkpoints: CheckpointFigures | null;
}

export function commonPrefixLength(a: readonly number[], b: readonly number[]): number {
  const end = Math.min(a.length, b.length);
  let i = 0;
  while (i < end && a[i] === b[i]) i++;
  return i;
}

export function reuseOf(p: { heldTokens: readonly number[]; afterTokens: readonly number[]; evaluated: number; outputTokens: number; checkpoints: CheckpointFigures | null }): ReuseFigures {
  const prompt = Math.max(p.evaluated, p.afterTokens.length - p.outputTokens);
  return {
    held: p.heldTokens.length,
    common: commonPrefixLength(p.heldTokens, p.afterTokens),
    prompt,
    evaluated: p.evaluated,
    reused: Math.max(0, prompt - p.evaluated),
    checkpoints: p.checkpoints,
  };
}
