import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import * as bridge from '../ipc/bridge';
import { clearHistory, readProjectMemory } from '../ipc/bridge';
import { cleanIpcError } from '../ipc/errors';
import { Markdown } from '../markdown/Markdown';
import { useActionRegistry } from '../state/ActionRegistry';
import { currentBranchLabel } from '../state/branches';
import { useChat } from '../state/ChatProvider';
import { COMMANDS, displayMemory, isPaletteShortcut, matchCommands, moveSelection, type Command } from '../state/commands';
import { performExport, type ExportFormat } from '../state/export';
import { useToast } from '../state/ToastProvider';
import { Modal } from './settings/Modal';

type Dialog = 'memory' | 'confirm-clear' | 'export' | null;

// command_palette.py: Ctrl+K anywhere — even from the input box, which is exactly what the Python code has to
// take care of with `ignore=[]` — opens a 480 px window with a search field and one row per command. Clicking
// a row closes the palette, then runs the command. Keyboard selection (↑ ↓ Enter) is an addition.
export function CommandPalette({ onOpenSettings, onHistoryCleared }: { onOpenSettings(): void; onHistoryCleared(): void }) {
  const { state, activeFolder, compact } = useChat();
  const registry = useActionRegistry();
  const { notify } = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [focusToken, setFocusToken] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Capture phase on the window: the shortcut must work whatever has the focus, the input box included.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      // Like the original, opening again starts from a clean list.
      setQuery('');
      setSelected(0);
      setOpen(true);
      setFocusToken(token => token + 1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, focusToken]);

  const matches = matchCommands(COMMANDS, query);
  const active = matches.length === 0 ? -1 : Math.min(selected, matches.length - 1);

  const run = useCallback(
    (command: Command) => {
      setOpen(false);
      const needFolder = () => notify('Aucun dossier actif.', 'warning');
      switch (command.id) {
        case 'open-folder':
        case 'switch-model':
        case 'open-prompts':
          if (!registry.run(command.id)) notify('Cette action n’est pas disponible pour le moment.', 'negative');
          break;
        case 'open-settings':
          onOpenSettings();
          break;
        case 'clear-history':
          if (activeFolder) setDialog('confirm-clear');
          else needFolder();
          break;
        case 'show-memory':
          if (activeFolder) setDialog('memory');
          else needFolder();
          break;
        case 'export':
          if (activeFolder) setDialog('export');
          else needFolder();
          break;
        case 'compact':
          // Without a folder there is no conversation: the same warning as the original's "too short".
          if (activeFolder) void compact();
          else notify('Pas assez de messages à compresser.', 'warning');
          break;
      }
    },
    [activeFolder, compact, notify, onOpenSettings, registry],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected(moveSelection(active, event.key === 'ArrowDown' ? 1 : -1, matches.length));
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      run(matches[active]);
    }
  };

  const confirmClear = async () => {
    const folder = activeFolder;
    setDialog(null);
    if (!folder) return;
    try {
      await clearHistory(folder);
      // Announced BEFORE the chat is rebuilt: clearing remounts it, and this component with it.
      notify('Historique effacé.', 'positive');
      onHistoryCleared();
    } catch (error) {
      notify(cleanIpcError(error), 'negative');
    }
  };

  return (
    <>
      {open && (
        <Modal width={480} onClose={() => setOpen(false)} dismissOnBackdrop>
          <div data-testid="oa-palette">
            <input
              ref={inputRef}
              id="oa-palette-input"
              type="text"
              value={query}
              placeholder="Rechercher une commande…"
              onChange={event => { setQuery(event.target.value); setSelected(0); }}
              onKeyDown={handleKeyDown}
              className="w-full rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200 outline-none"
            />
            <div className="mt-2 flex w-full flex-col">
              {matches.length === 0 && (
                <span data-testid="oa-palette-empty" className="px-2 py-2 text-xs text-gray-600">
                  Aucune commande trouvée.
                </span>
              )}
              {matches.map((command, index) => (
                <button
                  key={command.id}
                  type="button"
                  data-testid="oa-palette-item"
                  data-command-id={command.id}
                  data-selected={index === active}
                  onClick={() => run(command)}
                  onMouseEnter={() => setSelected(index)}
                  className={`flex w-full cursor-pointer flex-col rounded px-2 py-2 text-left hover:bg-gray-800 ${index === active ? 'bg-gray-800' : ''}`}
                >
                  <span className="text-xs text-gray-200">{command.label}</span>
                  <span className="text-xs text-gray-600">{command.description}</span>
                </button>
              ))}
            </div>
          </div>
        </Modal>
      )}
      {dialog === 'confirm-clear' && (
        <Modal width={420} tone="danger" onClose={() => setDialog(null)}>
          <div data-testid="oa-clear-confirm">
            <div className="mb-2 text-sm font-bold text-red-400">Confirmer l’effacement</div>
            <div className="mb-3 text-xs text-gray-400">Tous les messages de « {activeFolder} » seront effacés.</div>
            <div className="flex gap-2">
              <button id="oa-palette-clear-ok-btn" type="button" onClick={() => void confirmClear()} className="rounded bg-red-900 px-3 py-1 text-xs text-red-300">
                Effacer
              </button>
              <button id="oa-palette-clear-cancel-btn" type="button" onClick={() => setDialog(null)} className="rounded bg-gray-800 px-3 py-1 text-xs text-gray-300">
                Annuler
              </button>
            </div>
          </div>
        </Modal>
      )}
      {dialog === 'memory' && activeFolder && <MemoryDialog folder={activeFolder} onClose={() => setDialog(null)} />}
      {dialog === 'export' && activeFolder && (
        <ExportDialog
          folder={activeFolder}
          branchId={state.currentBranchId}
          branchLabel={currentBranchLabel(state.branches, state.currentBranchId)}
          notify={notify}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

// "⬇ Exporter la conversation" from the palette: the same 3 formats and "Depuis : <branche>" line as
// TopBar's ExportMenu, in a Modal instead of an anchored dropdown — the palette itself is already a
// Modal, so this is a second dialog on top of it, matching how "Vider l'historique" confirms.
function ExportDialog({
  folder,
  branchId,
  branchLabel,
  notify,
  onClose,
}: {
  folder: string;
  branchId: string;
  branchLabel: string;
  notify: ReturnType<typeof useToast>['notify'];
  onClose(): void;
}) {
  const run = (format: ExportFormat) => {
    onClose();
    void performExport(bridge, folder, branchId, format, notify);
  };
  return (
    <Modal width={360} onClose={onClose} dismissOnBackdrop>
      <div data-testid="oa-export-dialog">
        <div className="mb-1 text-sm font-bold text-gray-200">Exporter la conversation</div>
        <div className="mb-3 text-xs text-gray-500">Depuis : {branchLabel}</div>
        <div className="flex flex-col gap-2">
          <button id="oa-export-dialog-md" type="button" onClick={() => run('md')} className="w-full rounded bg-gray-800 px-3 py-1.5 text-left text-xs text-gray-200 hover:bg-gray-700">
            Markdown (.md)
          </button>
          <button id="oa-export-dialog-html" type="button" onClick={() => run('html')} className="w-full rounded bg-gray-800 px-3 py-1.5 text-left text-xs text-gray-200 hover:bg-gray-700">
            HTML (.html)
          </button>
          <button id="oa-export-dialog-json" type="button" onClick={() => run('json')} className="w-full rounded bg-gray-800 px-3 py-1.5 text-left text-xs text-gray-200 hover:bg-gray-700">
            JSON (.json)
          </button>
        </div>
      </div>
    </Modal>
  );
}

// "🧠 Mémoire projet": the project's memory.md rendered as Markdown, read-only.
function MemoryDialog({ folder, onClose }: { folder: string; onClose(): void }) {
  const [memory, setMemory] = useState<{ content: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    readProjectMemory(folder)
      .then(result => { if (!cancelled) setMemory(result); })
      .catch(reason => { if (!cancelled) setError(cleanIpcError(reason)); });
    return () => { cancelled = true; };
  }, [folder]);

  // Judged after the dated comments are removed: a memory made only of them is an empty memory.
  const shown = memory ? displayMemory(memory.content) : '';

  return (
    <Modal width={600} onClose={onClose} dismissOnBackdrop>
      <div data-testid="oa-memory-dialog">
        <div className="mb-2 text-sm font-bold">🧠 Mémoire projet</div>
        {error && <div data-testid="oa-memory-error" className="text-xs text-red-400">{error}</div>}
        {memory && memory.truncated && (
          <div data-testid="oa-memory-truncated" className="mb-2 text-xs text-yellow-600">
            … début omis : seule la fin de la mémoire est affichée.
          </div>
        )}
        {memory && shown.trim() === '' && (
          <div data-testid="oa-memory-empty" className="text-xs text-gray-500">Aucune mémoire enregistrée pour ce projet.</div>
        )}
        {memory && shown.trim() !== '' && (
          <div data-testid="oa-memory-content" className="text-xs">
            <Markdown>{shown}</Markdown>
          </div>
        )}
        <button id="oa-memory-close-btn" type="button" onClick={onClose} className="mt-2 rounded bg-gray-800 px-3 py-1 text-xs text-gray-300">
          Fermer
        </button>
      </div>
    </Modal>
  );
}
