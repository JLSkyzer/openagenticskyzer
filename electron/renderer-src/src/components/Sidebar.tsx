import { useCallback, useEffect, useRef, useState } from 'react';
import { activateFolder, getGlobalSettings, gitStatus, initProject, listFolders, openFolderDialog, type ChatMessage, type FolderListItem, type GitStatus } from '../ipc/bridge';
import { useRegisterAction } from '../state/ActionRegistry';
import { KnowledgeSection } from './KnowledgeSection';
import { Modal } from './settings/Modal';
import { useToast } from '../state/ToastProvider';

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
  const [gitInfo, setGitInfo] = useState<GitStatus | null>(null);
  const [initConfirm, setInitConfirm] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const { notify } = useToast();

  useEffect(() => {
    listFolders()
      .then(setFolders)
      .catch(() => {});
  }, [refreshToken]);

  useEffect(() => {
    setGitInfo(null);
    if (!activeFolder) return;
    let stale = false;
    gitStatus(activeFolder)
      .then(status => { if (!stale) setGitInfo(status); })
      .catch(() => {});
    return () => { stale = true; };
  }, [activeFolder]);

  const activate = useCallback(
    async (folder: string) => {
      const result = await activateFolder(folder);
      setFolders(result.folders);
      onActivated(folder, result.history);
    },
    [onActivated],
  );

  // Restaure le dernier dossier utilisé au démarrage (main.py:254-267) — réutilise `activate()`
  // telle quelle : activate_folder renvoie déjà l'historique de chat, et ChatProvider résout déjà
  // la connexion/le modèle et les branches à chaque changement de `activeFolder`, quelle que soit
  // la façon dont il a changé (clic ou restauration automatique). Aucun nouvel op, aucune nouvelle
  // fonction bridge. `activeFolderRef` (plutôt que la prop close dans l'effet) pour ne jamais
  // écraser un dossier déjà activé entre-temps (onboarding, clic manuel) — la même course que
  // Python évite en testant `not state.active_folder` juste avant d'écrire. Une seule tentative
  // par montage (`attempted`) ; toute erreur (dossier supprimé depuis, fichier illisible) est
  // avalée silencieusement, même comportement qu'avant l'existence de cette fonctionnalité.
  const activeFolderRef = useRef(activeFolder);
  activeFolderRef.current = activeFolder;
  const attempted = useRef(false);
  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    (async () => {
      try {
        const [settings, list] = await Promise.all([getGlobalSettings(), listFolders()]);
        if (activeFolderRef.current || settings.restore_last_folder === false || !list[0]) return;
        await activate(list[0].path);
      } catch {
        /* dossier supprimé depuis, ou lecture impossible : on démarre sans dossier actif */
      }
    })();
    // Volontairement unique au montage : `activate`/`activeFolder` sont lus via des refs pour que
    // cet effet ne se redéclenche jamais lui-même.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const handleInitProject = useCallback(() => {
    if (!activeFolder) { notify("Ouvre un dossier d'abord.", 'warning'); return; }
    setInitConfirm(true);
  }, [activeFolder, notify]);

  const confirmInitProject = useCallback(async () => {
    if (!activeFolder) return;
    setInitConfirm(false);
    setInitializing(true);
    try {
      // The dialog's own wording already covers both "create" and "overwrite" — see the
      // rationale in tasks/todo.md (Tâche 85) for why this collapses Python's two-message
      // create-vs-overwrite flow into one confirmation instead of a separate exists-check op.
      const result = await initProject(activeFolder, true);
      notify(result.message, result.success ? 'positive' : 'negative');
    } catch (error) {
      notify(error instanceof Error ? error.message : "Impossible d'initialiser le projet.", 'negative');
    } finally {
      setInitializing(false);
    }
  }, [activeFolder, notify]);

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
        <button
          id="oa-init-project-btn"
          onClick={handleInitProject}
          disabled={initializing}
          className="mt-2 w-full rounded text-xs text-gray-400 hover:text-gray-200 disabled:opacity-60"
        >
          {initializing ? 'Analyse…' : '⚡ Init projet'}
        </button>
      </div>
      {initConfirm && activeFolder && (
        <Modal onClose={() => setInitConfirm(false)}>
          <div className="mb-2 text-sm font-bold text-gray-200">
            Créer ou remplacer OPENAGENT.md à partir de l’analyse de ce dossier ?
          </div>
          <div className="mb-3 break-all font-mono text-xs text-gray-500">{activeFolder}</div>
          <div className="flex gap-2">
            <button id="oa-init-project-confirm-btn" onClick={() => void confirmInitProject()} className="rounded bg-purple-700 px-3 py-1.5 text-xs text-white hover:bg-purple-600">
              Confirmer
            </button>
            <button id="oa-init-project-cancel-btn" onClick={() => setInitConfirm(false)} className="rounded bg-gray-800 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700">
              Annuler
            </button>
          </div>
        </Modal>
      )}
      {gitInfo && (
        <div
          data-testid="oa-git-status"
          data-dirty={gitInfo.dirty}
          className={'px-3 py-1 font-mono text-xs ' + (gitInfo.dirty ? 'text-yellow-400' : 'text-green-400')}
        >
          ⎇ {gitInfo.branch}
          {gitInfo.dirty ? ' ●' : ' ✓'}
        </div>
      )}
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
      <KnowledgeSection />
    </div>
  );
}
