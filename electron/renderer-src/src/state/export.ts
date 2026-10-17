import { cleanIpcError } from '../ipc/errors.ts';
export type ExportFormat = 'md' | 'html' | 'json';

// The subset of the bridge this needs, expressed as an interface so tests can inject a fake — the
// real `import * as bridge from '../ipc/bridge'` structurally satisfies it.
export interface ExportDeps {
  exportConversation(folder: string, branchId: string, format: ExportFormat): Promise<{ filename: string }>;
  openExportedFile(folder: string, filename: string): Promise<{ opened: boolean }>;
}

export type Notify = (text: string, kind?: 'positive' | 'warning' | 'negative') => void;

/**
 * main.py::_do_export, ported: writes the export (the worker names the active model in its header), opens it, and reports the outcome as a toast. Deliberate improvement over the
 * original: there, `os.startfile()` was never wrapped, so a file the OS refused to open (no
 * associated application) silently ate the "Exporté :" notification even though the file existed —
 * here, a failure to OPEN the file does not undo the "success" reported for having WRITTEN it.
 */
export async function performExport(
  deps: ExportDeps,
  folder: string,
  branchId: string,
  format: ExportFormat,
  notify: Notify,
): Promise<void> {
  let filename: string;
  try {
    ({ filename } = await deps.exportConversation(folder, branchId, format));
  } catch (error) {
    // A refusal from the worker reaches the page wrapped by Electron (« Error invoking remote method … »): only the
    // worker's own reason is shown.
    notify(`Échec de l'export : ${error instanceof Error ? cleanIpcError(error) : 'erreur inconnue'}`, 'negative');
    return;
  }
  notify(`Exporté : ${filename}`, 'positive');
  try {
    await deps.openExportedFile(folder, filename);
  } catch {
    // The file exists; only opening it failed. Not worth a second, alarming toast on top of the
    // "Exporté" one already shown — the user can still open it by hand.
  }
}
