import { useEffect, useState } from 'react';
import { getModelStatus, onModelEvent, onSettingsChanged, type ModelStatus } from '../../ipc/bridge';
import { useRegisterAction } from '../../state/ActionRegistry';
import { ModelDialog } from './ModelDialog';

// input_bar.py::model_button — "● name (20 chars max…) ▾", full name as a tooltip. It opens the model selector and
// shows the .gguf the chat will actually use (model-status); none, or one whose file is gone: « Aucun modèle ».
export function ModelButton({ activeFolder }: { activeFolder: string | null }) {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => onSettingsChanged(() => setVersion(v => v + 1)), []);
  // A turn's model event says an engine has (re)loaded: read the status again — the event names the model of THAT
  // turn, which the user may have changed since; model-status reads the current setting.
  useEffect(() => onModelEvent(() => setVersion(v => v + 1)), []);

  useEffect(() => {
    let cancelled = false;
    getModelStatus()
      .then(value => { if (!cancelled) setStatus(value); })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeFolder, version]);

  // "🔄 Changer de modèle" of the command palette opens the same selector as the button.
  useRegisterAction('switch-model', () => setOpen(true));

  const name = status?.name ?? null;
  const fullName = name ?? 'Aucun modèle';
  const label = `● ${fullName.slice(0, 20)}${fullName.length > 20 ? '…' : ''} ▾`;

  return (
    <>
      <button
        id="oa-model-btn"
        onClick={() => setOpen(true)}
        title={name ?? undefined}
        className="flex h-10 shrink-0 items-center rounded-lg border border-gray-700 bg-gray-900 px-2 text-xs text-gray-400 hover:border-purple-500"
      >
        {label}
      </button>
      {open && <ModelDialog onClose={() => setOpen(false)} />}
    </>
  );
}
