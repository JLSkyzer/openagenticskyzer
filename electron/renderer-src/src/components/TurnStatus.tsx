import { useEffect, useState } from 'react';
import { useChat } from '../state/ChatProvider';
import { formatElapsed, phaseLabel } from '../state/turn-status';

/** The running turn's status line, under the last message: what the turn is doing and a timer running since the send. */
export function TurnStatus() {
  const { state } = useChat();
  const { phase, turnStartedAt } = state;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (!phase) return null;
  return (
    <div
      role="status"
      data-testid="oa-turn-status"
      data-phase={phase.phase}
      className="flex items-center gap-2 px-4 py-2 text-xs"
      style={{ color: 'var(--text-muted, #9ca3af)' }}
    >
      {/* The dots are drawn by a 0-wide span's shadows (index.css), 30 px wide: the margin keeps the label clear of them. */}
      <span className="oa-typing-dots" aria-hidden="true" style={{ marginRight: 26 }} />
      <span data-testid="oa-turn-label">{phaseLabel(phase)}</span>
      {turnStartedAt !== null && (
        <span data-testid="oa-turn-timer" style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.8 }}>
          {formatElapsed(now - turnStartedAt)}
        </span>
      )}
    </div>
  );
}
