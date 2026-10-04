import { isAbsolute, join, resolve } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { JsonStore } from './json-store.mts';

interface FolderEntry {
  path: string;
  last_used: string;
}
export interface FolderListItem extends FolderEntry {
  name: string;
}

const MAX_ENTRIES = 50;

function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

function isValidEntry(value: unknown): value is FolderEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.path === 'string' && candidate.path.length > 0 && typeof candidate.last_used === 'string';
}

/** The path a folder is stored under: its real path when it exists, else the absolute path resolved (separators
 * unified, no trailing one) — `C:/a/b` written by the Python app and `C:\a\b` written by this app are one folder.
 * A relative entry (never written by either app) is kept as is: resolving it against the cwd would invent a folder. */
export async function canonicalFolderPath(path: string): Promise<string> {
  if (!isAbsolute(path)) return path;
  try { return await realpath(path); }
  catch { return resolve(path); }
}

/** Two spellings of one folder share this key: case is ignored under Windows, like its file system. */
export function folderKey(canonical: string): string {
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/** last_used as a time, or `undefined` when it cannot be read as a date ("unknown"). Python wrote local
 * `isoformat()` strings, this app writes UTC — the strings do not compare, the times do. An unknown date sorts last
 * in list(), never wins a merge against a known one, and is never old enough for retention (core/cleanup.mts). */
export function lastUsedTime(value: string): number | undefined {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Most recent first; unknown dates last, in their stored order. */
function byMostRecent(a: FolderEntry, b: FolderEntry): number {
  const [left, right] = [lastUsedTime(a.last_used), lastUsedTime(b.last_used)];
  if (left === undefined || right === undefined) return (left === undefined ? 1 : 0) - (right === undefined ? 1 : 0);
  return right - left;
}

/** One entry per folder: duplicates are merged on the canonical key, keeping the canonical path and the most recent
 * last_used (as a time; a known date beats an unknown one). First occurrence order is kept. */
export async function mergeFolderEntries(entries: FolderEntry[]): Promise<FolderEntry[]> {
  const byKey = new Map<string, FolderEntry>();
  for (const entry of entries) {
    const path = await canonicalFolderPath(entry.path);
    const key = folderKey(path);
    const seen = byKey.get(key);
    if (!seen) byKey.set(key, { path, last_used: entry.last_used });
    else if (byMostRecent(entry, seen) < 0) seen.last_used = entry.last_used;
  }
  return [...byKey.values()];
}

async function mergedFrom(current: unknown): Promise<FolderEntry[]> {
  return mergeFolderEntries(Array.isArray(current) ? current.filter(isValidEntry) : []);
}

/** Recently-opened project folders, shown in the sidebar history. */
export class FoldersService {
  private home: string;
  private store = new JsonStore();
  constructor(home: string) {
    if (!isAbsolute(home)) throw new Error('Répertoire de données absolu requis');
    this.home = home;
  }
  private path() {
    return join(this.home, 'folders.json');
  }
  private async validEntries(): Promise<FolderEntry[]> {
    const raw = await this.store.read<unknown>(this.path(), []);
    if (!Array.isArray(raw)) return [];
    const valid = raw.filter(isValidEntry).map(({ path, last_used }) => ({ path, last_used }));
    const merged = await mergeFolderEntries(valid);
    // R1: a folder recorded twice (the Python app wrote C:/…, this app C:\…), or once under a spelling that is not its
    // canonical one, is written back once, merged. JsonStore keeps the original as folders.json.pre-electron.bak.
    // The rewrite is a by-product of a read: when it fails (a read-only or locked file), the read still answers.
    if (JSON.stringify(merged) !== JSON.stringify(valid)) {
      try { await this.store.update<unknown>(this.path(), [], mergedFrom); }
      catch (error) {
        console.error(`[historique des dossiers] ${this.path()} n’a pas pu être réécrit sans doublons : ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return merged;
  }
  async list(): Promise<FolderListItem[]> {
    const entries = await this.validEntries();
    return entries
      .slice()
      .sort(byMostRecent)
      .map(entry => ({ path: entry.path, name: folderName(entry.path), last_used: entry.last_used }));
  }
  /** Forgets a folder in the sidebar history only — the project's files are never touched. */
  async remove(folder: string): Promise<FolderListItem[]> {
    const key = folderKey(await canonicalFolderPath(folder));
    await this.store.update<unknown>(this.path(), [], async current => (await mergedFrom(current)).filter(entry => folderKey(entry.path) !== key));
    return this.list();
  }
  async recordOpened(folder: string): Promise<FolderListItem[]> {
    if (!isAbsolute(folder)) throw new Error('Dossier absolu requis');
    let canonical: string;
    try {
      canonical = await realpath(folder);
    } catch {
      throw new Error('Dossier introuvable');
    }
    if (!(await lstat(canonical)).isDirectory()) throw new Error('Dossier introuvable');
    const now = new Date().toISOString();
    const key = folderKey(canonical);
    await this.store.update<unknown>(this.path(), [], async current => {
      const entries = (await mergedFrom(current)).filter(entry => folderKey(entry.path) !== key);
      entries.unshift({ path: canonical, last_used: now });
      return entries.slice(0, MAX_ENTRIES);
    });
    return this.list();
  }
}
