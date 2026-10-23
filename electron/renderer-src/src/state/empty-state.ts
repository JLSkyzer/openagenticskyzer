// The empty chat's line (Task 8, turn diagnostics). Pure: tested from electron/tests.
// Without a folder the text stays as it was: restore-folder-visual.cjs and final-e2e-tray.cjs assert it.
export function emptyStateText(activeFolder: string | null): string {
  return activeFolder === null ? 'Ouvre un dossier pour commencer.' : 'Écris un message pour commencer.';
}
