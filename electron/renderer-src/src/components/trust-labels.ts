import type { McpServerConfig } from '../ipc/bridge';

// Shared by the chat banner and the Outils tab, so both describe a project's content the same way.

export const FIELD_LABELS: Record<string, string> = {
  shell_ask: 'confirmation des commandes shell',
  files_ask: 'confirmation des écritures : fichiers, git, mémoire',
  search_ask: 'confirmation des recherches web',
  permission_mode: 'mode de permission',
  agent_mode: 'mode de l’agent',
};

export function describeValue(value: unknown): string {
  if (value === true) return 'activée';
  if (value === false) return 'désactivée';
  return String(value);
}

export function serverLabel(server: McpServerConfig): string {
  return 'command' in server ? `${server.command} ${server.args.join(' ')}`.trim() : server.url;
}

/** The NAMES of a server's env variables / headers (their values never reach the renderer): an
 * innocent-looking command can still be steered by e.g. NODE_OPTIONS, so the names are shown. */
export function secretNames(server: McpServerConfig): string | null {
  const names = Object.keys(('command' in server ? server.env : server.headers) ?? {});
  if (!names.length) return null;
  return `${'command' in server ? 'variables d’environnement' : 'en-têtes'} : ${names.join(', ')} (valeurs masquées)`;
}
