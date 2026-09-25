// artifact_panel.py::_ARTIFACT_RE / _extract_artifact, same pattern: the FIRST fenced block whose language
// is html, svg, mermaid or markdown (case-insensitive), a newline right after the language, non-greedy up
// to the first closing fence.
export type ArtifactType = 'html' | 'svg' | 'mermaid' | 'markdown';
export interface Artifact { type: ArtifactType; content: string }

const ARTIFACT_RE = /```(html|svg|mermaid|markdown)\n([\s\S]*?)```/i;

export function extractArtifact(text: string): Artifact | null {
  const match = ARTIFACT_RE.exec(text);
  if (!match) return null;
  return { type: match[1].toLowerCase() as ArtifactType, content: match[2].trim() };
}
