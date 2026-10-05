import { diffLineKinds, type DiffLineKind } from '../state/tool-cards';

// Badge colors copied from chat.py: WRITE=green, RUN(shell)=blue, READ=orange,
// SEARCH(network)=violet. category comes from AgentTool.category (workspace.mts etc.).
const CATEGORY_STYLE: Record<string, { label: string; className: string }> = {
  write: { label: 'WRITE', className: 'bg-green-900 text-green-400' },
  shell: { label: 'RUN', className: 'bg-blue-900 text-blue-400' },
  read: { label: 'READ', className: 'bg-orange-900 text-orange-400' },
  network: { label: 'SEARCH', className: 'bg-purple-900 text-purple-400' },
};
// A category that is unknown (a result saved before 2026-10-05, or closed by a Stop) or has no colour of its own (an
// extension: MCP, plugin) gets this neutral badge rather than none.
const NEUTRAL_STYLE = { label: 'OUTIL', className: 'bg-gray-800 text-gray-400' };

function looksLikeDiff(content: string): boolean {
  return /^[+-]/m.test(content) && /^@@|\n-|\n\+/.test(content);
}

// edit_file's diff headers (core/unified-diff.mts) are neither a removal nor an addition: which lines are headers is
// decided in state/tool-cards.ts (diffLineKinds), where it is unit-tested.
const DIFF_LINE_STYLE: Record<DiffLineKind, string> = {
  header: 'font-bold text-gray-300',
  added: 'text-green-400 bg-green-950/40',
  removed: 'text-red-400 bg-red-950/40',
  hunk: 'font-bold text-purple-400',
  context: 'text-gray-400',
};

interface ToolMessageProps {
  tool?: string;
  category?: string;
  // The call's path, command, query or URL (state/tool-cards.ts), already cut to 120 characters.
  detail?: string;
  content: string;
  pending?: boolean;
}

export function ToolMessage({ tool, category, detail, content, pending = false }: ToolMessageProps) {
  const known = category ? CATEGORY_STYLE[category] : undefined;
  const style = known ?? NEUTRAL_STYLE;
  const isDiff = !pending && looksLikeDiff(content);
  const lines = isDiff ? content.split('\n') : [];
  const kinds = isDiff ? diffLineKinds(lines) : [];
  return (
    <div className="mx-8 my-1 overflow-hidden rounded-lg border border-gray-800" data-testid="oa-tool-message">
      <div className="flex items-center gap-2 bg-[#161620] px-2 py-1 text-[11px]">
        <span
          data-testid="oa-tool-badge"
          data-badge={known ? category : 'neutral'}
          className={`shrink-0 rounded px-1.5 py-0.5 font-bold ${style.className}`}
        >
          {style.label}
        </span>
        <span data-testid="oa-tool-name" className="max-w-[45%] shrink-0 truncate text-gray-400">{tool ?? 'outil'}</span>
        {detail && (
          <span data-testid="oa-tool-detail" title={detail} className="min-w-0 flex-1 truncate font-mono text-gray-500">
            {detail}
          </span>
        )}
        {pending && <span className="ml-auto animate-pulse text-gray-600">…</span>}
      </div>
      <div className="max-h-[400px] overflow-y-auto bg-[#0f1117] py-1">
        {isDiff ? (
          lines.map((line, index) => (
            <pre key={index} className={`whitespace-pre-wrap px-2 font-mono text-[11px] ${DIFF_LINE_STYLE[kinds[index]]}`}>
              {line || ' '}
            </pre>
          ))
        ) : (
          <pre className="whitespace-pre-wrap px-2 font-mono text-[11px] text-gray-300">{content}</pre>
        )}
      </div>
    </div>
  );
}
