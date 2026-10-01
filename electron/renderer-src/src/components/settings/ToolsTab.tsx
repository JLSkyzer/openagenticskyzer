import { useEffect, useState } from 'react';
import { addMcpRemoteServer, addMcpServer, listMcpServers, listPlugins, removeMcpServer, type McpServerConfig, type PluginListResult } from '../../ipc/bridge';
import { Group, Section } from './parts';
import { useToast } from '../../state/ToastProvider';

const button = 'self-start rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-300';

function serverLabel(server: McpServerConfig): string {
  if ('command' in server) return `${server.command} ${server.args.join(' ')}`.trim();
  return server.url;
}

// Mirrors settings.py::_tab_tools' "Plugins Python" (now a real Node loader, see
// core/plugin-loader.mts) and "Serveurs MCP (stdio)" groups. The MCP list merges the global scope
// (~/.openagent/mcp.json, managed here) with the active project's .mcp.json (read-only — a
// "projet" badge marks those entries, and their ✕ is disabled: there is nothing to remove from
// this app's side, the file itself is the source of truth, same convention as Claude Code).
export function ToolsTab({ activeFolder }: { activeFolder: string | null }) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [commandLine, setCommandLine] = useState('');
  const [adding, setAdding] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remoteAuth, setRemoteAuth] = useState('');
  const [addingRemote, setAddingRemote] = useState(false);
  const [plugins, setPlugins] = useState<PluginListResult>({ tools: [], errors: [] });
  const { notify } = useToast();

  const refresh = () => listMcpServers(activeFolder).then(setServers).catch(() => {});
  useEffect(() => { refresh(); }, [activeFolder]);
  useEffect(() => {
    listPlugins(activeFolder).then(setPlugins).catch(() => setPlugins({ tools: [], errors: [] }));
  }, [activeFolder]);

  const handleAdd = async () => {
    const value = commandLine.trim();
    if (!value) return;
    setAdding(true);
    try {
      await addMcpServer(value);
      await refresh();
      setCommandLine('');
      notify('Serveur MCP enregistré.', 'positive');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Impossible d’ajouter ce serveur.', 'negative');
    } finally {
      setAdding(false);
    }
  };
  const handleAddRemote = async () => {
    const url = remoteUrl.trim();
    if (!url) return;
    setAddingRemote(true);
    try {
      const headers = remoteAuth.trim() ? { Authorization: remoteAuth.trim() } : undefined;
      await addMcpRemoteServer(url, 'http', headers);
      await refresh();
      setRemoteUrl('');
      setRemoteAuth('');
      notify('Serveur MCP distant enregistré.', 'positive');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Impossible d’ajouter ce serveur distant.', 'negative');
    } finally {
      setAddingRemote(false);
    }
  };
  const handleRemove = async (id: string) => {
    try { await removeMcpServer(id); await refresh(); }
    catch { /* the list already reflects the last known-good state */ }
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Section title="Outils et intégrations" badge="EXTENSIONS" />
        <Group>
          <div className="flex flex-col gap-2 px-4 py-3">
            <span className="text-xs font-medium text-gray-300">Plugins</span>
            <span className="text-xs text-gray-600">
              Fichiers .mjs/.mts déposés dans ~/.openagent/tools ou tools/ du projet — chargés au démarrage de chaque tour de l'agent.
            </span>
            {plugins.tools.length === 0 ? (
              <span data-testid="oa-plugin-empty" className="text-xs text-gray-600">
                Aucun plugin chargé.
              </span>
            ) : (
              <div className="flex flex-col gap-1">
                {plugins.tools.map(name => (
                  <span key={name} data-testid="oa-plugin-entry" className="font-mono text-xs text-green-400">
                    🧩 {name}
                  </span>
                ))}
              </div>
            )}
            {plugins.errors.map(error => (
              <span key={error} data-testid="oa-plugin-error" className="font-mono text-xs text-yellow-600">
                ⚠️ {error}
              </span>
            ))}
          </div>
        </Group>
        <Group>
          <div className="flex flex-col gap-2 px-4 py-3">
            <span className="text-xs font-medium text-gray-300">Serveurs MCP</span>
            <span className="text-xs text-gray-600">
              Globaux (gérés ici) et ceux du .mcp.json du projet actif (lecture seule, géré par fichier/git).
            </span>
            {servers.length === 0 ? (
              <span data-testid="oa-mcp-empty" className="text-xs text-gray-600">
                Aucun serveur MCP configuré.
              </span>
            ) : (
              <div className="flex flex-col gap-1">
                {servers.map(server => (
                  <div key={server.id} data-testid="oa-mcp-entry" data-scope={server.scope} className="flex items-center justify-between gap-2 rounded px-2 py-1" style={{ background: '#0a0a1a', border: '1px solid #1e1e3a' }}>
                    <span className="truncate font-mono text-xs text-blue-400">
                      {server.scope === 'project' && <span data-testid="oa-mcp-project-badge" className="mr-1 rounded bg-purple-900 px-1 text-[10px] text-purple-300">projet</span>}
                      {serverLabel(server)}
                    </span>
                    <button
                      data-testid="oa-mcp-remove"
                      onClick={() => void handleRemove(server.id)}
                      disabled={server.scope === 'project'}
                      className="shrink-0 text-xs text-gray-500 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-30"
                      title={server.scope === 'project' ? 'Géré par .mcp.json, pas depuis l’app' : 'Retirer'}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            <input
              data-testid="oa-mcp-command-input"
              value={commandLine}
              onChange={event => setCommandLine(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') void handleAdd(); }}
              placeholder="Commande, ex. npx -y @modelcontextprotocol/server-filesystem"
              className="w-full rounded px-2 py-1.5 font-mono text-xs text-gray-200 outline-none"
              style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}
            />
            <button id="oa-mcp-add-btn" onClick={() => void handleAdd()} disabled={adding || !commandLine.trim()} className={button + ' disabled:cursor-not-allowed disabled:opacity-60'}>
              {adding ? 'Ajout…' : 'Ajouter'}
            </button>
            <span className="mt-1 text-xs text-gray-600">Serveur distant (SSE/HTTP) :</span>
            <input
              data-testid="oa-mcp-remote-url-input"
              value={remoteUrl}
              onChange={event => setRemoteUrl(event.target.value)}
              placeholder="URL, ex. https://exemple.com/mcp"
              className="w-full rounded px-2 py-1.5 font-mono text-xs text-gray-200 outline-none"
              style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}
            />
            <input
              data-testid="oa-mcp-remote-auth-input"
              value={remoteAuth}
              onChange={event => setRemoteAuth(event.target.value)}
              placeholder="En-tête Authorization (optionnel), ex. Bearer ..."
              className="w-full rounded px-2 py-1.5 font-mono text-xs text-gray-200 outline-none"
              style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}
            />
            <button id="oa-mcp-add-remote-btn" onClick={() => void handleAddRemote()} disabled={addingRemote || !remoteUrl.trim()} className={button + ' disabled:cursor-not-allowed disabled:opacity-60'}>
              {addingRemote ? 'Ajout…' : 'Ajouter le serveur distant'}
            </button>
          </div>
        </Group>
      </div>
    </div>
  );
}
