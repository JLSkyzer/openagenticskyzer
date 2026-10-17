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
/** 2: vectors of the bundled quantized model (core/embeddings.mts). A version-1 base holds fp32 vectors; unlike a
 * project index it cannot be rebuilt from a folder, so its stored texts are re-embedded once (upgradeKnowledge). */
export const KNOWLEDGE_VERSION = 2;
interface KnowledgeFile {
  version: number;
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
  await upgradeKnowledge(home);
  const vectors = await embed(chunks);
  const newEntries: KnowledgeEntry[] = chunks.map((chunkedText, i) => ({
    id: `${source}:${i}`,
    source,
    chunk: i,
    text: chunkedText,
    vector: vectors[i],
  }));
  const store = new JsonStore();
  await store.update<KnowledgeFile>(knowledgeStorePath(home), { version: KNOWLEDGE_VERSION, entries: [] }, current => ({
    version: KNOWLEDGE_VERSION,
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
  const data = await store.read<KnowledgeFile>(knowledgeStorePath(home), { version: KNOWLEDGE_VERSION, entries: [] });
  return [...new Set(data.entries.map(e => e.source))].sort();
}

export async function removeSource(source: string, home: string): Promise<number> {
  const store = new JsonStore();
  let removed = 0;
  await store.update<KnowledgeFile>(knowledgeStorePath(home), { version: KNOWLEDGE_VERSION, entries: [] }, current => {
    const kept = current.entries.filter(e => e.source !== source);
    removed = current.entries.length - kept.length;
    // The version found, never one this function did not compute: removing chunks does not re-embed the others.
    return { version: current.version, entries: kept };
  });
  return removed;
}

/**
 * Re-embeds every entry's stored text with the bundled model when the base is of another format version, and writes
 * KNOWLEDGE_VERSION; returns true if it rewrote. The store is read first and only written when the version differs, so
 * an up-to-date base is never touched; the version is checked again inside the write queue, where a concurrent call may
 * already have upgraded it. A base that does not exist yet needs nothing.
 */
export async function upgradeKnowledge(home: string): Promise<boolean> {
  const file = knowledgeStorePath(home);
  const store = new JsonStore();
  const found = await store.read<KnowledgeFile>(file, { version: KNOWLEDGE_VERSION, entries: [] });
  if (found.version === KNOWLEDGE_VERSION) return false;
  let rewrote = false;
  await store.update<KnowledgeFile>(file, { version: KNOWLEDGE_VERSION, entries: [] }, async current => {
    if (current.version === KNOWLEDGE_VERSION) return current;
    const vectors = await embed(current.entries.map(e => e.text));
    rewrote = true;
    return { version: KNOWLEDGE_VERSION, entries: current.entries.map((e, i) => ({ ...e, vector: vectors[i] })) };
  });
  return rewrote;
}

export async function searchKnowledge(query: string, home: string, n = 5): Promise<KnowledgeSearchResult[]> {
  if (n <= 0) return [];
  await upgradeKnowledge(home);
  const store = new JsonStore();
  const data = await store.read<KnowledgeFile>(knowledgeStorePath(home), { version: KNOWLEDGE_VERSION, entries: [] });
  if (!data.entries.length) return [];
  const [queryVector] = await embed([query]);
  return data.entries
    .map(entry => ({ source: entry.source, content: entry.text, score: cosineSimilarity(queryVector, entry.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}
