import { emptyStateText } from '../state/empty-state';

export function EmptyState({ activeFolder }: { activeFolder: string | null }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <span className="text-2xl font-bold" style={{ color: 'var(--accent)' }}>
        ◈ openagent
      </span>
      <span data-testid="oa-empty-state" className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {emptyStateText(activeFolder)}
      </span>
    </div>
  );
}
