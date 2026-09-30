import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import { JsonStore } from './json-store.mts';
import { chunkText, cosineSimilarity } from './semantic-chunk.mts';
import { embed } from './embeddings.mts';

const ALLOWED_EXTENSIONS = new Set(['.txt', '.md']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

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

/**
 * Real, functional counterpart to sidebar.py's "+ Ajouter un document" button — which, verified by
 * reading the whole Python file, only ever shows a ui.notify() hint and never actually reads a
 * file (add_to_knowledge is never called anywhere in that repo). Reads a real .txt/.md file from
 * disk and adds it under its basename as `source`.
 */
export async function addFileToKnowledge(filePath: string, home: string): Promise<{ source: string; chunks: number }> {
  if (!isAbsolute(filePath) || !isAbsolute(home)) throw new Error('Chemins absolus requis');
  if (!ALLOWED_EXTENSIONS.has(extname(filePath).toLowerCase())) throw new Error('Seuls les fichiers .txt et .md sont acceptés');
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error('Fichier introuvable');
  if (info.size > MAX_FILE_BYTES) throw new Error('Fichier trop volumineux (5 Mio maximum)');
  const text = await readFile(filePath, 'utf8');
  const source = basename(filePath);
  const chunks = await addToKnowledge(source, text, home);
  return { source, chunks };
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
