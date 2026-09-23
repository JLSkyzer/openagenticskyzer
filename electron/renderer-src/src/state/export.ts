export type ExportFormat = 'md' | 'html' | 'json';

// The subset of the bridge this needs, expressed as an interface so tests can inject a fake — the
// real `import * as bridge from '../ipc/bridge'` structurally satisfies it (ConnectionSnapshot has
// more fields than provider/model, which is fine for a return type).
export interface ExportDeps {
  getConnection(folder: string | null): Promise<{ provider: string; model: string }>;
  exportConversation(folder: string, branchId: string, format: ExportFormat, provider: string, model: string): Promise<{ filename: string }>;
  openExportedFile(folder: string, filename: string): Promise<{ opened: boolean }>;
}

export type Notify = (text: string, kind?: 'positive' | 'warning' | 'negative') => void;

/**
 * main.py::_do_export, ported: reads the active connection (for the Markdown/HTML header), writes
 * the export, opens it, and reports the outcome as a toast. Deliberate improvement over the
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
    const connection = await deps.getConnection(folder);
    ({ filename } = await deps.exportConversation(folder, branchId, format, connection.provider, connection.model));
  } catch (error) {
    notify(`Échec de l'export : ${error instanceof Error ? error.message : 'erreur inconnue'}`, 'negative');
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
