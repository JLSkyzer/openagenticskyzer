// Chat/input are wired in subsequent tasks of the same lot (Tâche 7/8) — the theme
// toggle/accent picker below exist only to prove ThemeProvider end-to-end and will move
// into the real Settings/TopBar components in Tâche 10+.
import { useState } from 'react';
import { useTheme } from './theme/ThemeProvider';
import { Sidebar } from './components/Sidebar';

export default function App() {
  const { theme, accent, setTheme, setAccent } = useTheme();
  const [activeFolder, setActiveFolder] = useState<string | null>(null);

  return (
    <div style={{ display: 'flex', height: '100%', width: '100%', background: 'var(--bg)' }}>
      <Sidebar activeFolder={activeFolder} onActivated={setActiveFolder} />
      <div
        style={{
          display: 'flex',
          flex: 1,
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1rem',
        }}
      >
        <span style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--accent)' }}>◈ openagent</span>
        {activeFolder && <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>▸ {activeFolder}</span>}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text)' }}>
          <button
            id="oa-theme-toggle-btn"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              color: 'var(--text)',
              borderRadius: '6px',
              padding: '0.4rem 0.75rem',
              cursor: 'pointer',
            }}
          >
            {theme === 'dark' ? '🌙 Sombre' : '☀️ Clair'}
          </button>
          <input type="color" value={accent} onChange={event => setAccent(event.target.value)} />
        </div>
      </div>
    </div>
  );
}
