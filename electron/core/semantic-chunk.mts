const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;
const STEP = CHUNK_SIZE - CHUNK_OVERLAP;

/** Splits text into an 800-char sliding window with 100-char overlap — same constants and
 * character-based (not AST-aware) approach as the previous app's indexer.py::_chunk. */
export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += STEP) {
    const chunk = text.slice(start, start + CHUNK_SIZE);
    if (chunk.trim()) chunks.push(chunk);
    if (start + CHUNK_SIZE >= text.length) break;
  }
  return chunks;
}

/** Cosine similarity in [-1, 1] — `1 - distance` under indexer.py's cosine metric, so this
 * function's return value IS the match score used everywhere search results are ranked. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error('Vecteurs de dimensions différentes');
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
