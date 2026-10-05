import { readdir, readFile as readFileFs, rm, stat as statFs } from 'node:fs/promises';
import { join, relative, sep, extname, isAbsolute } from 'node:path';
import { metadataDirectory, JsonStore } from './json-store.mts';
import { chunkText, cosineSimilarity } from './semantic-chunk.mts';
import { embed } from './embeddings.mts';
import { searchExclusion } from './file-filter.mts';

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

/** Every indexable file under `root`, in name order. A path `excluded` refuses (core/file-filter.mts: protected,
 * ignored by the project, key material by name) is skipped — a refused directory is not even entered. */
async function scanFiles(root: string, excluded: (rel: string) => boolean): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string) {
    let entries: import('node:fs').Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (excluded(relative(root, path).split(sep).join('/'))) continue;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await visit(path);
      } else if (entry.isFile() && INDEXED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(path);
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
 *
 * `ignoredPatterns` is the project's ignored_patterns: what the file tools' searches hide is never indexed
 * (core/file-filter.mts), and the rebuild purges what an older index held of it. JsonStore keeps a one-time copy of
 * the first version of any file it rewrites (`.pre-electron.bak`); for this cache that copy would keep the first index
 * ever written — secret files included for an index built before 2026-10-05 — so it is removed after each write.
 */
export async function indexFolder(
  folder: string,
  home: string,
  onProgress?: (current: number, total: number, filepath: string) => void,
  ignoredPatterns = '',
): Promise<{ chunks: number }> {
  if (!isAbsolute(folder) || !isAbsolute(home)) throw new Error('Chemins absolus requis');
  const files = await scanFiles(folder, searchExclusion(ignoredPatterns));
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
  const file = await storePath(folder);
  const store = new JsonStore();
  await store.update<IndexFile>(file, { version: 1, entries: [] }, () => ({ version: 1, entries }));
  await rm(`${file}.pre-electron.bak`, { force: true });
  return { chunks: entries.length };
}

/** Top-`n` chunks by cosine similarity to `query` — score = cosine similarity itself (this
 * app's cosineSimilarity already returns the `1 - distance` value indexer.py's search scored with).
 * A chunk of a file `excluded` refuses is never returned: an index written before the filter, or before a pattern was
 * added, may still hold one. By default secrets and protected paths are hidden even when no patterns are passed. */
export async function searchCollection(
  collectionPath: string,
  query: string,
  home: string,
  n = 5,
  excluded: (file: string) => boolean = searchExclusion(''),
): Promise<SearchResult[]> {
  if (n <= 0) return [];
  const store = new JsonStore();
  const data = await store.read<IndexFile>(collectionPath, { version: 1, entries: [] });
  const entries = data.entries.filter(entry => !excluded(entry.file));
  if (!entries.length) return [];
  const [queryVector] = await embed([query], home);
  return entries
    .map(entry => ({ file: entry.file, content: entry.text, score: cosineSimilarity(queryVector, entry.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}
