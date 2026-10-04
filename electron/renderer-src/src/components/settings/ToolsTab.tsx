import { useEffect, useRef, useState } from 'react';
import { addMcpRemoteServer, addMcpServer, decideProjectTrust, getProjectTrust, listMcpServers, listPlugins, removeMcpServer, TRUST_CHANGED_EVENT, type McpServerConfig, type PluginListResult, type ProjectTrustView } from '../../ipc/bridge';
import { Group, Section } from './parts';
import { useToast } from '../../state/ToastProvider';
import { describeValue, FIELD_LABELS, secretNames, serverLabel } from '../trust-labels';

const button = 'self-start rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-300';
const EMPTY_PLUGINS: PluginListResult = { tools: [], errors: [], untrusted: [] };
// The aggregate only says whether anything waits; each part below says what IS applied.
const TRUST_TEXT: Record<ProjectTrustView['state'], string> = {
  none: 'Ce projet n’apporte ni plugin, ni serveur MCP, ni assouplissement de permission.',
  pending: 'Une partie de ce que ce projet apporte attend ta décision.',
  trusted: 'Tout ce que ce projet apporte est approuvé et appliqué.',
  ignored: 'Rien n’attend ta décision ; une partie de ce projet a été ignorée.',
};
const RELAXATION_TEXT: Record<ProjectTrustView['relaxationStatus'][string], string> = {
  approved: 'approuvé, appliqué',
  ignored: 'ignoré, non appliqué',
  pending: 'en attente, non appliqué',
};

function contentText(trust: ProjectTrustView): string {
  const what = 'Plugins et serveurs MCP du projet';
  if (trust.unreadable) return `${what} : illisibles (fichier verrouillé, droits, .mcp.json…) — rien n’en est chargé.`;
  if (trust.contentStatus === 'none') return `${what} : aucun.`;
  if (trust.contentStatus === 'trusted') return `${what} : approuvés, chargés.`;
  if (trust.contentStatus === 'ignored') return `${what} : ignorés, non chargés.`;
  return trust.changed ? `${what} : modifiés depuis ton approbation, non chargés en attendant ta décision.` : `${what} : en attente de ta décision, non chargés.`;
}

// Mirrors settings.py::_tab_tools' "Plugins Python" (now a real Node loader, see
// core/plugin-loader.mts) and "Serveurs MCP (stdio)" groups. The MCP list merges the global scope
// (~/.openagent/mcp.json, managed here) with the active project's .mcp.json (read-only — a
// "projet" badge marks those entries, and their ✕ is disabled: there is nothing to remove from
// this app's side, the file itself is the source of truth, same convention as Claude Code).
// A project's own plugins and servers apply only once the project is trusted (core/project-trust.mts).
export function ToolsTab({ activeFolder }: { activeFolder: string | null }) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [commandLine, setCommandLine] = useState('');
  const [adding, setAdding] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remoteAuth, setRemoteAuth] = useState('');
  const [addingRemote, setAddingRemote] = useState(false);
  const [plugins, setPlugins] = useState<PluginListResult>(EMPTY_PLUGINS);
  const [trust, setTrust] = useState<ProjectTrustView | null>(null);
  const [deciding, setDeciding] = useState(false);
  const { notify } = useToast();

  // Only the latest read for the current folder may land: a slow answer for folder A must not
  // overwrite folder B's state, nor an older answer a newer one.
  const folderRef = useRef(activeFolder);
  folderRef.current = activeFolder;
  const seqs = useRef({ servers: 0, plugins: 0, trust: 0 });
  const guarded = <T,>(kind: 'servers' | 'plugins' | 'trust', read: Promise<T>, apply: (value: T) => void, fallback?: () => void) => {
    const folder = activeFolder;
    const seq = ++seqs.current[kind];
    const current = () => seq === seqs.current[kind] && folderRef.current === folder;
    return read.then(value => { if (current()) apply(value); }, () => { if (current()) fallback?.(); });
  };
  const refresh = () => guarded('servers', listMcpServers(activeFolder), setServers);
  const refreshPlugins = () => guarded('plugins', listPlugins(activeFolder), setPlugins, () => setPlugins(EMPTY_PLUGINS));
  const refreshTrust = () => (activeFolder
    ? guarded('trust', getProjectTrust(activeFolder), setTrust, () => setTrust(null))
    : Promise.resolve(setTrust(null)));
  useEffect(() => { refresh(); }, [activeFolder]);
  useEffect(() => { refreshPlugins(); }, [activeFolder]);
  // Folder A's trust is never shown under folder B while the new read is in flight.
  useEffect(() => { setTrust(null); refreshTrust(); }, [activeFolder]);
  // A decision taken elsewhere (the chat banner) changes this row, the plugin list and the server badges.
  useEffect(() => {
    const onChanged = (event: Event) => {
      const folder = (event as CustomEvent<{ folder: string }>).detail?.folder;
      if (folder && folder === folderRef.current) { void refreshTrust(); void refresh(); void refreshPlugins(); }
    };
    window.addEventListener(TRUST_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(TRUST_CHANGED_EVENT, onChanged);
  }, [activeFolder]);

  const handleTrust = async (decision: 'trusted' | 'revoke') => {
    if (!activeFolder || !trust) return;
    setDeciding(true);
    try {
      setTrust(await decideProjectTrust(activeFolder, decision, trust.token));
      await Promise.all([refresh(), refreshPlugins()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Décision impossible.', 'negative');
      await refreshTrust();
    } finally {
      setDeciding(false);
    }
  };
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

  // Per part, never from the aggregate state: trusted plugins can sit beside a pending relaxation.
  // "Faire confiance" approves the content (unless unreadable) and every listed relaxation, so all of
  // them are listed above it; "Retirer" is offered as soon as anything at all is applied.
  const relaxations = trust ? Object.entries(trust.relaxations) : [];
  const contentOpen = !!trust && !trust.unreadable && (trust.contentStatus === 'pending' || trust.contentStatus === 'ignored');
  const anythingOpen = contentOpen || relaxations.some(([field]) => trust?.relaxationStatus[field] !== 'approved');
  const anythingApproved = !!trust && (trust.contentStatus === 'trusted' || relaxations.some(([field]) => trust.relaxationStatus[field] === 'approved'));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Section title="Outils et intégrations" badge="EXTENSIONS" />
        {activeFolder && trust && trust.state !== 'none' && (
          <Group>
            <div className="flex flex-col gap-2 px-4 py-3">
              <span className="text-xs font-medium text-gray-300">Confiance du projet</span>
              <span data-testid="oa-trust-state" data-state={trust.state} className="text-xs text-gray-500">
                {trust.unreadable && !anythingOpen ? 'Rien à décider tant que son contenu reste illisible.' : TRUST_TEXT[trust.state]}
              </span>
              <div data-testid="oa-trust-content" data-status={trust.unreadable ? 'unreadable' : trust.contentStatus} className="text-xs text-gray-400">
                {contentText(trust)}
                {contentOpen && (
                  <ul className="mt-1 list-disc pl-5 font-mono text-gray-500">
                    {trust.plugins.map(path => <li key={path} data-testid="oa-trust-content-plugin">{path}</li>)}
                    {trust.mcpServers.map(server => {
                      const names = secretNames(server);
                      return (
                        <li key={server.id} data-testid="oa-trust-content-mcp">
                          {server.name ?? server.id} : {serverLabel(server)}
                          {names && <div className="font-sans text-gray-600">{names}</div>}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
              {relaxations.map(([field, { project, global }]) => (
                <div key={field} data-testid="oa-trust-relaxation-row" data-field={field} data-status={trust.relaxationStatus[field]} className="text-xs text-gray-400">
                  {FIELD_LABELS[field] ?? field} : projet {describeValue(project)}, global {describeValue(global)} — {RELAXATION_TEXT[trust.relaxationStatus[field]] ?? 'en attente, non appliqué'}
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                {anythingOpen && (
                  <button id="oa-trust-approve" onClick={() => void handleTrust('trusted')} disabled={deciding} title="Approuve le contenu et chaque assouplissement listés ci-dessus" className={button + ' disabled:cursor-not-allowed disabled:opacity-60'}>
                    Faire confiance
                  </button>
                )}
                {anythingApproved && (
                  <button id="oa-trust-revoke" onClick={() => void handleTrust('revoke')} disabled={deciding} title="Oublie toutes les décisions sur ce projet, y compris tes « Toujours »" className={button + ' disabled:cursor-not-allowed disabled:opacity-60'}>
                    Retirer la confiance
                  </button>
                )}
              </div>
              {anythingApproved && (
                <span className="text-xs text-gray-600">« Retirer la confiance » oublie aussi tes « Toujours » enregistrés pour ce projet.</span>
              )}
            </div>
          </Group>
        )}
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
            {plugins.untrusted.map(path => (
              <span key={path} data-testid="oa-plugin-untrusted" className="font-mono text-xs text-gray-500">
                ⏸ {path} — non chargé (projet non approuvé)
              </span>
            ))}
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
                  <div key={server.id} data-testid="oa-mcp-entry" data-scope={server.scope} className={`flex flex-col gap-1 rounded px-2 py-1 ${server.trusted === false ? 'opacity-50' : ''}`} style={{ background: '#0a0a1a', border: '1px solid #1e1e3a' }}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-xs text-blue-400">
                        {server.scope === 'project' && <span data-testid="oa-mcp-project-badge" className="mr-1 rounded bg-purple-900 px-1 text-[10px] text-purple-300">projet</span>}
                        {server.trusted === false && <span data-testid="oa-mcp-untrusted-badge" className="mr-1 rounded bg-gray-800 px-1 text-[10px] text-gray-400">non approuvé</span>}
                        {serverLabel(server)}
                        {secretNames(server) && <span data-testid="oa-mcp-secret-names" className="ml-2 font-sans text-[10px] text-gray-500">{secretNames(server)}</span>}
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
                    {/* Opening this tab never starts a server: what the last turn learned of it, if a turn started it. An
                        unapproved project server stays « non approuvé »: no message will start it. */}
                    {server.trusted !== false && (Array.isArray(server.tools) ? (
                      <span data-testid="oa-mcp-tools" className="truncate font-mono text-[10px] text-gray-400">
                        {server.tools.length ? server.tools.join(', ') : 'aucun outil'}
                      </span>
                    ) : server.error ? (
                      <span data-testid="oa-mcp-error" className="font-mono text-[10px] text-yellow-600">⚠️ {server.error}</span>
                    ) : (
                      <span data-testid="oa-mcp-not-started" className="text-[10px] text-gray-500">non démarré — ses outils seront chargés au prochain message</span>
                    ))}
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
