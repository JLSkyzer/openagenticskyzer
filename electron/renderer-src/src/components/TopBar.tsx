import { ExportMenu } from './ExportMenu';

// Styles copied from main.py's top bar: 38px, bg var(--surface,#161616), border-bottom
// var(--border,#2a2a2a), logo text-sm font-bold text-purple-500.
function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

// Downloads are explicitly out of scope for this lot (téléchargements — see the plans) but the real
// top bar shows it as a stub rather than omitting it, matching main.py's layout exactly. Export was
// a stub too, until this lot.
function StubButton({ label, title }: { label: string; title: string }) {
  return (
    <button
      disabled
      title={`${title} — à venir`}
      className="flex h-7 w-7 items-center justify-center rounded text-xs text-gray-600"
      style={{ background: '#111', border: '1px solid #1f2937', cursor: 'not-allowed' }}
    >
      {label}
    </button>
  );
}

interface TopBarProps {
  activeFolder: string | null;
  // Lifted up from ChatProvider by App (see its own comment): TopBar sits outside the provider on
  // purpose, so it cannot call useChat() itself.
  branch: { id: string; label: string };
  onOpenSettings(): void;
}

export function TopBar({ activeFolder, branch, onOpenSettings }: TopBarProps) {
  return (
    <div
      className="flex shrink-0 items-center gap-2 px-3"
      style={{ height: 38, background: 'var(--surface, #161616)', borderBottom: '1px solid var(--border, #2a2a2a)' }}
    >
      <span className="text-sm font-bold text-purple-500">◈ openagent</span>
      {activeFolder && <span className="truncate text-xs text-gray-600">▸ {basename(activeFolder)}</span>}
      <div className="flex-1" />
      <StubButton label="📥" title="Téléchargements" />
      <ExportMenu activeFolder={activeFolder} branchId={branch.id} branchLabel={branch.label} />
      <button
        id="oa-settings-btn"
        onClick={onOpenSettings}
        title="Paramètres"
        className="flex h-7 w-7 items-center justify-center rounded border border-gray-800 bg-gray-900 text-xs text-purple-400 hover:border-purple-500"
      >
        ⚙️
      </button>
    </div>
  );
}
