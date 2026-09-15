// The theme toggle/accent picker in the top strip exist only to prove ThemeProvider
// end-to-end and will move into the real Settings/TopBar components in Tâche 10+. The
// bare textarea+button below ChatView is a throwaway stand-in for the real InputBar
// (keyboard shortcuts, attachments, model picker, ...), which Tâche 8 replaces it with.
import { useState } from 'react';
import { useTheme } from './theme/ThemeProvider';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { ChatProvider, useChat } from './state/ChatProvider';

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

function TempInputBar() {
  const { state, send, stopRun } = useChat();
  const [text, setText] = useState('');

  const handleSend = async () => {
    if (!text.trim() || state.agentRunning) return;
    const toSend = text;
    setText('');
    await send(toSend);
  };

  return (
    <div style={{ display: 'flex', gap: '0.5rem', borderTop: '1px solid var(--border)', padding: '0.5rem' }}>
      <textarea
        id="oa-temp-input"
        value={text}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void handleSend();
          }
        }}
        placeholder="Un message…"
        style={{
          flex: 1,
          minHeight: 40,
          resize: 'none',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          color: 'var(--text)',
          padding: '0.5rem',
          fontSize: '0.75rem',
        }}
      />
      <button
        id="oa-temp-send"
        onClick={() => (state.agentRunning ? stopRun() : handleSend())}
        style={{
          background: state.agentRunning ? '#b91c1c' : '#9333ea',
          color: 'white',
          borderRadius: '8px',
          width: 40,
          border: 'none',
          cursor: 'pointer',
        }}
      >
        {state.agentRunning ? '■' : '➤'}
      </button>
    </div>
  );
}

export default function App() {
  const [activeFolder, setActiveFolder] = useState<string | null>(null);

  return (
    <div style={{ display: 'flex', height: '100%', width: '100%', background: 'var(--bg)' }}>
      <Sidebar activeFolder={activeFolder} onActivated={setActiveFolder} />
      <div style={{ display: 'flex', flex: 1, flexDirection: 'column', minWidth: 0 }}>
        <TempThemeStrip />
        {activeFolder && (
          <div style={{ padding: '0 0.75rem 0.25rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            ▸ {activeFolder}
          </div>
        )}
        <ChatProvider activeFolder={activeFolder}>
          <div style={{ display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0 }}>
            <ChatView />
            <TempInputBar />
          </div>
        </ChatProvider>
      </div>
    </div>
  );
}
