import { useState } from 'react';
import { Modal } from './Modal';
import { Group, Row, Section } from './parts';
import { useProjectDraft, type SettingsDraft } from './useSettingsDraft';

function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

// Mirrors settings.py::_tab_folder: the settings that belong to the active project only.
export function FolderTab({ activeFolder }: { activeFolder: string | null }) {
  if (!activeFolder) return <div className="text-xs text-gray-600">Aucun dossier actif.</div>;
  return <FolderSettings key={activeFolder} folder={activeFolder} />;
}

function FolderSettings({ folder }: { folder: string }) {
  const draft = useProjectDraft(folder);
  const [editing, setEditing] = useState(false);

  if (!draft.loaded) return null;
  return (
    <div className="flex flex-col gap-5">
      <div>
        <Section title={`Paramètres de ${basename(folder)}`} badge="DOSSIER" />
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-indigo-900 px-3 py-2" style={{ background: '#111' }}>
          <span className="text-sm">📁</span>
          <span data-testid="oa-folder-path" className="truncate font-mono text-xs text-blue-400">
            {folder}
          </span>
        </div>
        <Group>
          <Row label="Mode agent pour ce dossier">
            <select
              data-project-setting="agent_mode"
              value={draft.get<string>('agent_mode', 'inherit')}
              onChange={event => draft.set('agent_mode', event.target.value)}
              className="w-28 rounded px-2 py-1 text-xs text-gray-200 outline-none"
              style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}
            >
              {['inherit', 'ask', 'auto', 'plan'].map(mode => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Fichiers ignorés" hint="Patterns exclus de la lecture (style .gitignore)">
            <input
              data-project-setting="ignored_patterns"
              value={draft.get<string>('ignored_patterns', '')}
              onChange={event => draft.set('ignored_patterns', event.target.value)}
              className="w-56 rounded px-2 py-1 font-mono text-xs text-gray-200 outline-none"
              style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}
            />
          </Row>
          <Row label="Contexte système personnalisé" hint="Instructions injectées au début de chaque session" last>
            <button
              id="oa-prompt-edit-btn"
              onClick={() => setEditing(true)}
              className="rounded bg-indigo-900 px-3 py-1.5 text-xs text-indigo-300 hover:bg-indigo-800"
            >
              ✏️ Éditer
            </button>
          </Row>
        </Group>
      </div>

      <div className="flex items-center gap-3">
        <button
          id="oa-folder-save-btn"
          onClick={() => void draft.save()}
          disabled={draft.saving}
          className="rounded-lg bg-purple-700 px-4 py-2 text-xs text-white hover:bg-purple-800 disabled:opacity-60"
        >
          Enregistrer les paramètres du dossier
        </button>
        {draft.status && (
          <span data-testid="oa-folder-status" className="text-xs text-green-500">
            {draft.status}
          </span>
        )}
        {draft.error && (
          <span data-testid="oa-folder-error" className="text-xs text-red-400">
            {draft.error}
          </span>
        )}
      </div>

      {editing && <PromptEditor draft={draft} onClose={() => setEditing(false)} />}
    </div>
  );
}

// settings.py's 600px "Contexte système personnalisé" dialog: Enregistrer writes the
// prompt right away (it does not wait for the folder's own save button).
function PromptEditor({ draft, onClose }: { draft: SettingsDraft; onClose(): void }) {
  const [text, setText] = useState(draft.get<string>('custom_prompt', ''));
  return (
    <Modal width={600} onClose={onClose}>
      <div className="mb-2 text-sm font-bold">Contexte système personnalisé</div>
      <textarea
        id="oa-prompt-textarea"
        autoFocus
        value={text}
        onChange={event => setText(event.target.value)}
        className="h-48 w-full rounded p-2 font-mono text-xs text-gray-200 outline-none"
        style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}
      />
      <div className="mt-2 flex justify-end gap-2">
        <button
          id="oa-prompt-save-btn"
          onClick={async () => {
            if (await draft.commit({ custom_prompt: text })) onClose();
          }}
          className="rounded bg-purple-600 px-3 py-1.5 text-xs text-white hover:bg-purple-700"
        >
          Enregistrer
        </button>
        <button id="oa-prompt-cancel-btn" onClick={onClose} className="rounded bg-gray-800 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700">
          Annuler
        </button>
      </div>
    </Modal>
  );
}
