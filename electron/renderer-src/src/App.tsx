import { useCallback, useState } from 'react';
import { TopBar } from './components/TopBar';
import { SettingsDialog } from './components/settings/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { ContextBar } from './components/ContextBar';
import { CommandPalette } from './components/CommandPalette';
import { InputBar } from './components/InputBar';
import { ChatProvider } from './state/ChatProvider';
import type { ChatMessage } from './ipc/bridge';

// Layout copied from main.py: a full-width top bar (38px) above everything, then a row
// (sidebar 230px + flexible chat column) filling the rest of the window.
export default function App() {
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  // Lifted from ChatProvider via onBranchChange so TopBar's export menu can show "Depuis : <branche>"
  // without living inside the provider (see TopBar.tsx and ChatProvider.tsx).
  const [branch, setBranch] = useState<{ id: string; label: string }>({ id: 'main', label: '🌿 Main' });
  const [initialMessages, setInitialMessages] = useState<ChatMessage[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  // Bumped to remount the chat (dropping its in-memory messages) and to make the sidebar
  // re-read the folder history after the settings' danger zone changed them on disk.
  const [chatEpoch, setChatEpoch] = useState(0);
  const [sidebarRefresh, setSidebarRefresh] = useState(0);
  const historyCleared = useCallback(() => {
    setInitialMessages([]);
    setChatEpoch(epoch => epoch + 1);
  }, []);
  const folderRemoved = useCallback(() => {
    setActiveFolder(null);
    setInitialMessages([]);
    setChatEpoch(epoch => epoch + 1);
    setSidebarRefresh(token => token + 1);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', background: 'var(--bg)' }}>
      <TopBar activeFolder={activeFolder} branch={branch} onOpenSettings={() => setSettingsOpen(true)} />
      {settingsOpen && (
        <SettingsDialog
          activeFolder={activeFolder}
          onClose={closeSettings}
          onHistoryCleared={historyCleared}
          onFolderRemoved={folderRemoved}
        />
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Sidebar
          activeFolder={activeFolder}
          refreshToken={sidebarRefresh}
          onActivated={(folder, history) => {
            setActiveFolder(folder);
            setInitialMessages(history);
          }}
        />
        <ChatProvider key={chatEpoch} activeFolder={activeFolder} initialMessages={initialMessages} onBranchChange={setBranch}>
          <CommandPalette onOpenSettings={() => setSettingsOpen(true)} onHistoryCleared={historyCleared} />
          <div style={{ display: 'flex', flex: 1, flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
            <ChatView />
            <ContextBar />
            <InputBar />
          </div>
        </ChatProvider>
      </div>
    </div>
  );
}
