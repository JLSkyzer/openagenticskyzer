import { useState } from 'react';
import * as bridge from '../ipc/bridge';
import { performExport, type ExportFormat } from '../state/export';
import { useToast } from '../state/ToastProvider';

// main.py's ⬇ menu: "Depuis : <branche>" (mute), then Markdown/HTML/JSON. Lives in TopBar, which
// sits outside ChatProvider (a folder/branch switch must not remount the top bar or the settings
// dialog mid-interaction — see App.tsx) — branch id/label are passed in as props instead, lifted
// from ChatProvider by App via `onBranchChange`.
export function ExportMenu({
  activeFolder,
  branchId,
  branchLabel,
}: {
  activeFolder: string | null;
  branchId: string;
  branchLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const { notify } = useToast();

  const run = (format: ExportFormat) => {
    setOpen(false);
    if (!activeFolder) return;
    void performExport(bridge, activeFolder, branchId, format, notify);
  };

  return (
    <div className="relative">
      <button
        id="oa-export-btn"
        type="button"
        title="Exporter"
        disabled={!activeFolder}
        onClick={() => setOpen(value => !value)}
        className="flex h-7 w-7 items-center justify-center rounded text-xs text-gray-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        style={{ background: '#111', border: '1px solid #1f2937' }}
      >
        ⬇
      </button>
      {open && (
        <>
          {/* Closes the menu on an outside click — same role as the Modal backdrop, but this is an
              anchored dropdown, not a dialog, so it has no Escape handling of its own. */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            data-testid="oa-export-menu"
            className="absolute right-0 top-8 z-20 w-56 rounded-lg border border-gray-800 bg-gray-900 py-1 shadow-lg"
          >
            <div className="px-3 py-1 text-xs text-gray-500">Depuis : {branchLabel}</div>
            <button id="oa-export-md" type="button" onClick={() => run('md')} className="block w-full px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-800">
              Markdown (.md)
            </button>
            <button id="oa-export-html" type="button" onClick={() => run('html')} className="block w-full px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-800">
              HTML (.html)
            </button>
            <button id="oa-export-json" type="button" onClick={() => run('json')} className="block w-full px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-800">
              JSON (.json)
            </button>
          </div>
        </>
      )}
    </div>
  );
}
