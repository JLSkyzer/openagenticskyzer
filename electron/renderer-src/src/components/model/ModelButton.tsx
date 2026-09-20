import { useEffect, useState } from 'react';
import { getConnection, type ConnectionSnapshot } from '../../ipc/bridge';
import { useRegisterAction } from '../../state/ActionRegistry';
import { ModelDialog } from './ModelDialog';

// input_bar.py::model_button — "● name (20 chars max…) ▾", full name as a tooltip. It opens
// the model selector and always shows the connection the chat will actually use.
export function ModelButton({ activeFolder }: { activeFolder: string | null }) {
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getConnection(activeFolder)
      .then(value => {
        if (!cancelled) setSnapshot(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeFolder]);

  // "🔄 Changer de modèle" of the command palette opens the same selector as the button.
  useRegisterAction('switch-model', () => setOpen(true));

  const fullName = snapshot?.model || 'Aucun modèle';
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
