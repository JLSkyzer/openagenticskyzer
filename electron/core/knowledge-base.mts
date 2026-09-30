import { join } from 'node:path';
import { JsonStore } from './json-store.mts';
import { chunkText, cosineSimilarity } from './semantic-chunk.mts';
import { embed } from './embeddings.mts';

export interface KnowledgeEntry {
  id: string;
  source: string;
  chunk: number;
  text: string;
  vector: number[];
}
interface KnowledgeFile {
  version: 1;
  entries: KnowledgeEntry[];
}
export interface KnowledgeSearchResult {
  source: string;
  content: string;
  score: number;
}

/** `~/.openagent/knowledge/knowledge.json` — one global store, distinct from a project's own
 * `codebase.json` (semantic-index.mts). Not routed through metadataDirectory: `home` is the
 * app's own trusted data directory, never a project folder an agent could redirect via junction. */
export function knowledgeStorePath(home: string): string {
  return join(home, 'knowledge', 'knowledge.json');
}

/**
 * Adds (or replaces) one source's chunks in the knowledge base. Unlike `indexFolder` (a full
 * rescan every call, so a wholesale store replacement was enough to avoid stale chunks), sources
 * are added one at a time here — so re-adding the same `source` must first drop its own previous
 * chunks before appending the freshly computed ones, or a shrunk document would leave stale
 * vectors behind (the same class of leak `indexFolder` fixes, applied per-source instead).
 */
export async function addToKnowledge(source: string, text: string, home: string): Promise<number> {
  const chunks = chunkText(text);
  if (!chunks.length) return 0;
  const vectors = await embed(chunks, home);
  const newEntries: KnowledgeEntry[] = chunks.map((chunkedText, i) => ({
    id: `${source}:${i}`,
    source,
    chunk: i,
    text: chunkedText,
    vector: vectors[i],
  }));
  const store = new JsonStore();
  await store.update<KnowledgeFile>(knowledgeStorePath(home), { version: 1, entries: [] }, current => ({
    version: 1,
    entries: [...current.entries.filter(e => e.source !== source), ...newEntries],
  }));
  return newEntries.length;
}

export async function listSources(home: string): Promise<string[]> {
  const store = new JsonStore();
  const data = await store.read<KnowledgeFile>(knowledgeStorePath(home), { version: 1, entries: [] });
  return [...new Set(data.entries.map(e => e.source))].sort();
}

export async function removeSource(source: string, home: string): Promise<number> {
  const store = new JsonStore();
  let removed = 0;
  await store.update<KnowledgeFile>(knowledgeStorePath(home), { version: 1, entries: [] }, current => {
    const kept = current.entries.filter(e => e.source !== source);
    removed = current.entries.length - kept.length;
    return { version: 1, entries: kept };
  });
  return removed;
}

export async function searchKnowledge(query: string, home: string, n = 5): Promise<KnowledgeSearchResult[]> {
  if (n <= 0) return [];
  const store = new JsonStore();
  const data = await store.read<KnowledgeFile>(knowledgeStorePath(home), { version: 1, entries: [] });
  if (!data.entries.length) return [];
  const [queryVector] = await embed([query], home);
  return data.entries
    .map(entry => ({ source: entry.source, content: entry.text, score: cosineSimilarity(queryVector, entry.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}
