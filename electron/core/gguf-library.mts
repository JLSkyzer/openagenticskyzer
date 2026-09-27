import { isAbsolute, basename } from 'node:path';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { JsonStore } from './json-store.mts';

export interface GgufEntry {
  id: string;
  name: string;
  path: string;
  size_bytes: number;
  added_at: string;
}

function isValidEntry(value: unknown): value is GgufEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return typeof c.id === 'string' && typeof c.name === 'string' && typeof c.path === 'string'
    && typeof c.size_bytes === 'number' && typeof c.added_at === 'string';
}

/**
 * The user's own .gguf files ("j'importe mes fichiers .gguf dans ma librairie"): a list of REFERENCES to
 * files the user already has on disk, never a copy — a model can be many gigabytes, and copying it would
 * be slow and double the disk space for no benefit. Same pattern as FoldersService (folders.mts): a plain
 * JSON list in the app's data directory, absolute paths only, corruption tolerated as an empty list.
 */
export class GgufLibrary {
  private home: string;
  private store = new JsonStore();
  constructor(home: string) {
    if (!isAbsolute(home)) throw new Error('Répertoire de données absolu requis');
    this.home = home;
  }
  private path() {
    return join(this.home, 'gguf-library.json');
  }
  private async validEntries(): Promise<GgufEntry[]> {
    const raw = await this.store.read<unknown>(this.path(), []);
    return Array.isArray(raw) ? raw.filter(isValidEntry) : [];
  }
  /** The saved list, most recently added first — silently drops an entry whose file is gone or moved. */
  async list(): Promise<GgufEntry[]> {
    const entries = await this.validEntries();
    const present = await Promise.all(entries.map(async entry => (await this.fileOk(entry.path)) ? entry : null));
    return present.filter((entry): entry is GgufEntry => entry !== null).sort((a, b) => b.added_at.localeCompare(a.added_at));
  }
  private async fileOk(path: string): Promise<boolean> {
    try { return (await stat(path)).isFile(); } catch { return false; }
  }
  /** Adds a real, already-chosen .gguf file. Re-adding the same path replaces its entry (fresh id, fresh timestamp) rather than duplicating it. */
  async add(path: string): Promise<GgufEntry> {
    if (!isAbsolute(path)) throw new Error('Chemin absolu requis');
    if (!path.toLowerCase().endsWith('.gguf')) throw new Error('Seuls les fichiers .gguf sont acceptés');
    let info;
    try { info = await stat(path); } catch { throw new Error('Fichier introuvable'); }
    if (!info.isFile()) throw new Error('Fichier introuvable');
    const entry: GgufEntry = { id: randomUUID(), name: basename(path), path, size_bytes: info.size, added_at: new Date().toISOString() };
    await this.store.update<unknown>(this.path(), [], current =>
      [...(Array.isArray(current) ? current.filter(isValidEntry) : []).filter(e => e.path !== path), entry],
    );
    return entry;
  }
  /** Forgets an entry by id — the file itself is never touched. An unknown id is a harmless no-op. */
  async remove(id: string): Promise<GgufEntry[]> {
    await this.store.update<unknown>(this.path(), [], current =>
      (Array.isArray(current) ? current.filter(isValidEntry) : []).filter(e => e.id !== id),
    );
    return this.list();
  }
  /** The file path for a known, still-present id — null otherwise (unknown id, or the file is gone). */
  async resolve(id: string): Promise<string | null> {
    const entries = await this.list();
    return entries.find(e => e.id === id)?.path ?? null;
  }
}
