import { isAbsolute, join, relative, resolve } from 'node:path';
import { mkdir, readdir } from 'node:fs/promises';
import { JsonStore } from './json-store.mts';
import { moveEntry } from './safe-move.mts';
import { REDIRECT_FILE, resolveDataHome } from './data-home.cjs';

export interface MigrationResult {
  moved: number;
  errors: string[];
}

/**
 * Resolves the real data home at startup. The fixed OS-default location (`~/.openagent`, never
 * itself relocated) always holds a tiny redirect.json once the user has moved their data
 * elsewhere — everything else (settings, connections, folder history…) lives at whatever it
 * points to. No redirect on disk means the default location IS the real home, as always.
 * Defined once in core/data-home.cjs, which main.cjs (the connections vault) and worker.mjs both use.
 */
export { resolveDataHome };

function redirectPath(defaultHome: string): string {
  return join(defaultHome, REDIRECT_FILE);
}

/** Path identity: resolved, and case-insensitive under Windows. */
function samePath(a: string, b: string): boolean {
  const key = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return key(a) === key(b);
}
/** True when `inner` lies strictly below `outer`. */
function isInside(inner: string, outer: string): boolean {
  const key = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  const rel = relative(key(outer), key(inner));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Moves EVERYTHING in `currentHome` — files and folders (knowledge/, tools/, caches, retention-archive/…) — into
 * `newDir` (created if needed), each entry through core/safe-move.mts (one rename on the same drive; across drives a
 * copy checked byte for byte before the source is removed; never over an existing entry), then points the fixed
 * redirect at `defaultHome` to `newDir`, so the next start (worker AND main process) finds it there. An entry that
 * cannot move is listed in `errors` with the reason: an existing destination keeps both, a new folder chosen inside
 * an entry leaves that entry where it is. `moved` counts top-level entries, a folder counting as one. A restart is
 * required, as before.
 */
export async function migrateDataDir(currentHome: string, defaultHome: string, newDir: string): Promise<MigrationResult> {
  if (!isAbsolute(newDir)) throw new Error('Chemin absolu requis');
  await mkdir(newDir, { recursive: true });
  let moved = 0;
  const errors: string[] = [];
  if (!samePath(newDir, currentHome)) {
    let entries: string[] = [];
    try { entries = await readdir(currentHome); } catch { entries = []; }
    for (const name of entries) {
      if (name === REDIRECT_FILE) continue; // the pointer itself never moves with the data
      const src = join(currentHome, name);
      if (samePath(src, newDir)) continue; // the new folder, chosen inside the old one
      if (isInside(newDir, src)) { errors.push(`${name} : contient le nouveau dossier, non déplacé`); continue; }
      try {
        await moveEntry(src, join(newDir, name));
        moved++;
      } catch (error: any) {
        errors.push(`${name} : ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const store = new JsonStore();
  await store.update<Record<string, unknown>>(redirectPath(defaultHome), {}, () => ({ data_dir: newDir }));
  return { moved, errors };
}
