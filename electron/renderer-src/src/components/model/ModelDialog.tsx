import { useCallback, useEffect, useState } from 'react';
import { addGguf, getModelStatus, listGguf, pickGguf, removeGguf, saveGlobalSettings, type GgufEntry, type ModelStatus } from '../../ipc/bridge';
import { cleanIpcError } from '../../ipc/errors';
import { Modal } from '../settings/Modal';

function formatSize(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)} Go` : `${Math.round(bytes / (1024 * 1024))} Mo`;
}

// "j'importe mes fichiers .gguf dans ma librairie et c'est nous qui alimentons ce fichier pour le
// réveiller si le modèle est sélectionné" — no URL, no API key, no external tool: the app's own engine loads
// the file. These .gguf files are the only models the app runs.
function LocalModelsSection({ activeId, onActivate }: { activeId: string; onActivate(id: string): void }) {
  const [entries, setEntries] = useState<GgufEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => listGguf().then(setEntries).catch(error_ => setError(cleanIpcError(error_)));
  useEffect(() => { void refresh(); }, []);

  const activate = async (id: string) => {
    setError(null);
    try {
      await saveGlobalSettings({ active_local_model: id });
      onActivate(id);
    } catch (error_) {
      setError(cleanIpcError(error_));
    }
  };

  const importFile = async () => {
    setError(null);
    setBusy(true);
    try {
      const path = await pickGguf();
      if (!path) return; // the native dialog was cancelled
      const entry = await addGguf(path);
      await refresh();
      await activate(entry.id);
    } catch (error_) {
      setError(cleanIpcError(error_));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await removeGguf(id);
      if (id === activeId) await activate('');
      await refresh();
    } catch (error_) {
      setError(cleanIpcError(error_));
    }
  };

  return (
    <div className="mt-4">
      <div className="mb-2 text-xs uppercase tracking-widest text-gray-500">Modèles locaux (.gguf)</div>
      <div data-testid="oa-local-models" className="flex flex-col gap-1.5">
        {entries === null ? (
          <div className="text-xs text-gray-600">Chargement…</div>
        ) : entries.length === 0 ? (
          <div className="text-xs text-gray-600">Aucun modèle importé.</div>
        ) : (
          entries.map(entry => (
            <div
              key={entry.id}
              data-testid="oa-local-model-entry"
              data-active={entry.id === activeId ? 'true' : undefined}
              className="flex items-center gap-2 rounded-lg px-3 py-2"
              style={{ background: entry.id === activeId ? '#1a0f2e' : '#1a1a1a', border: entry.id === activeId ? '1px solid #4c1d95' : '1px solid #2a2a2a' }}
            >
              <button
                type="button"
                data-testid="oa-local-model-select"
                onClick={() => void activate(entry.id)}
                className="flex flex-1 items-center gap-2 text-left"
              >
                {entry.id === activeId && <span className="text-purple-400">✓</span>}
                <span className="truncate font-mono text-xs text-gray-200">{entry.name}</span>
                <span className="ml-auto text-xs text-gray-600">{formatSize(entry.size_bytes)}</span>
              </button>
              <button
                type="button"
                data-testid="oa-local-model-remove"
                title="Retirer de la bibliothèque"
                aria-label="Retirer de la bibliothèque"
                onClick={() => void remove(entry.id)}
                className="text-xs text-gray-600 hover:text-red-400"
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>
      {activeId && <div className="mt-1.5 text-xs text-gray-600">Chargé en mémoire au premier message envoyé.</div>}
      <button
        type="button"
        id="oa-local-model-import-btn"
        disabled={busy}
        onClick={() => void importFile()}
        className="mt-2 rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-300 hover:border-purple-500 disabled:opacity-60"
      >
        📁 Importer un fichier .gguf
      </button>
      {error && <div data-testid="oa-local-model-error" className="mt-2 text-xs text-red-400">{error}</div>}
    </div>
  );
}

// model_modal.py's "Sélectionner un modèle", local only: the active .gguf as the worker sees it (model-status), then
// the library. No provider, no URL, no key: the model runs in the app, without a connection.
export function ModelDialog({ onClose }: { onClose(): void }) {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const refresh = useCallback(() => {
    getModelStatus().then(setStatus).catch(() => {});
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const state = status === null ? null : status.missing ? 'missing' : status.name ? 'active' : 'none';

  return (
    <Modal width={520} onClose={onClose}>
      <div className="mb-3 text-sm font-bold text-gray-200">Sélectionner un modèle</div>

      {state === 'active' && (
        <div
          data-testid="oa-model-active"
          data-state="active"
          className="mb-4 flex items-center gap-2 rounded-lg px-3 py-2"
          style={{ background: '#1a0f2e', border: '1px solid #4c1d95' }}
        >
          <span className="text-purple-400">✓</span>
          <span className="text-xs text-gray-400">Modèle actif</span>
          <span className="truncate font-mono text-xs text-purple-200">{status?.name}</span>
          <span className="ml-auto text-xs text-gray-600">local</span>
        </div>
      )}
      {state === 'missing' && (
        <div
          data-testid="oa-model-active"
          data-state="missing"
          className="mb-4 rounded-lg px-3 py-2 text-xs text-yellow-600"
          style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}
        >
          ⚠ Modèle local introuvable : choisis-en un autre.
        </div>
      )}
      {state === 'none' && (
        <div
          data-testid="oa-model-active"
          data-state="none"
          className="mb-4 rounded-lg px-3 py-2 text-xs text-yellow-600"
          style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}
        >
          ⚠ Aucun modèle sélectionné — importe un fichier .gguf.
        </div>
      )}

      <LocalModelsSection activeId={status && !status.missing ? status.id : ''} onActivate={refresh} />

      <div className="mt-4 flex items-center gap-2">
        <button id="oa-model-close-btn" onClick={onClose} className="rounded-lg bg-gray-800 px-4 py-2 text-xs text-gray-300 hover:bg-gray-700">
          Fermer
        </button>
      </div>
    </Modal>
  );
}
