import { useCallback, useEffect, useState } from 'react';
import { activateFolder, listFolders, openFolderDialog, type ChatMessage, type FolderListItem } from '../ipc/bridge';
import { useRegisterAction } from '../state/ActionRegistry';

interface SidebarProps {
  activeFolder: string | null;
  // Passes activate_folder's own history along with the folder — ChatProvider must not
  // re-fetch it separately: a second async round trip can resolve after a send has
  // already started and wipe it out.
  onActivated(folder: string, history: ChatMessage[]): void;
  // Bumped by the parent when the history list changed behind the sidebar's back (e.g. a
  // folder removed from the settings' danger zone) so it re-reads it.
  refreshToken?: number;
}

// Mirrors sidebar.py's truncation of the path shown under each folder name.
function truncatePath(path: string, max = 30): string {
  return path.length > max ? `${path.slice(0, max)}…` : path;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}

export function Sidebar({ activeFolder, onActivated, refreshToken = 0 }: SidebarProps) {
  const [folders, setFolders] = useState<FolderListItem[]>([]);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    listFolders()
      .then(setFolders)
      .catch(() => {});
  }, [refreshToken]);

  const activate = useCallback(
    async (folder: string) => {
      const result = await activateFolder(folder);
      setFolders(result.folders);
      onActivated(folder, result.history);
    },
    [onActivated],
  );

  const handleOpenFolder = useCallback(async () => {
    setOpening(true);
    try {
      const picked = await openFolderDialog();
      if (picked) await activate(picked);
    } catch {
      // The dialog was cancelled/failed or activation rejected — nothing to recover,
      // but the click handler must not leave an unhandled rejection behind.
    } finally {
      setOpening(false);
    }
  }, [activate]);

  // "📂 Ouvrir un dossier" of the command palette does exactly what the button does.
  useRegisterAction('open-folder', () => void handleOpenFolder());

  return (
    <div
      className="flex flex-col"
      style={{ width: 230, flexShrink: 0, background: 'var(--surface)', borderRight: '1px solid var(--border)' }}
    >
      <div className="border-b border-gray-800 p-2">
        <button
          id="oa-open-folder-btn"
          onClick={handleOpenFolder}
          disabled={opening}
          className="w-full rounded-lg bg-purple-600 px-3 py-2 text-xs font-bold text-white hover:bg-purple-700 disabled:opacity-60"
        >
          {opening ? '…' : '📂 Ouvrir un dossier'}
        </button>
      </div>
      <div className="px-3 pb-1 pt-3 text-xs uppercase tracking-widest text-gray-600">Historique des dossiers</div>
      <div className="flex-1 overflow-y-auto">
        {folders.map(entry => {
          const isActive = entry.path === activeFolder;
          return (
            <button
              key={entry.path}
              data-testid="oa-folder-entry"
              data-path={entry.path}
              data-active={isActive}
              onClick={() => activate(entry.path)}
              className={
                'oa-folder-entry block w-full border-l-2 px-3 py-2 text-left text-xs ' +
                (isActive
                  ? 'border-purple-500 bg-indigo-950 text-purple-300'
                  : 'border-transparent text-gray-400 hover:bg-gray-900')
              }
            >
              <div className="oa-folder-name truncate font-medium">{entry.name}</div>
              <div className="oa-folder-path truncate text-[11px] text-gray-600">
                {truncatePath(entry.path)} · {formatDate(entry.last_used)}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
