// Badge colors copied from chat.py: WRITE=green, RUN(shell)=blue, READ=orange,
// SEARCH(network)=violet. category comes from AgentTool.category (workspace.mts etc.).
const CATEGORY_STYLE: Record<string, { label: string; className: string }> = {
  write: { label: 'WRITE', className: 'bg-green-900 text-green-400' },
  shell: { label: 'RUN', className: 'bg-blue-900 text-blue-400' },
  read: { label: 'READ', className: 'bg-orange-900 text-orange-400' },
  network: { label: 'SEARCH', className: 'bg-purple-900 text-purple-400' },
};

function looksLikeDiff(content: string): boolean {
  return /^[+-]/m.test(content) && /^@@|\n-|\n\+/.test(content);
}

function diffLineClassName(line: string): string {
  if (line.startsWith('+')) return 'text-green-400 bg-green-950/40';
  if (line.startsWith('-')) return 'text-red-400 bg-red-950/40';
  if (line.startsWith('@@')) return 'font-bold text-purple-400';
  return 'text-gray-400';
}

interface ToolMessageProps {
  tool?: string;
  category?: string;
  content: string;
  pending?: boolean;
}

export function ToolMessage({ tool, category, content, pending = false }: ToolMessageProps) {
  const style = category ? CATEGORY_STYLE[category] : undefined;
  const isDiff = !pending && looksLikeDiff(content);
  return (
    <div className="mx-8 my-1 overflow-hidden rounded-lg border border-gray-800" data-testid="oa-tool-message">
      <div className="flex items-center gap-2 bg-[#161620] px-2 py-1 text-[11px]">
        {style && <span className={`rounded px-1.5 py-0.5 font-bold ${style.className}`}>{style.label}</span>}
        <span className="truncate text-gray-400">{tool ?? 'outil'}</span>
        {pending && <span className="ml-auto animate-pulse text-gray-600">…</span>}
      </div>
      <div className="max-h-[400px] overflow-y-auto bg-[#0f1117] py-1">
        {isDiff ? (
          content.split('\n').map((line, index) => (
            <pre key={index} className={`whitespace-pre-wrap px-2 font-mono text-[11px] ${diffLineClassName(line)}`}>
              {line || ' '}
            </pre>
          ))
        ) : (
          <pre className="whitespace-pre-wrap px-2 font-mono text-[11px] text-gray-300">{content}</pre>
        )}
      </div>
    </div>
  );
}
