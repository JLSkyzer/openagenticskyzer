import { useChat } from '../state/ChatProvider';
import { contextLevel, formatContextLabel, shouldCompact, type ContextLevel } from '../state/context';

// context_bar.py: purple under 70 %, yellow under 90 %, red beyond.
const FILL: Record<ContextLevel, string> = { normal: 'bg-purple-600', warning: 'bg-yellow-500', critical: 'bg-red-500' };

// Same layout as context_bar.py::context_bar, shown between the chat and the input: "🧠 Contexte", a
// track of 120 px at most, "{pct}% · ~{tokens} tokens", and the "⚡ Auto-compact" button once the
// threshold is reached. Hidden when the "show_context_bar" setting is off.
export function ContextBar() {
  const { state, context, compact } = useChat();
  const { usage, settings } = context;
  if (!settings.show_context_bar) return null;

  const level = contextLevel(usage.pct);
  const busy = state.agentRunning || state.compacting;

  return (
    <div
      data-testid="oa-context-bar"
      className="flex w-full items-center gap-2 px-6 py-1"
      style={{ background: '#0f0f0f', borderTop: '1px solid #1e1e1e', minHeight: 28, flexShrink: 0 }}
    >
      <span className="text-xs text-gray-600">🧠 Contexte</span>
      <div className="h-1 flex-1 rounded bg-gray-800" style={{ maxWidth: 120 }}>
        <div
          data-testid="oa-context-fill"
          data-level={level}
          className={`h-1 rounded ${FILL[level]}`}
          style={{ width: `${Math.round(usage.pct)}%` }}
        />
      </div>
      <span data-testid="oa-context-label" className="text-xs text-gray-600">
        {formatContextLabel(usage)}
      </span>
      {state.compacting && (
        <span data-testid="oa-context-compacting" className="ml-2 text-xs text-gray-500">
          Compression en cours…
        </span>
      )}
      {shouldCompact(usage.pct, settings.compact_threshold) && (
        <button
          id="oa-compact-btn"
          type="button"
          disabled={busy}
          onClick={() => void compact()}
          className="ml-auto border bg-transparent px-2 py-0.5 text-xs text-purple-400 disabled:opacity-50"
          style={{ borderColor: '#581c87' }}
        >
          ⚡ Auto-compact
        </button>
      )}
    </div>
  );
}
