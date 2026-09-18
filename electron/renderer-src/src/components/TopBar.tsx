import { useTheme } from '../theme/ThemeProvider';

// Styles copied from main.py's top bar: 38px, bg var(--surface,#161616), border-bottom
// var(--border,#2a2a2a), logo text-sm font-bold text-purple-500.
function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

// Downloads/export/settings are explicitly out of scope for this lot (téléchargements,
// réglages 7 onglets — see the socle plan) but the real top bar shows them as stubs
// rather than omitting them, matching main.py's layout exactly.
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

// The theme toggle/accent picker have no real Settings panel to live in yet (réglages 7
// onglets is out of scope for this whole lot) — kept here, clearly temporary, rather
// than invented a fake Settings dialog just to host two controls.
function ThemeControls() {
  const { theme, accent, setTheme, setAccent } = useTheme();
  return (
    <div className="flex items-center gap-1">
      <button
        id="oa-theme-toggle-btn"
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        className="flex h-7 items-center rounded px-2 text-xs"
        style={{ background: '#111', border: '1px solid #1f2937', color: 'var(--text)', cursor: 'pointer' }}
      >
        {theme === 'dark' ? '🌙' : '☀️'}
      </button>
      <input
        type="color"
        value={accent}
        onChange={event => setAccent(event.target.value)}
        className="h-7 w-7 cursor-pointer rounded border-0 bg-transparent p-0"
      />
    </div>
  );
}

export function TopBar({ activeFolder }: { activeFolder: string | null }) {
  return (
    <div
      className="flex shrink-0 items-center gap-2 px-3"
      style={{ height: 38, background: 'var(--surface, #161616)', borderBottom: '1px solid var(--border, #2a2a2a)' }}
    >
      <span className="text-sm font-bold text-purple-500">◈ openagent</span>
      {activeFolder && <span className="truncate text-xs text-gray-600">▸ {basename(activeFolder)}</span>}
      <div className="flex-1" />
      <ThemeControls />
      <StubButton label="📥" title="Téléchargements" />
      <StubButton label="⬇" title="Exporter" />
      <StubButton label="⚙️" title="Paramètres" />
    </div>
  );
}
