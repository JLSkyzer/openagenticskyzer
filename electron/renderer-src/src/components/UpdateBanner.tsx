import { useEffect, useState } from 'react';
import { getUpdateStatus, installUpdateNow, onUpdateStatus, type UpdateStatus } from '../ipc/bridge';
import { useChat } from '../state/ChatProvider';
import { useToast } from '../state/ToastProvider';

// "Plus tard" hides the banner for the rest of the session — module-level so a chat remount
// (folder switch, cleared history) does not bring it back.
let dismissedVersion: string | null = null;

/** Shown once an update is downloaded. Nothing restarts without a click; otherwise it installs at quit. */
export function UpdateBanner() {
  const { state } = useChat();
  const { notify } = useToast();
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [, setTick] = useState(0);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    let alive = true;
    getUpdateStatus().then(status => { if (alive) setUpdate(status); }).catch(() => {});
    const off = onUpdateStatus(status => setUpdate(status));
    return () => { alive = false; off(); };
  }, []);

  if (!update || update.status !== 'ready' || !update.version || dismissedVersion === update.version) return null;

  const install = async () => {
    setInstalling(true);
    try {
      await installUpdateNow();
    } catch (error) {
      setInstalling(false);
      notify(error instanceof Error ? error.message : 'Installation impossible.', 'negative');
    }
  };
  const later = () => {
    dismissedVersion = update.version ?? null;
    setTick(tick => tick + 1);
  };

  return (
    <div data-testid="oa-update-banner" className="mx-6 my-2 flex items-center gap-3 rounded-lg border border-blue-800 px-3 py-2 text-xs" style={{ background: '#0a1220' }}>
      <span className="text-blue-300">Version {update.version} prête.</span>
      <button
        id="oa-update-install"
        disabled={state.agentRunning || installing}
        onClick={() => void install()}
        className="rounded bg-blue-700 px-3 py-1 font-bold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {installing ? 'Redémarrage…' : 'Redémarrer maintenant'}
      </button>
      {state.agentRunning && <span data-testid="oa-update-after-turn" className="text-gray-400">après le tour en cours</span>}
      <button id="oa-update-later" onClick={later} className="rounded bg-gray-700 px-3 py-1 text-white hover:bg-gray-800">
        Plus tard
      </button>
    </div>
  );
}
