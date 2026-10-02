import { useEffect, useState } from 'react';
import type { SettingsDraft } from './useSettingsDraft';
import { Group, Row, Section, Toggle } from './parts';
import { checkForUpdates, getUpdateStatus, migrateDataDir, onUpdateStatus, pickDataDir, testHfToken, type UpdateStatus } from '../../ipc/bridge';
import { useToast } from '../../state/ToastProvider';

const button = 'self-start rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-300';

function updateText(update: UpdateStatus): string {
  if (!update.enabled) return 'Mises à jour désactivées (version de développement)';
  switch (update.status) {
    case 'idle': return 'Pas encore vérifié';
    case 'checking': return 'Vérification…';
    case 'available': return `Version ${update.version} disponible — téléchargement…`;
    case 'downloading': return `Téléchargement : ${update.percent ?? 0} %`;
    case 'ready': return `Version ${update.version} prête — elle s’installera à la fermeture`;
    case 'up-to-date': return 'À jour';
    case 'error': return `Échec : ${update.message ?? 'erreur inconnue'}`;
  }
}

// Mirrors settings.py::_tab_general.
export function GeneralTab({ draft }: { draft: SettingsDraft }) {
  const [showToken, setShowToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [editingDataDir, setEditingDataDir] = useState(false);
  const [newDataDir, setNewDataDir] = useState('');
  const [migrating, setMigrating] = useState(false);
  const { notify } = useToast();
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    let alive = true;
    getUpdateStatus().then(status => { if (alive) setUpdate(status); }).catch(() => {});
    const off = onUpdateStatus(status => setUpdate(status));
    return () => { alive = false; off(); };
  }, []);
  const runCheck = async () => {
    setChecking(true);
    try { setUpdate(await checkForUpdates()); }
    catch (error) { notify(error instanceof Error ? error.message : 'Vérification impossible.', 'negative'); }
    finally { setChecking(false); }
  };

  const dataHome = draft.get<string>('data_home', '');

  const startEditingDataDir = () => {
    setNewDataDir(dataHome);
    setEditingDataDir(true);
  };
  const browseDataDir = async () => {
    const picked = await pickDataDir();
    if (picked) setNewDataDir(picked);
  };
  const applyDataDir = async () => {
    const target = newDataDir.trim();
    if (!target) { notify('Chemin vide.', 'warning'); return; }
    setMigrating(true);
    try {
      const result = await migrateDataDir(target);
      const summary = result.errors.length
        ? `⚠️ ${result.moved} fichier(s) migré(s), ${result.errors.length} erreur(s).`
        : `✅ ${result.moved} fichier(s) migré(s).`;
      notify(`${summary} Redémarrez l’app pour appliquer.`, result.errors.length ? 'warning' : 'positive');
      setEditingDataDir(false);
    } catch (error) {
      notify(`Impossible de migrer : ${error instanceof Error ? error.message : 'erreur inconnue'}`, 'negative');
    } finally {
      setMigrating(false);
    }
  };

  const handleTestToken = async () => {
    const token = draft.get<string>('hf_token', '').trim();
    if (!token) { notify('Token vide.', 'warning'); return; }
    setTesting(true);
    try {
      const result = await testHfToken(token);
      notify(`✅ Connecté en tant que ${result.name}`, 'positive');
    } catch (error) {
      notify(`❌ ${error instanceof Error ? error.message : 'Token invalide'}`, 'negative');
    } finally {
      setTesting(false);
    }
  };
  const agentMode = draft.get<string>('agent_mode', 'auto');

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Section title="Général" badge="GLOBAL" />
        <Group>
          <Row label="Mode agent par défaut" hint="Mode utilisé à l’ouverture de chaque dossier">
            <div className="flex gap-3 text-xs text-gray-300">
              {['ask', 'auto', 'plan'].map(mode => (
                <label key={mode} className="flex cursor-pointer items-center gap-1">
                  <input
                    type="radio"
                    name="agent_mode"
                    data-setting="agent_mode"
                    value={mode}
                    checked={agentMode === mode}
                    onChange={() => draft.set('agent_mode', mode)}
                  />
                  {mode}
                </label>
              ))}
            </div>
          </Row>
          <Row label="Démarrer dans le dernier dossier" hint="Rouvre la dernière session au lancement">
            <Toggle setting="restore_last_folder" checked={draft.get('restore_last_folder', true)} onChange={value => draft.set('restore_last_folder', value)} />
          </Row>
          <Row label="Animations" hint="Transitions et effets visuels" last>
            <Toggle setting="animations" checked={draft.get('animations', true)} onChange={value => draft.set('animations', value)} />
          </Row>
        </Group>
      </div>

      <div>
        <Section title="Données & Stockage" />
        <Group>
          <div className="flex flex-col gap-2 px-4 py-3">
            <span className="text-xs font-medium text-gray-300">Répertoire de données</span>
            <span className="text-xs text-gray-600">
              Historiques, sessions et configuration. Déplacez-le sur un disque secondaire pour préserver votre disque principal.
            </span>
            <div
              data-testid="oa-data-dir"
              className="truncate rounded px-2 py-1 font-mono text-xs text-blue-400"
              style={{ background: '#0a0a1a', border: '1px solid #1e1e3a' }}
            >
              {dataHome || '~/.openagent'}
            </div>
            {!editingDataDir ? (
              <button id="oa-data-dir-open-btn" onClick={startEditingDataDir} className={button}>
                📁 Changer le dossier…
              </button>
            ) : (
              <div className="flex flex-col gap-2 rounded border border-gray-700 p-3" style={{ background: '#0d0d0d' }}>
                <div className="flex gap-2">
                  <input
                    data-testid="oa-data-dir-input"
                    value={newDataDir}
                    onChange={event => setNewDataDir(event.target.value)}
                    placeholder="Ex: D:\openagent_data"
                    className="flex-1 rounded px-2 py-1.5 font-mono text-xs text-gray-200 outline-none"
                    style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}
                  />
                  <button id="oa-data-dir-browse-btn" onClick={() => void browseDataDir()} className={button}>
                    …
                  </button>
                </div>
                <div className="flex items-start gap-2 rounded border border-yellow-900 p-2" style={{ background: '#1a1200' }}>
                  <span className="text-sm">⚠️</span>
                  <span className="text-xs text-yellow-600">Redémarrez l’app après le changement pour que tout soit pris en compte.</span>
                </div>
                <div className="flex gap-2">
                  <button
                    id="oa-data-dir-apply-btn"
                    onClick={() => void applyDataDir()}
                    disabled={migrating}
                    className="self-start rounded-lg bg-purple-600 px-3 py-1.5 text-xs text-white disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {migrating ? 'Migration…' : 'Appliquer'}
                  </button>
                  <button id="oa-data-dir-cancel-btn" onClick={() => setEditingDataDir(false)} disabled={migrating} className={button}>
                    Annuler
                  </button>
                </div>
              </div>
            )}
          </div>
        </Group>
      </div>

      <div>
        <Section title="HuggingFace" />
        <Group>
          <div className="flex flex-col gap-2 px-4 py-3">
            <span className="text-xs font-medium text-gray-300">Token d’accès HuggingFace</span>
            <span className="text-xs text-gray-600">
              Lève les limites de débit anonymous du CDN HuggingFace. Aucune permission requise — le token sert uniquement à
              identifier votre compte. Créez-en un sur huggingface.co → Settings → Access Tokens.
            </span>
            <div className="flex w-full items-center gap-2">
              <input
                data-setting="hf_token"
                type={showToken ? 'text' : 'password'}
                value={draft.get<string>('hf_token', '')}
                placeholder={draft.configured('hf_token') ? '•••••• (token configuré)' : 'hf_…'}
                onChange={event => draft.set('hf_token', event.target.value)}
                autoComplete="off"
                className="flex-1 rounded px-2 py-1.5 font-mono text-xs text-gray-200 outline-none"
                style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}
              />
              <button
                id="oa-hf-toggle"
                onClick={() => setShowToken(shown => !shown)}
                className="h-8 w-8 rounded border border-gray-700 bg-gray-900 text-xs text-gray-400"
              >
                👁
              </button>
            </div>
            <button
              id="oa-hf-test-btn"
              onClick={() => void handleTestToken()}
              disabled={testing}
              className={button + ' disabled:cursor-not-allowed disabled:opacity-60'}
            >
              {testing ? 'Test…' : 'Tester le token'}
            </button>
          </div>
        </Group>
      </div>

      <div>
        <Section title="Mises à jour" />
        <Group>
          <div className="flex flex-col gap-2 px-4 py-3 text-xs">
            <span className="text-gray-300">
              Version installée : <span data-testid="oa-update-version" className="font-mono">{update?.currentVersion ?? '…'}</span>
            </span>
            {update && (
              <span data-testid="oa-update-state" data-status={update.enabled ? update.status : 'disabled'} className="text-gray-500">
                {updateText(update)}
                {update.at && ` (${new Date(update.at).toLocaleString('fr-FR')})`}
              </span>
            )}
            <button
              id="oa-update-check"
              onClick={() => void runCheck()}
              disabled={checking || !update?.enabled}
              className={button + ' disabled:cursor-not-allowed disabled:opacity-60'}
            >
              {checking ? 'Vérification…' : 'Vérifier les mises à jour'}
            </button>
          </div>
        </Group>
      </div>
    </div>
  );
}
