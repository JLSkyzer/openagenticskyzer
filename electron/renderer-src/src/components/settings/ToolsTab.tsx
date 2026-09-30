import { useEffect, useState } from 'react';
import { addMcpServer, listMcpServers, listPlugins, removeMcpServer, type McpServerConfig, type PluginListResult } from '../../ipc/bridge';
import { Group, Section } from './parts';
import { useToast } from '../../state/ToastProvider';

const button = 'self-start rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-300';

// Mirrors settings.py::_tab_tools' "Plugins Python" (now a real Node loader, see
// core/plugin-loader.mts and tasks/todo.md's plugin-system lot) and "Serveurs MCP (stdio)"
// groups — a full command line typed in one field, split into command + args, exactly like
// add_server.
export function ToolsTab({ activeFolder }: { activeFolder: string | null }) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [commandLine, setCommandLine] = useState('');
  const [adding, setAdding] = useState(false);
  const [plugins, setPlugins] = useState<PluginListResult>({ tools: [], errors: [] });
  const { notify } = useToast();

  const refresh = () => listMcpServers().then(setServers).catch(() => {});
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    listPlugins(activeFolder).then(setPlugins).catch(() => setPlugins({ tools: [], errors: [] }));
  }, [activeFolder]);

  const handleAdd = async () => {
    const value = commandLine.trim();
    if (!value) return;
    setAdding(true);
    try {
      setServers(await addMcpServer(value));
      setCommandLine('');
      notify('Serveur MCP enregistré.', 'positive');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Impossible d’ajouter ce serveur.', 'negative');
    } finally {
      setAdding(false);
    }
  };
  const handleRemove = async (id: string) => {
    try { setServers(await removeMcpServer(id)); }
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
            <span className="text-xs font-medium text-gray-300">Serveurs MCP (stdio)</span>
            <span className="text-xs text-gray-600">
              Les commandes sont enregistrées ; elles ne sont lancées qu'au démarrage de chaque tour de l'agent.
            </span>
            {servers.length === 0 ? (
              <span data-testid="oa-mcp-empty" className="text-xs text-gray-600">
                Aucun serveur MCP configuré.
              </span>
            ) : (
              <div className="flex flex-col gap-1">
                {servers.map(server => (
                  <div key={server.id} data-testid="oa-mcp-entry" className="flex items-center justify-between gap-2 rounded px-2 py-1" style={{ background: '#0a0a1a', border: '1px solid #1e1e3a' }}>
                    <span className="truncate font-mono text-xs text-blue-400">
                      {server.command} {server.args.join(' ')}
                    </span>
                    <button
                      data-testid="oa-mcp-remove"
                      onClick={() => void handleRemove(server.id)}
                      className="shrink-0 text-xs text-gray-500 hover:text-red-400"
                      title="Retirer"
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
          </div>
        </Group>
      </div>
    </div>
  );
}
