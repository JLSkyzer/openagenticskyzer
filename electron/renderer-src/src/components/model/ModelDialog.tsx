import { useEffect, useState } from 'react';
import {
  addGguf, getConnection, getGlobalSettings, listGguf, pickGguf, removeGguf, saveConnection, saveGlobalSettings,
  type ConnectionPatch, type ConnectionSnapshot, type GgufEntry, type ProviderName,
} from '../../ipc/bridge';
import { cleanIpcError } from '../../ipc/errors';
import { Modal } from '../settings/Modal';
import { PROVIDERS, defaultUrl } from './providers';

function formatSize(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)} Go` : `${Math.round(bytes / (1024 * 1024))} Mo`;
}

// "j'importe mes fichiers .gguf dans ma librairie et c'est nous qui alimentons ce fichier pour le
// réveiller si le modèle est sélectionné" — no URL, no API key, no external tool (Ollama/LM Studio/
// llama.cpp below are a DIFFERENT, pre-existing thing: a remote HTTP server the user runs themselves).
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

function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

const input = 'w-full rounded px-2 py-1.5 font-mono text-xs text-gray-200 outline-none';
const inputStyle = { background: '#1a1a1a', border: '1px solid #2a2a2a' };

interface FormState {
  provider: ProviderName;
  model: string;
  baseUrl: string;
  apiKey: string;
  clearKey: boolean;
  modelTouched: boolean;
  urlTouched: boolean;
}

const fromSnapshot = (snapshot: ConnectionSnapshot): FormState => ({
  provider: snapshot.provider,
  model: snapshot.model,
  baseUrl: snapshot.base_url,
  apiKey: '',
  clearKey: false,
  modelTouched: false,
  urlTouched: false,
});

// Mirrors model_modal.py's "Sélectionner un modèle" for the providers the Node engine
// knows. Model discovery/download for local runtimes is a separate, later piece of work.
export function ModelDialog({
  snapshot,
  activeFolder,
  onSaved,
  onClose,
}: {
  snapshot: ConnectionSnapshot | null;
  activeFolder: string | null;
  onSaved(snapshot: ConnectionSnapshot): void;
  onClose(): void;
}) {
  // What is shown as the active connection (updated after every successful save).
  const [current, setCurrent] = useState<ConnectionSnapshot | null>(snapshot);
  const [form, setForm] = useState<FormState>(
    snapshot ? fromSnapshot(snapshot) : { provider: 'openrouter', model: '', baseUrl: '', apiKey: '', clearKey: false, modelTouched: false, urlTouched: false },
  );
  // 'project' keeps this connection to the active folder; 'global' is the default for all.
  const [scope, setScope] = useState<'project' | 'global'>(activeFolder ? 'project' : 'global');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmUrl, setConfirmUrl] = useState<string | null>(null);
  const [activeLocalModel, setActiveLocalModel] = useState('');
  useEffect(() => {
    getGlobalSettings()
      .then(global => setActiveLocalModel(typeof global.active_local_model === 'string' ? global.active_local_model : ''))
      .catch(() => {});
  }, []);
  const [localEntries, setLocalEntries] = useState<GgufEntry[]>([]);
  useEffect(() => { listGguf().then(setLocalEntries).catch(() => {}); }, [activeLocalModel]);
  const activeLocalEntry = localEntries.find(entry => entry.id === activeLocalModel);

  const providerEntry = PROVIDERS.find(entry => entry.id === form.provider);
  const keyConfigured = current?.provider === form.provider && current.key_configured;

  const edit = (change: Partial<FormState>) => {
    setStatus(null);
    setError(null);
    setForm(previous => ({ ...previous, ...change }));
  };

  const changeProvider = (provider: ProviderName) => {
    // Another provider has its own saved profile (model, URL, key): show blanks and keep
    // whatever is stored unless the user types something.
    if (provider === current?.provider) {
      edit({ ...fromSnapshot(current), provider });
    } else {
      edit({ provider, model: '', baseUrl: '', apiKey: '', clearKey: false, modelTouched: false, urlTouched: false });
    }
  };

  const save = async (confirmEndpoint = false) => {
    setSaving(true);
    setStatus(null);
    setError(null);
    const patch: ConnectionPatch = { provider: form.provider };
    if (form.modelTouched) patch.model = form.model;
    if (form.urlTouched && form.baseUrl.trim()) patch.base_url = form.baseUrl.trim();
    if (form.apiKey) patch.api_key = form.apiKey;
    else if (form.clearKey) patch.api_key = null;
    try {
      await saveConnection(scope === 'project' ? activeFolder : null, patch, confirmEndpoint);
      // A remote connection and a local model are mutually exclusive: saving one takes over from the
      // other, exactly like picking a local model below clears whichever connection was active.
      if (activeLocalModel) { await saveGlobalSettings({ active_local_model: '' }); setActiveLocalModel(''); }
      // The active connection is what the chat will resolve for this folder, whichever
      // scope was just written.
      const fresh = await getConnection(activeFolder);
      setCurrent(fresh);
      setForm(fromSnapshot(fresh));
      setStatus('Connexion enregistrée.');
      onSaved(fresh);
    } catch (reason) {
      const message = cleanIpcError(reason);
      if (!confirmEndpoint && /Confirmation requise/i.test(message)) {
        setConfirmUrl(form.baseUrl.trim() || providerEntry?.url || '');
      } else {
        setError(message);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal width={520} onClose={onClose}>
      <div className="mb-3 text-sm font-bold text-gray-200">Sélectionner un modèle</div>

      {activeLocalModel ? (
        <div
          data-testid="oa-model-active"
          className="mb-4 flex items-center gap-2 rounded-lg px-3 py-2"
          style={{ background: '#1a0f2e', border: '1px solid #4c1d95' }}
        >
          <span className="text-purple-400">✓</span>
          <span className="text-xs text-gray-400">Modèle actif</span>
          <span className="truncate font-mono text-xs text-purple-200">{activeLocalEntry?.name ?? activeLocalModel}</span>
          <span className="ml-auto text-xs text-gray-600">local</span>
        </div>
      ) : current?.model ? (
        <div
          data-testid="oa-model-active"
          className="mb-4 flex items-center gap-2 rounded-lg px-3 py-2"
          style={{ background: '#1a0f2e', border: '1px solid #4c1d95' }}
        >
          <span className="text-purple-400">✓</span>
          <span className="text-xs text-gray-400">Modèle actif</span>
          <span className="truncate font-mono text-xs text-purple-200">{current.model}</span>
          <span className="ml-auto text-xs text-gray-600">{current.provider}</span>
        </div>
      ) : (
        <div
          data-testid="oa-model-active"
          className="mb-4 rounded-lg px-3 py-2 text-xs text-yellow-600"
          style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}
        >
          ⚠ Aucun modèle sélectionné
        </div>
      )}

      <div className="mb-2 text-xs uppercase tracking-widest text-gray-500">Connexion</div>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs text-gray-400">
          Fournisseur
          <select
            data-model-field="provider"
            value={form.provider}
            onChange={event => changeProvider(event.target.value as ProviderName)}
            className={input}
            style={inputStyle}
          >
            {PROVIDERS.map(entry => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-400">
          Modèle
          <input
            data-model-field="model"
            value={form.model}
            placeholder={current?.provider === form.provider ? 'ex. qwen2.5-coder' : 'Nom du modèle (vide = conserver l’existant)'}
            onChange={event => edit({ model: event.target.value, modelTouched: true })}
            className={input}
            style={inputStyle}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-400">
          URL de base
          <input
            data-model-field="base_url"
            value={form.baseUrl}
            placeholder={defaultUrl(form.provider)}
            onChange={event => edit({ baseUrl: event.target.value, urlTouched: true })}
            className={input}
            style={inputStyle}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-400">
          Clé API {providerEntry?.local && <span className="text-gray-600">(facultative en local)</span>}
          <input
            data-model-field="api_key"
            type="password"
            autoComplete="off"
            value={form.apiKey}
            placeholder={keyConfigured ? '•••••• (clé configurée — vide = conserver)' : 'Clé API'}
            onChange={event => edit({ apiKey: event.target.value, clearKey: false })}
            className={input}
            style={inputStyle}
          />
        </label>
        {keyConfigured && (
          <button
            id="oa-model-clear-key-btn"
            onClick={() => edit({ clearKey: !form.clearKey, apiKey: '' })}
            className={'self-start rounded border px-2 py-1 text-xs ' + (form.clearKey ? 'border-red-900 bg-red-950 text-red-400' : 'border-gray-700 bg-gray-900 text-gray-400')}
          >
            {form.clearKey ? '✕ La clé sera retirée' : 'Retirer la clé'}
          </button>
        )}
        {activeFolder && (
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            Enregistrer pour
            <select
              data-model-field="scope"
              value={scope}
              onChange={event => setScope(event.target.value as 'project' | 'global')}
              className={input}
              style={inputStyle}
            >
              <option value="project">Ce dossier ({basename(activeFolder)})</option>
              <option value="global">Tous les dossiers (global)</option>
            </select>
          </label>
        )}
      </div>

      <LocalModelsSection activeId={activeLocalModel} onActivate={setActiveLocalModel} />

      <div className="mt-4 flex items-center gap-2">
        <button
          id="oa-model-save-btn"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-lg bg-purple-600 px-4 py-2 text-xs text-white hover:bg-purple-700 disabled:opacity-60"
        >
          Enregistrer
        </button>
        <button id="oa-model-close-btn" onClick={onClose} className="rounded-lg bg-gray-800 px-4 py-2 text-xs text-gray-300 hover:bg-gray-700">
          Fermer
        </button>
        {status && (
          <span data-testid="oa-model-status" className="text-xs text-green-500">
            {status}
          </span>
        )}
        {error && (
          <span data-testid="oa-model-error" className="text-xs text-red-400">
            {error}
          </span>
        )}
      </div>

      {confirmUrl !== null && (
        <Modal tone="danger" width={440} onClose={() => setConfirmUrl(null)}>
          <div data-testid="oa-model-confirm">
            <div className="mb-2 text-sm font-bold text-red-400">Envoyer la clé à une autre URL ?</div>
            <div className="mb-2 text-xs text-gray-400">
              Une clé API est déjà enregistrée pour ce fournisseur. Elle sera transmise à :
            </div>
            <div className="mb-3 break-all font-mono text-xs text-gray-300">{confirmUrl}</div>
            <div className="mb-3 text-xs text-yellow-600">Ne confirmez que si vous faites confiance à ce serveur.</div>
            <div className="flex gap-2">
              <button
                id="oa-model-confirm-ok-btn"
                onClick={() => {
                  setConfirmUrl(null);
                  void save(true);
                }}
                className="rounded bg-red-900 px-3 py-1.5 text-xs text-red-300 hover:bg-red-800"
              >
                Confirmer
              </button>
              <button id="oa-model-confirm-cancel-btn" onClick={() => setConfirmUrl(null)} className="rounded bg-gray-800 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700">
                Annuler
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
