import { useCallback, useState } from 'react';
import { TopBar } from './components/TopBar';
import { SettingsDialog } from './components/settings/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { InputBar } from './components/InputBar';
import { ChatProvider } from './state/ChatProvider';
import type { ChatMessage } from './ipc/bridge';

// Layout copied from main.py: a full-width top bar (38px) above everything, then a row
// (sidebar 230px + flexible chat column) filling the rest of the window.
export default function App() {
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [initialMessages, setInitialMessages] = useState<ChatMessage[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', background: 'var(--bg)' }}>
      <TopBar activeFolder={activeFolder} onOpenSettings={() => setSettingsOpen(true)} />
      {settingsOpen && <SettingsDialog activeFolder={activeFolder} onClose={closeSettings} />}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Sidebar
          activeFolder={activeFolder}
          onActivated={(folder, history) => {
            setActiveFolder(folder);
            setInitialMessages(history);
          }}
        />
        <ChatProvider activeFolder={activeFolder} initialMessages={initialMessages}>
          <div style={{ display: 'flex', flex: 1, flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
            <ChatView />
            <InputBar />
          </div>
        </ChatProvider>
      </div>
    </div>
  );
}
