// Electron prefixes a rejected IPC call with "Error invoking remote method '…': Error: " —
// strip it so the user sees the backend's own message.
export function cleanIpcError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
}
