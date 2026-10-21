import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelCudaPackInstall,
  getCudaPackStatus,
  getHardwareInfo,
  installCudaPack,
  onCudaPackEvent,
  restartApp,
  uninstallCudaPack,
  type CudaPackView,
  type GpuBackendChoice,
  type HardwareInfo,
} from '../../ipc/bridge';
import { cleanIpcError } from '../../ipc/errors';
import { DEFAULT_LOCAL_CONTEXT, type LocalContextSetting } from '../../../../core/context-budget.mts';
import { backendChoiceView, cudaPackView, GPU_BACKEND_OPTIONS, hardwareLines, LOCAL_CONTEXT_OPTIONS } from './hardware-view';
import type { SettingsDraft } from './useSettingsDraft';
import { Group, Row, Section } from './parts';

const selectStyle = { background: '#1a1a1a', border: '1px solid #2a2a2a' };
const buttonClass = 'self-start rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-300 hover:border-purple-500 disabled:opacity-60';

// « 🖥️ Matériel »: what the machine offers to the built-in engine (read-only, re-readable), the « Moteur » choice
// (gpu_backend) and the global « Contexte des modèles locaux » setting, saved by « Enregistrer » like every other tab,
// and the optional CUDA pack (hardware and offload, Task 11), installed or removed at once, used after a restart.
export function HardwareTab({ draft }: { draft: SettingsDraft }) {
  const [info, setInfo] = useState<HardwareInfo | null>(null);
  const [reads, setReads] = useState(0);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pack, setPack] = useState<CudaPackView | null>(null);
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const [packError, setPackError] = useState<string | null>(null);
  const [packBusy, setPackBusy] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  // The install this view started: its events are the only ones it follows. An end that arrives before the
  // install's own answer (two IPC channels) is kept until that answer names it.
  const installId = useRef<string | null>(null);
  const endedEarly = useRef(new Map<string, string | null>());

  const readPack = useCallback(() => getCudaPackStatus().then(setPack).catch(error_ => setPackError(cleanIpcError(error_))), []);
  const read = useCallback((refresh: boolean) => {
    setReading(true);
    setError(null);
    void readPack();
    return getHardwareInfo(refresh)
      .then(value => {
        setInfo(value);
        setReads(count => count + 1);
      })
      .catch(error_ => setError(cleanIpcError(error_)))
      .finally(() => setReading(false));
  }, [readPack]);
  useEffect(() => { void read(false); }, [read]);

  const finish = useCallback((message: string | null) => {
    installId.current = null;
    setProgress(null);
    if (message !== null) setPackError(cleanIpcError(message));
    void read(false);
  }, [read]);
  useEffect(() => onCudaPackEvent(event => {
    if (event.installId !== installId.current) {
      if (event.state !== 'progress') endedEarly.current.set(event.installId, event.state === 'error' ? event.message : null);
      return;
    }
    if (event.state === 'progress') setProgress({ received: event.receivedBytes, total: event.totalBytes });
    else finish(event.state === 'error' ? event.message : null);
  }), [finish]);

  // A save may change what needs a restart (gpu_backend): read again once it is done.
  const wasSaving = useRef(false);
  useEffect(() => {
    if (wasSaving.current && !draft.saving) void read(false);
    wasSaving.current = draft.saving;
  }, [draft.saving, read]);

  const localContext = draft.get<LocalContextSetting>('local_context', DEFAULT_LOCAL_CONTEXT);
  const gpuBackend = draft.get<GpuBackendChoice>('gpu_backend', 'auto');
  const cuda = info !== null && pack !== null ? cudaPackView(pack, info, progress) : null;
  const choice = info !== null ? backendChoiceView(info, gpuBackend, cuda?.state ?? 'hidden') : { restart: null };

  const download = async () => {
    setPackError(null);
    setPackBusy(true);
    try {
      const started = await installCudaPack();
      if (endedEarly.current.has(started.installId)) {
        finish(endedEarly.current.get(started.installId) ?? null);
        endedEarly.current.delete(started.installId);
        return;
      }
      installId.current = started.installId;
      setProgress(current => current ?? { received: 0, total: pack?.downloadBytes ?? 0 });
    } catch (error_) {
      setPackError(cleanIpcError(error_));
    } finally {
      setPackBusy(false);
    }
  };
  const cancel = async () => {
    if (installId.current === null) return;
    try { await cancelCudaPackInstall(installId.current); } catch (error_) { setPackError(cleanIpcError(error_)); }
  };
  const uninstall = async () => {
    setPackError(null);
    setPackBusy(true);
    try {
      setPack(await uninstallCudaPack());
      await read(false);
    } catch (error_) {
      setPackError(cleanIpcError(error_));
    } finally {
      setPackBusy(false);
    }
  };
  // The choice not saved yet is saved first (commit also saves the other tabs' pending edits, as « Enregistrer » does):
  // a restart must start with what the user sees selected.
  const restart = async () => {
    setRestartError(null);
    if (!(await draft.commit({}))) return;
    try { await restartApp(); } catch (error_) { setRestartError(cleanIpcError(error_)); }
  };
  const onCudaButton = { download, cancel, uninstall, restart };

  return (
    <div className="flex flex-col gap-5">
      <div data-testid="oa-hardware" data-reads={reads}>
        <Section title="Matériel" badge="GLOBAL" />
        <Group>
          <div className="flex flex-col gap-1 px-4 py-3">
            {info === null && !error && <span className="text-xs text-gray-600">Lecture du matériel…</span>}
            {info !== null && hardwareLines(info).map(line => (
              <span
                key={line.field}
                data-testid="oa-hardware-line"
                data-field={line.field}
                className={'text-xs ' + (line.field === 'notice' ? 'text-yellow-600' : 'text-gray-300')}
              >
                {line.text}
              </span>
            ))}
            {error && <span data-testid="oa-hardware-error" className="text-xs text-red-400">{error}</span>}
            <button
              type="button"
              data-testid="oa-hardware-refresh-btn"
              disabled={reading}
              onClick={() => void read(true)}
              className={'mt-2 ' + buttonClass}
            >
              Relire
            </button>
          </div>
        </Group>
      </div>
      <div>
        <Group>
          <Row label="Moteur" hint="Appliqué au prochain démarrage de l'app.">
            <select
              data-testid="oa-gpu-backend"
              data-setting="gpu_backend"
              value={gpuBackend}
              onChange={event => draft.set('gpu_backend', event.target.value)}
              className="w-72 rounded px-2 py-1 text-xs text-gray-200 outline-none"
              style={selectStyle}
            >
              {GPU_BACKEND_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </Row>
          {choice.restart && (
            <div data-testid="oa-restart" className="flex flex-col gap-2 border-b border-gray-800 px-4 py-3">
              <span className="text-xs text-yellow-600">{choice.restart.text}</span>
              <button type="button" data-testid="oa-restart-btn" disabled={draft.saving} onClick={() => void restart()} className={buttonClass}>
                {choice.restart.button.label}
              </button>
              {restartError && <span data-testid="oa-restart-error" className="text-xs text-red-400">{restartError}</span>}
            </div>
          )}
          {cuda && (
            <div data-testid="oa-cuda-pack" data-state={cuda.state} className="flex flex-col gap-2 border-b border-gray-800 px-4 py-3">
              <span className="text-xs font-semibold text-gray-300">Pack CUDA</span>
              <span className={'text-xs ' + (cuda.state === 'failed' || cuda.state === 'mismatch' || cuda.state === 'restart' ? 'text-yellow-600' : 'text-gray-400')}>
                {cuda.text}
              </span>
              {progress !== null && (
                <progress
                  data-testid="oa-cuda-progress"
                  max={progress.total > 0 ? progress.total : 1}
                  value={progress.total > 0 ? Math.min(progress.received, progress.total) : 0}
                  className="h-1.5 w-full"
                />
              )}
              {cuda.button && (
                <button
                  type="button"
                  data-testid={`oa-cuda-${cuda.button.id}-btn`}
                  disabled={packBusy || (cuda.button.id === 'restart' && draft.saving)}
                  onClick={() => void onCudaButton[cuda.button!.id]()}
                  className={buttonClass}
                >
                  {cuda.button.label}
                </button>
              )}
              {cuda.button?.id === 'restart' && restartError && <span data-testid="oa-restart-error" className="text-xs text-red-400">{restartError}</span>}
            </div>
          )}
          {packError && <span data-testid="oa-cuda-error" className="block px-4 py-2 text-xs text-red-400">{packError}</span>}
          <Row
            label="Contexte des modèles locaux"
            hint="Plafonné par ce que le modèle supporte et par la limite de contexte (Contexte & Mémoire). Changer la valeur recharge le modèle au message suivant."
            last
          >
            <select
              data-setting="local_context"
              value={String(localContext)}
              onChange={event => draft.set('local_context', event.target.value === 'max' ? 'max' : Number(event.target.value))}
              className="w-36 rounded px-2 py-1 text-xs text-gray-200 outline-none"
              style={selectStyle}
            >
              {LOCAL_CONTEXT_OPTIONS.map(option => (
                <option key={String(option.value)} value={String(option.value)}>{option.label}</option>
              ))}
            </select>
          </Row>
        </Group>
      </div>
    </div>
  );
}
