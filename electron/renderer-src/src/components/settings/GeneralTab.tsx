import { useState } from 'react';
import type { SettingsDraft } from './useSettingsDraft';
import { Group, Row, Section, Toggle } from './parts';

const button = 'self-start rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-300';

// Mirrors settings.py::_tab_general. The data-directory migration and the HuggingFace
// token test are separate backend operations that are not part of this lot: their buttons
// are shown disabled ("à venir") rather than omitted, so the layout stays the original's.
export function GeneralTab({ draft }: { draft: SettingsDraft }) {
  const [showToken, setShowToken] = useState(false);
  const agentMode = draft.get<string>('agent_mode', 'auto');
  const dataDir = draft.get<string>('data_dir', '');

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
              {dataDir || '~/.openagent (répertoire par défaut)'}
            </div>
            <button disabled title="Migration du répertoire de données — à venir" className={button + ' disabled:cursor-not-allowed disabled:opacity-60'}>
              📁 Changer le dossier…
            </button>
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
            <button disabled title="Test du token — à venir" className={button + ' disabled:cursor-not-allowed disabled:opacity-60'}>
              Tester le token
            </button>
          </div>
        </Group>
      </div>
    </div>
  );
}
