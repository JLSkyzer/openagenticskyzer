import { mkdir, open as openFs, readdir, readFile as readFileFs, rm, stat as statFs, writeFile as writeFileFs } from 'node:fs/promises';
import { join, relative, sep, extname, isAbsolute, dirname } from 'node:path';
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
/** 2: vectors of the bundled quantized model (core/embeddings.mts). A version-1 index holds fp32 vectors: it is
 * never compared with a quantized query vector, and the next activation or startup pre-warm rebuilds it. Bump it
 * whenever chunkText or EMBEDDING_MODEL changes: an index update keeps the entries of unchanged files as they are. */
export const INDEX_VERSION = 2;
/** What a file was when its entries were computed: an index update reuses them while both are unchanged. */
export interface FileStamp {
  size: number;
  mtimeMs: number;
}
interface IndexFile {
  version: number;
  entries: IndexEntry[];
  /** Each indexed file's stamp (Task 13). An index without them (written before) is rebuilt in full once. */
  files?: Record<string, FileStamp>;
}
export interface IndexResult {
  chunks: number;
  /** Files read and embedded by this run. */
  embeddedFiles: number;
  /** Unchanged files whose entries were kept as they were, without embedding them again. */
  reusedFiles: number;
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

/** The previous index's entries by file, with the stamp each was computed under; null when it cannot be reused as a
 * whole: absent, unreadable, of another format version, or written without stamps (before Task 13). */
async function previousIndex(file: string): Promise<Map<string, { stamp: FileStamp; entries: IndexEntry[] }> | null> {
  let data: IndexFile;
  try {
    data = await new JsonStore().read<IndexFile>(file, { version: INDEX_VERSION, entries: [] });
  } catch {
    return null; // the write below meets the same file and reports it
  }
  if (data?.version !== INDEX_VERSION || !Array.isArray(data.entries) || !data.files || typeof data.files !== 'object') return null;
  const byFile = new Map<string, { stamp: FileStamp; entries: IndexEntry[] }>();
  for (const [rel, stamp] of Object.entries(data.files)) {
    if (Number.isFinite(stamp?.size) && Number.isFinite(stamp?.mtimeMs)) byFile.set(rel, { stamp: { size: stamp.size, mtimeMs: stamp.mtimeMs }, entries: [] });
  }
  for (const entry of data.entries) byFile.get(entry?.file)?.entries.push(entry);
  return byFile;
}

/**
 * Scans, chunks and embeds every matching file under `folder`, replacing the whole store with the result. Since
 * Task 13 the update is per file: the store keeps each file's stamp ({size, mtimeMs}), and a file whose stamp is
 * unchanged keeps its entries without being read or embedded again; a changed or new file is embedded, and a file no
 * longer scanned (deleted, ignored, now secret) leaves nothing behind, because the store is still REPLACED wholesale
 * rather than upserted by id — the previous app's own indexer.py never purged stale vectors (fixed here, not
 * reproduced). An index without stamps, or of another version, is rebuilt in full. The store is written on one line
 * (indent 0): it is a cache of vectors, and an indented one took longer to encode on the worker's thread.
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
): Promise<IndexResult> {
  if (!isAbsolute(folder) || !isAbsolute(home)) throw new Error('Chemins absolus requis');
  const file = await storePath(folder);
  const previous = await previousIndex(file);
  const files = await scanFiles(folder, searchExclusion(ignoredPatterns));
  const entries: IndexEntry[] = [];
  const stamps: Record<string, FileStamp> = {};
  let embeddedFiles = 0;
  let reusedFiles = 0;
  for (let i = 0; i < files.length; i++) {
    const absolute = files[i];
    const relFile = relative(folder, absolute).split(sep).join('/');
    onProgress?.(i + 1, files.length, relFile);
    let content: string;
    let stamp: FileStamp;
    try {
      const info = await statFs(absolute);
      stamp = { size: info.size, mtimeMs: info.mtimeMs };
      const kept = previous?.get(relFile);
      previous?.delete(relFile); // the old store is released file by file, not held beside the new one
      if (kept && kept.stamp.size === stamp.size && kept.stamp.mtimeMs === stamp.mtimeMs) {
        await (await openFs(absolute, 'r')).close(); // a file no longer readable is dropped, as a full rebuild would
        entries.push(...kept.entries);
        stamps[relFile] = stamp;
        reusedFiles++;
        continue;
      }
      if (info.size > MAX_FILE_BYTES) continue;
      content = await readFileFs(absolute, 'utf8');
    } catch {
      continue; // unreadable/binary file: skip, like indexer.py's per-file try/except
    }
    // The stamp read BEFORE the content: a file changed in between has a newer one on disk, and is embedded again next time.
    stamps[relFile] = stamp;
    embeddedFiles++;
    const chunks = chunkText(content);
    if (!chunks.length) continue;
    const vectors = await embed(chunks);
    chunks.forEach((text, chunkIndex) => {
      entries.push({ id: `${relFile}:${chunkIndex}`, file: relFile, chunk: chunkIndex, text, vector: vectors[chunkIndex] });
    });
  }
  // The index is a cache: in a git project it must never show as `?? .openagent/`. A `*` .gitignore in the index
  // directory (the one storePath validated) hides it, and touches nothing else — not .git/, not the git config, no
  // other file of .openagent/. It is written BEFORE the store: written after, a `git status` run during the store
  // write (the git widget's, at folder activation) saw the temp file or codebase.json and showed the repo dirty.
  // Written once ('wx'): an existing .gitignore, the user's or ours, is left as it is. Like an unreadable file above,
  // a failure is skipped: it never fails the indexing — the index is still written, git just sees it.
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFileFs(join(dirname(file), '.gitignore'), '*\n', { flag: 'wx' });
  } catch {
    // EEXIST (already there) or any write error.
  }
  const store = new JsonStore({ indent: 0 });
  await store.update<IndexFile>(file, { version: INDEX_VERSION, entries: [] }, () => ({ version: INDEX_VERSION, entries, files: stamps }));
  await rm(`${file}.pre-electron.bak`, { force: true });
  return { chunks: entries.length, embeddedFiles, reusedFiles };
}

/** Top-`n` chunks by cosine similarity to `query` — score = cosine similarity itself (this
 * app's cosineSimilarity already returns the `1 - distance` value indexer.py's search scored with).
 * A chunk of a file `excluded` refuses is never returned: an index written before the filter, or before a pattern was
 * added, may still hold one. By default secrets and protected paths are hidden even when no patterns are passed.
 * An index of another format version returns nothing, without embedding the query, until it is rebuilt. */
export async function searchCollection(
  collectionPath: string,
  query: string,
  home: string,
  n = 5,
  excluded: (file: string) => boolean = searchExclusion(''),
): Promise<SearchResult[]> {
  if (n <= 0) return [];
  const store = new JsonStore();
  const data = await store.read<IndexFile>(collectionPath, { version: INDEX_VERSION, entries: [] });
  if (data.version !== INDEX_VERSION) return []; // an older index: old and new vectors never mix
  const entries = data.entries.filter(entry => !excluded(entry.file));
  if (!entries.length) return [];
  const [queryVector] = await embed([query]);
  return entries
    .map(entry => ({ file: entry.file, content: entry.text, score: cosineSimilarity(queryVector, entry.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}
