import { isAbsolute, join } from 'node:path';
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
    return Array.isArray(raw) ? raw.filter(isValidEntry) : [];
  }
  async list(): Promise<FolderListItem[]> {
    const entries = await this.validEntries();
    return entries
      .slice()
      .sort((a, b) => b.last_used.localeCompare(a.last_used))
      .map(entry => ({ path: entry.path, name: folderName(entry.path), last_used: entry.last_used }));
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
    await this.store.update<unknown>(this.path(), [], current => {
      const entries = (Array.isArray(current) ? current.filter(isValidEntry) : []).filter(e => e.path !== canonical);
      entries.unshift({ path: canonical, last_used: now });
      return entries.slice(0, MAX_ENTRIES);
    });
    return this.list();
  }
}
