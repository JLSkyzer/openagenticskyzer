import { useState } from 'react';
import { getConnection, saveConnection, type ConnectionPatch, type ConnectionSnapshot, type ProviderName } from '../../ipc/bridge';
import { cleanIpcError } from '../../ipc/errors';
import { Modal } from '../settings/Modal';
import { PROVIDERS, defaultUrl } from './providers';

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

      {current?.model ? (
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
