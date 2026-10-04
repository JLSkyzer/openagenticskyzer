import type { DataDirMigrationResult } from '../ipc/bridge';
import type { ToastKind } from './toasts';

/** What the toast says after Réglages › Général › Répertoire de données: how many entries moved, each entry that
 * stayed behind by name with its reason (never only a count), and how to apply the change. The window's cross only
 * hides the app now (close-to-tray), so the toast never asks to close it: the new folder is used after « Redémarrer
 * maintenant ». */
export function migrationSummary(result: DataDirMigrationResult): { text: string; kind: ToastKind } {
  const apply = 'Cliquez sur « Redémarrer maintenant » pour utiliser le nouveau dossier.';
  if (result.errors.length === 0) return { text: `✅ ${result.moved} élément(s) migré(s). ${apply}`, kind: 'positive' };
  return {
    text: `⚠️ ${result.moved} élément(s) migré(s). Resté(s) dans l’ancien dossier : ${result.errors.join(' ; ')}. ${apply}`,
    kind: 'warning',
  };
}
