import { readdir, readFile as readFileFs, stat as statFs } from 'node:fs/promises';
import { join, relative, sep, extname, isAbsolute } from 'node:path';
import { metadataDirectory, JsonStore } from './json-store.mts';
import { chunkText, cosineSimilarity } from './semantic-chunk.mts';
import { embed } from './embeddings.mts';

// Same set as the previous app's indexer.py (_EXCLUDED / _EXTENSIONS) — a full-repo semantic
// index, not the shallower stack-detection scan project-analyzer.mts does.
const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', '__pycache__', 'dist', 'build', '.openagent', '.venv', 'venv', '.mypy_cache']);
const INDEXED_EXTENSIONS = new Set(['.py', '.js', '.ts', '.tsx', '.jsx', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.css', '.html', '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.sql']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface IndexEntry {
  id: string;
  file: string;
  chunk: number;
  text: string;
  vector: number[];
}
interface IndexFile {
  version: 1;
  entries: IndexEntry[];
}
export interface SearchResult {
  file: string;
  content: string;
  score: number;
}

/** `<project>/.openagent/index/codebase.json` — one JSON store per project, not a ChromaDB
 * collection: brute-force cosine search over a project's chunks is well within budget for
 * realistic codebase sizes, with none of ChromaDB's native/server packaging burden. Routed
 * through metadataDirectory, like every other file under .openagent/, so a project folder can
 * never redirect this write outside itself via a junction. */
export async function storePath(folder: string): Promise<string> {
  return join(await metadataDirectory(folder), 'index', 'codebase.json');
}

async function scanFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string) {
    let entries: import('node:fs').Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await visit(join(dir, entry.name));
      } else if (entry.isFile() && INDEXED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(join(dir, entry.name));
      }
    }
  }
  await visit(root);
  return files;
}

/**
 * Scans, chunks and embeds every matching file under `folder`, replacing the whole store with
 * the freshly computed result. Always a full rebuild (like indexer.py's own index_folder — no
 * incrementality either side of this port), but because the store is REPLACED wholesale rather
 * than upserted by id, a deleted or shrunk file can never leave stale vectors behind — the
 * previous app's own indexer.py never purged them (fixed here, not reproduced).
 */
export async function indexFolder(
  folder: string,
  home: string,
  onProgress?: (current: number, total: number, filepath: string) => void,
): Promise<{ chunks: number }> {
  if (!isAbsolute(folder) || !isAbsolute(home)) throw new Error('Chemins absolus requis');
  const files = await scanFiles(folder);
  const entries: IndexEntry[] = [];
  for (let i = 0; i < files.length; i++) {
    const absolute = files[i];
    const relFile = relative(folder, absolute).split(sep).join('/');
    onProgress?.(i + 1, files.length, relFile);
    let content: string;
    try {
      const info = await statFs(absolute);
      if (info.size > MAX_FILE_BYTES) continue;
      content = await readFileFs(absolute, 'utf8');
    } catch {
      continue; // unreadable/binary file: skip, like indexer.py's per-file try/except
    }
    const chunks = chunkText(content);
    if (!chunks.length) continue;
    const vectors = await embed(chunks, home);
    chunks.forEach((text, chunkIndex) => {
      entries.push({ id: `${relFile}:${chunkIndex}`, file: relFile, chunk: chunkIndex, text, vector: vectors[chunkIndex] });
    });
  }
  const store = new JsonStore();
  await store.update<IndexFile>(await storePath(folder), { version: 1, entries: [] }, () => ({ version: 1, entries }));
  return { chunks: entries.length };
}

/** Top-`n` chunks by cosine similarity to `query` — score = cosine similarity itself (this
 * app's cosineSimilarity already returns the `1 - distance` value indexer.py's search scored with). */
export async function searchCollection(collectionPath: string, query: string, home: string, n = 5): Promise<SearchResult[]> {
  if (n <= 0) return [];
  const store = new JsonStore();
  const data = await store.read<IndexFile>(collectionPath, { version: 1, entries: [] });
  if (!data.entries.length) return [];
  const [queryVector] = await embed([query], home);
  return data.entries
    .map(entry => ({ file: entry.file, content: entry.text, score: cosineSimilarity(queryVector, entry.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}
