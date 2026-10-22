import type { SyntheticEvent } from 'react';
import { reasoningSummary } from '../state/turn-status';

/**
 * A reply's reasoning, folded under « Réflexion » (plain text, never markdown: it is the model's draft, not its answer).
 * `open` is where the block stands until the user opens or folds it: the streaming bubble passes « the model is
 * reasoning » (open while it thinks, folded once it writes), a finished message passes false. `chosen` is the user's
 * choice once made (ChatState.reasoningChoices, kept by message index, so it survives the streamed bubble turning into
 * the saved reply); it wins over `open`.
 */
export function ReasoningBlock({ text, open: wanted, chosen, onChoose, streaming = false, ms }: {
  text: string;
  open: boolean;
  chosen?: boolean;
  onChoose?: (open: boolean) => void;
  streaming?: boolean;
  ms?: number;
}) {
  const shown = chosen ?? wanted;

  // `toggle` also fires after a change made by the code (the `open` prop): only a change that the shown state did not
  // ask for is the user's.
  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    const now = event.currentTarget.open;
    if (now !== shown) onChoose?.(now);
  };

  return (
    <details data-testid="oa-reasoning" open={shown} onToggle={onToggle} className="mb-2">
      <summary data-testid="oa-reasoning-summary" className="cursor-pointer select-none text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {reasoningSummary({ streaming, ms })}
      </summary>
      <div
        data-testid="oa-reasoning-text"
        className="whitespace-pre-wrap text-[11px]"
        style={{ color: 'var(--text-muted)', borderLeft: '2px solid var(--text-muted)', paddingLeft: 8, marginTop: 4 }}
      >
        {text}
      </div>
    </details>
  );
}
