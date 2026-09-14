// Minimal placeholder for the socle bootstrap task (Tâche 3/5a). Layout, sidebar, chat
// and input are wired in subsequent tasks of the same lot — the theme toggle/accent
// picker below exist only to prove ThemeProvider end-to-end and will move into the real
// Settings/TopBar components in Tâche 10+.
import { useTheme } from './theme/ThemeProvider';

export default function App() {
  const { theme, accent, setTheme, setAccent } = useTheme();
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1rem',
        height: '100%',
        width: '100%',
        background: 'var(--bg)',
      }}
    >
      <span style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--accent)' }}>◈ openagent</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text)' }}>
        <button
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
  );
}
