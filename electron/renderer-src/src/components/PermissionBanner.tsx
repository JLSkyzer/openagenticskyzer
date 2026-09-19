import { useChat } from '../state/ChatProvider';

// Matches chat.py::permission_banner exactly: orange/yellow banner, tool(args truncated
// to 60 chars), 3 buttons — Toujours (blue, always=true), Autoriser (green), Refuser (red).
const MAX_SHOWN_COMMAND = 4000;

function truncatedArgs(args: Record<string, unknown>, max = 60): string {
  const text = JSON.stringify(args);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function PermissionBanner() {
  const { state, decide } = useChat();
  const pending = state.pendingPermission;
  if (!pending) return null;
  const command = pending.category === 'shell' && typeof pending.arguments.command === 'string' ? pending.arguments.command : null;

  return (
    <div
      data-testid="oa-permission-banner"
      className="mx-6 my-1 rounded-lg border border-yellow-800 px-3 py-2 text-xs"
      style={{ background: '#1a120a' }}
    >
      <div className="mb-2 text-gray-300">
        {command !== null ? (
          // A shell command is shown IN FULL: truncating it (fine for a file path) would let the
          // user approve something whose ending they cannot read.
          <>
            <span className="font-mono">{pending.tool}</span>
            <pre
              data-testid="oa-permission-command"
              className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-black/40 p-2 font-mono text-[11px] text-gray-200"
            >
              {command.slice(0, MAX_SHOWN_COMMAND)}
            </pre>
            {command.length > MAX_SHOWN_COMMAND && <span className="text-yellow-600">… commande tronquée à l’affichage ({command.length} caractères)</span>}
          </>
        ) : (
          <span className="font-mono">
            {pending.tool}({truncatedArgs(pending.arguments)})
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => decide(true, true)}
          className="rounded bg-blue-700 px-3 py-1 font-bold text-white hover:bg-blue-800"
        >
          Toujours
        </button>
        <button
          onClick={() => decide(true, false)}
          className="rounded bg-green-700 px-3 py-1 font-bold text-white hover:bg-green-800"
        >
          Autoriser
        </button>
        <button
          onClick={() => decide(false, false)}
          className="rounded bg-red-700 px-3 py-1 font-bold text-white hover:bg-red-800"
        >
          Refuser
        </button>
      </div>
    </div>
  );
}
