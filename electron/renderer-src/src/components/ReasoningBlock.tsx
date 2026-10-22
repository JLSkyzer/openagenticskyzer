import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { reasoningSummary } from '../state/turn-status';

/**
 * A reply's reasoning, folded under « Réflexion » (plain text, never markdown: it is the model's draft, not its answer).
 * `open` is where the block starts and, until the user opens or folds it, where it follows: the streaming bubble passes
 * « the model is reasoning » (open while it thinks, folded once it writes), a finished message passes false. Once the
 * user has clicked the summary, the block is theirs.
 */
export function ReasoningBlock({ text, open: wanted, streaming = false, ms }: { text: string; open: boolean; streaming?: boolean; ms?: number }) {
  const [open, setOpen] = useState(wanted);
  const userChose = useRef(false);

  useEffect(() => {
    if (!userChose.current) setOpen(wanted);
  }, [wanted]);

  // `toggle` also fires after a change made by the code (the `open` prop): only a change the state did not ask for is
  // the user's.
  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    const now = event.currentTarget.open;
    if (now === open) return;
    userChose.current = true;
    setOpen(now);
  };

  return (
    <details data-testid="oa-reasoning" open={open} onToggle={onToggle} className="mb-2">
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
