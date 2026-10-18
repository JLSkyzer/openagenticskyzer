// Byte sizes as the app shows them, in French binary units. Pure.
const GIB = 2 ** 30;
const MIB = 2 ** 20;

/** At least 1 Gio: one decimal with a comma (« 7,8 Gio »); below: whole Mio, at least 1 for any positive size. */
export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1).replace('.', ',')} Gio`;
  if (bytes <= 0) return '0 Mio';
  return `${Math.max(1, Math.round(bytes / MIB))} Mio`;
}
