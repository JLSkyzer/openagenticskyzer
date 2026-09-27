import { useEffect, useState } from 'react';
import { getConnection, getGlobalSettings, listGguf, onSettingsChanged, type ConnectionSnapshot } from '../../ipc/bridge';
import { useRegisterAction } from '../../state/ActionRegistry';
import { ModelDialog } from './ModelDialog';

// input_bar.py::model_button — "● name (20 chars max…) ▾", full name as a tooltip. It opens
// the model selector and always shows the connection the chat will actually use — a local
// .gguf when one is active, the remote connection otherwise (the two are mutually exclusive).
export function ModelButton({ activeFolder }: { activeFolder: string | null }) {
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot | null>(null);
  const [localModelName, setLocalModelName] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => onSettingsChanged(() => setVersion(v => v + 1)), []);

  useEffect(() => {
    let cancelled = false;
    getConnection(activeFolder)
      .then(value => {
        if (!cancelled) setSnapshot(value);
      })
      .catch(() => {});
    Promise.all([getGlobalSettings(), listGguf()])
      .then(([global, entries]) => {
        if (cancelled) return;
        const id = typeof global.active_local_model === 'string' ? global.active_local_model : '';
        setLocalModelName(id ? (entries.find(entry => entry.id === id)?.name ?? null) : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeFolder, version]);

  // "🔄 Changer de modèle" of the command palette opens the same selector as the button.
  useRegisterAction('switch-model', () => setOpen(true));

  const fullName = localModelName ?? (snapshot?.model || 'Aucun modèle');
  const label = `● ${fullName.slice(0, 20)}${fullName.length > 20 ? '…' : ''} ▾`;

  return (
    <>
      <button
        id="oa-model-btn"
        onClick={() => setOpen(true)}
        title={snapshot?.model ? fullName : undefined}
        className="flex h-10 shrink-0 items-center rounded-lg border border-gray-700 bg-gray-900 px-2 text-xs text-gray-400 hover:border-purple-500"
      >
        {label}
      </button>
      {open && (
        <ModelDialog
          snapshot={snapshot}
          activeFolder={activeFolder}
          onSaved={setSnapshot}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
