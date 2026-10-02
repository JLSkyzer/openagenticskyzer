import { useEffect, useRef, useState } from 'react';
import { decideProjectTrust, getProjectTrust, type McpServerConfig, type ProjectTrustView } from '../ipc/bridge';
import { useChat } from '../state/ChatProvider';
import { useToast } from '../state/ToastProvider';

const FIELD_LABELS: Record<string, string> = {
  shell_ask: 'confirmation des commandes shell',
  files_ask: 'confirmation des écritures de fichiers',
  search_ask: 'confirmation des recherches web',
  permission_mode: 'mode de permission',
  agent_mode: 'mode de l’agent',
};

function describe(value: unknown): string {
  if (value === true) return 'activée';
  if (value === false) return 'désactivée';
  return String(value);
}
function serverLabel(server: McpServerConfig): string {
  return 'command' in server ? `${server.command} ${server.args.join(' ')}`.trim() : server.url;
}

/** Shown while the active project brings plugins, .mcp.json servers or permission relaxations the
 * user has not decided on. Non-blocking: until a decision, none of it is loaded or applied
 * (core/project-trust.mts) and the agent works with its built-in tools and the global settings. */
export function ProjectTrustBanner() {
  const { activeFolder, state } = useChat();
  const { notify } = useToast();
  const [trust, setTrust] = useState<ProjectTrustView | null>(null);
  const [busy, setBusy] = useState(false);
  const folderRef = useRef(activeFolder);
  folderRef.current = activeFolder;

  // Read again on every folder change and every time a turn ends: a turn can add a plugin.
  useEffect(() => {
    if (!activeFolder || state.agentRunning) return;
    let cancelled = false;
    getProjectTrust(activeFolder)
      .then(next => { if (!cancelled) setTrust(next); })
      .catch(() => { if (!cancelled) setTrust(null); });
    return () => { cancelled = true; };
  }, [activeFolder, state.agentRunning]);

  if (!activeFolder || !trust || trust.state !== 'pending') return null;

  const decide = async (decision: 'trusted' | 'ignored') => {
    const folder = activeFolder;
    setBusy(true);
    try {
      const next = await decideProjectTrust(folder, decision, trust.token);
      if (folderRef.current === folder) setTrust(next);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Décision impossible.', 'negative');
      const next = await getProjectTrust(folder).catch(() => null);
      if (folderRef.current === folder) setTrust(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="oa-trust-banner" className="mx-6 my-2 rounded-lg border border-orange-800 px-3 py-2 text-xs" style={{ background: '#1a120a' }}>
      <div className="mb-1 font-bold text-orange-300">
        {trust.changed
          ? 'Le contenu de ce projet a changé depuis ton approbation.'
          : 'Ce projet contient du code ou des réglages qui s’exécuteraient avec tes droits.'}
      </div>
      <ul className="mb-2 list-disc pl-5 text-gray-300">
        {trust.plugins.map(path => (
          <li key={path} data-testid="oa-trust-plugin">Plugin <span className="font-mono">{path}</span></li>
        ))}
        {trust.mcpServers.map(server => (
          <li key={server.id} data-testid="oa-trust-mcp">
            Serveur MCP <span className="font-mono">{server.name ?? server.id}</span> : <span className="font-mono">{serverLabel(server)}</span>
          </li>
        ))}
        {Object.entries(trust.relaxations).map(([field, { project, global }]) => (
          <li key={field} data-testid="oa-trust-relaxation">
            {FIELD_LABELS[field] ?? field} : {describe(project)} (globalement : {describe(global)})
          </li>
        ))}
      </ul>
      <div className="mb-2 text-gray-500">
        Tant que tu ne fais pas confiance à ce projet, rien de cela n’est chargé ni appliqué : l’agent travaille avec ses outils internes et tes réglages globaux.
      </div>
      <div className="flex gap-2">
        <button id="oa-trust-banner-approve" disabled={busy} onClick={() => void decide('trusted')} className="rounded bg-orange-700 px-3 py-1 font-bold text-white hover:bg-orange-800 disabled:opacity-60">
          Faire confiance
        </button>
        <button id="oa-trust-banner-ignore" disabled={busy} onClick={() => void decide('ignored')} className="rounded bg-gray-700 px-3 py-1 font-bold text-white hover:bg-gray-800 disabled:opacity-60">
          Ignorer
        </button>
      </div>
    </div>
  );
}
