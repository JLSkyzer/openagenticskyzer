// The theme toggle/accent picker in the top strip exist only to prove ThemeProvider
// end-to-end and will move into the real Settings/TopBar components in Tâche 10+.
import { useState } from 'react';
import { useTheme } from './theme/ThemeProvider';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { InputBar } from './components/InputBar';
import { ChatProvider } from './state/ChatProvider';
import type { ChatMessage } from './ipc/bridge';

function TempThemeStrip() {
  const { theme, accent, setTheme, setAccent } = useTheme();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem', color: 'var(--text)' }}>
      <button
        id="oa-theme-toggle-btn"
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          color: 'var(--text)',
          borderRadius: '6px',
          padding: '0.3rem 0.6rem',
          cursor: 'pointer',
          fontSize: '0.75rem',
        }}
      >
        {theme === 'dark' ? '🌙' : '☀️'}
      </button>
      <input type="color" value={accent} onChange={event => setAccent(event.target.value)} />
    </div>
  );
}

export default function App() {
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [initialMessages, setInitialMessages] = useState<ChatMessage[]>([]);

  return (
    <div style={{ display: 'flex', height: '100%', width: '100%', background: 'var(--bg)' }}>
      <Sidebar
        activeFolder={activeFolder}
        onActivated={(folder, history) => {
          setActiveFolder(folder);
          setInitialMessages(history);
        }}
      />
      <div style={{ display: 'flex', flex: 1, flexDirection: 'column', minWidth: 0 }}>
        <TempThemeStrip />
        {activeFolder && (
          <div style={{ padding: '0 0.75rem 0.25rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            ▸ {activeFolder}
          </div>
        )}
        <ChatProvider activeFolder={activeFolder} initialMessages={initialMessages}>
          <div style={{ display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0 }}>
            <ChatView />
            <InputBar />
          </div>
        </ChatProvider>
      </div>
    </div>
  );
}
