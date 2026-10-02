import { useEffect, useRef, useState } from 'react';
import { decideProjectTrust, getProjectTrust, TRUST_CHANGED_EVENT, type ProjectTrustView } from '../ipc/bridge';
import { useChat } from '../state/ChatProvider';
import { useToast } from '../state/ToastProvider';
import { describeValue, FIELD_LABELS, secretNames, serverLabel } from './trust-labels';

const IGNORED_MARK = ' (ignoré jusqu’ici)';

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

  const readSeq = useRef(0);

  // Only the latest read of the current folder may land: a slow answer for folder A must never
  // show under folder B, nor an older answer over a newer one.
  const read = (folder: string) => {
    const seq = ++readSeq.current;
    const current = () => seq === readSeq.current && folderRef.current === folder;
    getProjectTrust(folder)
      .then(next => { if (current()) setTrust(next); })
      .catch(() => { if (current()) setTrust(null); });
  };

  // Folder A's content is never shown under folder B, not even until the new read resolves.
  useEffect(() => { setTrust(null); }, [activeFolder]);

  // Read again on every folder change and every time a turn ends: a turn can add a plugin.
  useEffect(() => {
    if (!activeFolder || state.agentRunning) return;
    read(activeFolder);
  }, [activeFolder, state.agentRunning]);

  // A decision taken elsewhere (the Outils tab) changes what this banner must say.
  useEffect(() => {
    const onChanged = (event: Event) => {
      const folder = (event as CustomEvent<{ folder: string }>).detail?.folder;
      if (folder && folder === folderRef.current) read(folder);
    };
    window.addEventListener(TRUST_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(TRUST_CHANGED_EVENT, onChanged);
  }, []);

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

  // Listed = exactly what "Faire confiance" would approve: content not yet trusted (pending, or ignored
  // earlier) and every relaxation not yet approved. Already-approved parts are not re-listed.
  const contentOpen = !trust.unreadable && (trust.contentStatus === 'pending' || trust.contentStatus === 'ignored');
  const contentMark = trust.contentStatus === 'ignored' ? IGNORED_MARK : '';
  const openRelaxations = Object.entries(trust.relaxations).filter(([field]) => trust.relaxationStatus[field] !== 'approved');
  // Unreadable content cannot be approved as it is; the buttons stay only for relaxations to decide.
  const decidable = contentOpen || openRelaxations.length > 0;

  return (
    <div data-testid="oa-trust-banner" className="mx-6 my-2 rounded-lg border border-orange-800 px-3 py-2 text-xs" style={{ background: '#1a120a' }}>
      <div className="mb-1 font-bold text-orange-300">
        {trust.unreadable
          ? 'Le contenu de ce projet (plugins ou .mcp.json) n’a pas pu être lu.'
          : trust.changed
            ? 'Le contenu de ce projet a changé depuis ton approbation.'
            : 'Ce projet contient du code ou des réglages qui s’exécuteraient avec tes droits.'}
      </div>
      {trust.unreadable && (
        <div data-testid="oa-trust-unreadable" className="mb-2 text-gray-300">
          Rien de ses plugins ni de son .mcp.json n’est chargé tant qu’il reste illisible (fichier verrouillé, droits, dossier à la place d’un fichier…). Corrige ou retire le fichier en cause : ce message disparaîtra.
        </div>
      )}
      {decidable && (
        <ul className="mb-2 list-disc pl-5 text-gray-300">
          {contentOpen && trust.plugins.map(path => (
            <li key={path} data-testid="oa-trust-plugin">Plugin <span className="font-mono">{path}</span>{contentMark}</li>
          ))}
          {contentOpen && trust.mcpServers.map(server => {
            const names = secretNames(server);
            return (
              <li key={server.id} data-testid="oa-trust-mcp">
                Serveur MCP <span className="font-mono">{server.name ?? server.id}</span> : <span className="font-mono">{serverLabel(server)}</span>{contentMark}
                {names && <div data-testid="oa-trust-mcp-secrets" className="text-gray-400">{names}</div>}
              </li>
            );
          })}
          {openRelaxations.map(([field, { project, global }]) => (
            <li key={field} data-testid="oa-trust-relaxation">
              {FIELD_LABELS[field] ?? field} : {describeValue(project)} (globalement : {describeValue(global)}){trust.relaxationStatus[field] === 'ignored' ? IGNORED_MARK : ''}
            </li>
          ))}
        </ul>
      )}
      {decidable && (
        <div className="mb-2 text-gray-500">
          Tant que tu ne fais pas confiance à ce projet, rien de cette liste n’est chargé ni appliqué : l’agent travaille avec ses outils internes et tes réglages globaux.
          {trust.contentStatus === 'trusted' && ' Ses plugins et serveurs MCP, déjà approuvés, restent chargés.'}
        </div>
      )}
      {decidable && (
        <div className="flex gap-2">
          <button id="oa-trust-banner-approve" disabled={busy} onClick={() => void decide('trusted')} className="rounded bg-orange-700 px-3 py-1 font-bold text-white hover:bg-orange-800 disabled:opacity-60">
            Faire confiance
          </button>
          <button id="oa-trust-banner-ignore" disabled={busy} onClick={() => void decide('ignored')} className="rounded bg-gray-700 px-3 py-1 font-bold text-white hover:bg-gray-800 disabled:opacity-60">
            Ignorer
          </button>
        </div>
      )}
    </div>
  );
}
