import { useEffect, useState } from 'react';
import { getModelStatus, onEstimateEvent, onModelEvent, onSettingsChanged, type ModelStatus } from '../../ipc/bridge';
import { useRegisterAction } from '../../state/ActionRegistry';
import { ModelDialog } from './ModelDialog';
import { placementLabel } from './placement';

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
  // The button never starts an estimate (ruling F3d: only the model dialog does, while it is open). A finished one
  // is cached by the worker, so reading the status again shows its placement.
  useEffect(() => onEstimateEvent(event => { if (event.state === 'done') setVersion(v => v + 1); }), []);

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
        // Set once model-status has answered: before that the label already reads « Aucun modèle » (status null).
        data-loaded={status ? 'true' : undefined}
        onClick={() => setOpen(true)}
        title={name ?? undefined}
        className="flex h-10 shrink-0 items-center rounded-lg border border-gray-700 bg-gray-900 px-2 text-xs text-gray-400 hover:border-purple-500"
      >
        {label}
      </button>
      {/* Beside the button, never inside it: its text is asserted exactly. Shown only when the status carries a
          placement — the loaded truth, or an estimate cached by an earlier opening of the dialog. */}
      {status?.placement && (
        <span
          data-testid="oa-model-placement"
          data-source={status.placement.source}
          title={status.placement.source === 'estimate' ? 'Répartition estimée avant le chargement' : 'Répartition du modèle chargé'}
          className="shrink-0 self-center text-xs text-gray-500"
        >
          {placementLabel(status.placement)}
        </span>
      )}
      {/* Closing re-reads the status: a cached estimate answers the dialog at once, with no event. */}
      {open && <ModelDialog onClose={() => { setOpen(false); setVersion(v => v + 1); }} />}
    </>
  );
}
