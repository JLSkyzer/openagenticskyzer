import { useEffect, useState } from 'react';
import { putArtifact } from '../ipc/bridge';
import { Markdown } from '../markdown/Markdown';
import { useChat } from '../state/ChatProvider';
import type { Artifact } from '../state/artifacts';

// artifact_panel.py: a 400px column on the right, "Preview — TYPE" and ✕. What a model wrote never goes into
// this page's DOM: html, svg and mermaid are all shown in a sandboxed <iframe> pointing at the `oa-artifact:`
// protocol (main process), whose document carries its own Content-Security-Policy — see artifact-protocol.cjs.
//   html      sandbox="allow-scripts": runs its inline script, cannot reach the page (no allow-same-origin, so
//             an opaque origin) nor the network (the document's policy is default-src 'none').
//   svg,mermaid  sandbox="": no script at all. The original injected the SVG as raw HTML; here it never is.
type FrameState = { status: 'loading' } | { status: 'ready'; url: string } | { status: 'error'; message: string };

let mermaidReady: Promise<typeof import('mermaid').default> | null = null;
// Loaded on first use only (the library is large), configured once: dark theme like the original, and the
// strictest security level — labels are sanitised and click handlers are disabled.
function loadMermaid() {
  mermaidReady ??= import('mermaid').then(module => {
    module.default.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
    return module.default;
  });
  return mermaidReady;
}

let renderCount = 0;
async function renderMermaid(source: string): Promise<string> {
  const mermaid = await loadMermaid();
  const id = `oa-mermaid-${++renderCount}`;
  try {
    const { svg } = await mermaid.render(id, source);
    return svg;
  } finally {
    // On a syntax error mermaid leaves its own temporary element in <body>; it is not part of the React tree.
    document.getElementById(`d${id}`)?.remove();
  }
}

const wrap = (background: string, inner: string) =>
  `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:16px;background:${background}">${inner}</body>`;

async function frameFor(artifact: Artifact): Promise<string> {
  if (artifact.type === 'html') return (await putArtifact('html', artifact.content)).url;
  if (artifact.type === 'svg') return (await putArtifact('static', wrap('transparent', artifact.content))).url;
  const svg = await renderMermaid(artifact.content);
  return (await putArtifact('static', wrap('#1e1e2e', svg))).url;
}

function ArtifactFrame({ artifact }: { artifact: Artifact }) {
  const [frame, setFrame] = useState<FrameState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setFrame({ status: 'loading' });
    frameFor(artifact).then(
      url => { if (!cancelled) setFrame({ status: 'ready', url }); },
      error => { if (!cancelled) setFrame({ status: 'error', message: error instanceof Error ? error.message : 'Aperçu impossible' }); },
    );
    return () => { cancelled = true; };
  }, [artifact]);

  if (frame.status === 'error') {
    return (
      <div data-testid="oa-artifact-error" className="m-3 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-400">
        {artifact.type === 'mermaid' ? 'Diagramme Mermaid invalide : ' : 'Aperçu impossible : '}{frame.message}
      </div>
    );
  }
  if (frame.status === 'loading') return <div className="p-3 text-xs text-gray-500">Chargement de l’aperçu…</div>;
  return (
    <iframe
      data-testid="oa-artifact-frame"
      data-artifact-type={artifact.type}
      title={`Aperçu ${artifact.type}`}
      src={frame.url}
      sandbox={artifact.type === 'html' ? 'allow-scripts' : ''}
      style={{ width: '100%', height: 500, border: 'none', background: artifact.type === 'html' ? 'white' : 'transparent', borderRadius: 8 }}
    />
  );
}

export function ArtifactPanel() {
  const { state, closeArtifact } = useChat();
  const artifact = state.artifact;
  if (!artifact) return null;
  return (
    <aside
      data-testid="oa-artifact-panel"
      className="flex h-full flex-col border-l border-gray-800 bg-gray-950"
      style={{ width: 400, flexShrink: 0 }}
    >
      <div className="flex items-center gap-2 border-b border-gray-800 px-3 py-2">
        <span data-testid="oa-artifact-title" className="flex-1 text-xs text-gray-400">Preview — {artifact.type.toUpperCase()}</span>
        <button
          type="button"
          data-testid="oa-artifact-close"
          title="Fermer l’aperçu"
          aria-label="Fermer l’aperçu"
          onClick={closeArtifact}
          className="h-6 w-6 bg-transparent text-xs text-gray-500 hover:text-white"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {artifact.type === 'markdown' ? (
          <div data-testid="oa-artifact-markdown" className="p-3 text-xs text-gray-300"><Markdown>{artifact.content}</Markdown></div>
        ) : (
          <ArtifactFrame artifact={artifact} />
        )}
      </div>
    </aside>
  );
}
