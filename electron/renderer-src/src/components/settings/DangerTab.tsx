import { useState, type ReactNode } from 'react';
import { clearHistory, removeFolder, resetGlobalSettings } from '../../ipc/bridge';
import { Modal } from './Modal';

interface DangerTabProps {
  activeFolder: string | null;
  onHistoryCleared(): void;
  onFolderRemoved(): void;
  onGlobalReset(): void;
}

const dangerButton = 'rounded border border-red-900 bg-red-950 px-3 py-1.5 text-xs text-red-400 hover:bg-red-900';

function DangerRow({ label, hint, last, children }: { label: string; hint?: string; last?: boolean; children: ReactNode }) {
  return (
    <div className={'flex items-center gap-3 px-4 py-3 ' + (last ? '' : 'border-b border-red-950')}>
      <div className="flex flex-1 flex-col">
        <span className="text-xs font-medium text-red-300">{label}</span>
        {hint && <span className="text-xs text-red-900">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function cleanMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
}

// Mirrors settings.py::_tab_danger. None of these actions deletes project files.
export function DangerTab({ activeFolder, onHistoryCleared, onFolderRemoved, onGlobalReset }: DangerTabProps) {
  const [confirm, setConfirm] = useState<'clear' | 'reset' | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const run = async (action: () => Promise<string>) => {
    try {
      setMessage({ text: await action(), ok: true });
    } catch (error) {
      setMessage({ text: cleanMessage(error), ok: false });
    }
  };
  const needFolder = () => setMessage({ text: 'Aucun dossier actif.', ok: false });

  const doClear = () =>
    run(async () => {
      const { removed_messages } = await clearHistory(activeFolder!);
      onHistoryCleared();
      return `Historique effacé (${removed_messages} message(s)).`;
    });
  const doRemove = () =>
    run(async () => {
      await removeFolder(activeFolder!);
      onFolderRemoved();
      return 'Dossier retiré de la sidebar.';
    });
  const doReset = () =>
    run(async () => {
      await resetGlobalSettings();
      onGlobalReset();
      return 'Paramètres réinitialisés.';
    });

  return (
    <div className="flex flex-col gap-5">
      <span className="text-sm font-bold text-red-400">Zone Danger</span>
      <div className="overflow-hidden rounded-xl border border-red-900" style={{ background: '#120a0a' }}>
        <DangerRow label="Effacer l’historique du dossier actif" hint="Supprime toutes les conversations enregistrées pour ce dossier.">
          <button id="oa-danger-clear-btn" onClick={() => (activeFolder ? setConfirm('clear') : needFolder())} className={dangerButton}>
            🗑 Effacer
          </button>
        </DangerRow>
        <DangerRow label="Retirer ce dossier de la sidebar" hint="Ne supprime pas les fichiers, retire juste l’entrée de l’historique.">
          <button id="oa-danger-remove-btn" onClick={() => (activeFolder ? void doRemove() : needFolder())} className={dangerButton}>
            ✕ Retirer
          </button>
        </DangerRow>
        <DangerRow label="Réinitialiser tous les paramètres globaux" last>
          <button id="oa-danger-reset-btn" onClick={() => setConfirm('reset')} className={dangerButton}>
            ↺ Réinitialiser
          </button>
        </DangerRow>
      </div>
      {message && (
        <span data-testid="oa-danger-status" className={'text-xs ' + (message.ok ? 'text-green-500' : 'text-yellow-600')}>
          {message.text}
        </span>
      )}

      {confirm === 'clear' && activeFolder && (
        <Modal tone="danger" onClose={() => setConfirm(null)}>
          <div className="mb-2 text-sm font-bold text-red-400">Confirmer la suppression</div>
          <div className="mb-3 font-mono text-xs text-gray-400">{activeFolder}</div>
          <ConfirmButtons
            okLabel="Supprimer"
            onOk={() => {
              setConfirm(null);
              void doClear();
            }}
            onCancel={() => setConfirm(null)}
          />
        </Modal>
      )}
      {confirm === 'reset' && (
        <Modal tone="danger" onClose={() => setConfirm(null)}>
          <div className="mb-2 text-sm font-bold text-red-400">Réinitialiser les paramètres globaux ?</div>
          <div className="mb-3 text-xs text-gray-400">
            Thème, token HuggingFace, répertoire de données et tous les autres réglages globaux reviennent à leurs valeurs par défaut.
          </div>
          <ConfirmButtons
            okLabel="Réinitialiser"
            onOk={() => {
              setConfirm(null);
              void doReset();
            }}
            onCancel={() => setConfirm(null)}
          />
        </Modal>
      )}
    </div>
  );
}

function ConfirmButtons({ okLabel, onOk, onCancel }: { okLabel: string; onOk(): void; onCancel(): void }) {
  return (
    <div className="flex gap-2">
      <button id="oa-confirm-ok-btn" onClick={onOk} className="rounded bg-red-900 px-3 py-1.5 text-xs text-red-300 hover:bg-red-800">
        {okLabel}
      </button>
      <button id="oa-confirm-cancel-btn" onClick={onCancel} className="rounded bg-gray-800 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700">
        Annuler
      </button>
    </div>
  );
}
