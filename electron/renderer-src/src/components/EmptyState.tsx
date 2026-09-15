export function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <span className="text-2xl font-bold" style={{ color: 'var(--accent)' }}>
        ◈ openagent
      </span>
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Ouvre un dossier pour commencer.
      </span>
    </div>
  );
}
