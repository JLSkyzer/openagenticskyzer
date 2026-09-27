import { isAbsolute, join } from 'node:path';
import { mkdir, readdir, rename, copyFile, unlink, lstat } from 'node:fs/promises';
import { JsonStore } from './json-store.mts';

export interface MigrationResult {
  moved: number;
  errors: string[];
}

const REDIRECT_FILE = 'redirect.json';

function redirectPath(defaultHome: string): string {
  return join(defaultHome, REDIRECT_FILE);
}

/**
 * Resolves the real data home at startup. The fixed OS-default location (`~/.openagent`, never
 * itself relocated) always holds a tiny redirect.json once the user has moved their data
 * elsewhere — everything else (settings, connections, folder history…) lives at whatever it
 * points to. No redirect on disk means the default location IS the real home, as always.
 */
export async function resolveDataHome(defaultHome: string): Promise<string> {
  const store = new JsonStore();
  const pointer = await store.read<{ data_dir?: unknown }>(redirectPath(defaultHome), {});
  const dataDir = typeof pointer.data_dir === 'string' ? pointer.data_dir : '';
  return dataDir && isAbsolute(dataDir) ? dataDir : defaultHome;
}

async function moveFile(src: string, dst: string): Promise<void> {
  try {
    await rename(src, dst);
  } catch (error: any) {
    if (error.code !== 'EXDEV') throw error; // different drive: rename can't cross it, fall back
    await copyFile(src, dst);
    await unlink(src);
  }
}

/**
 * Moves every top-level data file from `currentHome` into `newDir` (created if needed) and
 * points the fixed redirect at `defaultHome` to `newDir`, so the next start finds it there.
 * Mirrors storage.py::migrate_data_dir's UX (files moved, restart required) — the whole data
 * home moves here rather than just loose session files, since this app keeps everything
 * (settings, connections, folder history, prompts) flat in one root, not a separate sessions dir.
 */
export async function migrateDataDir(currentHome: string, defaultHome: string, newDir: string): Promise<MigrationResult> {
  if (!isAbsolute(newDir)) throw new Error('Chemin absolu requis');
  await mkdir(newDir, { recursive: true });
  let moved = 0;
  const errors: string[] = [];
  if (newDir !== currentHome) {
    let entries: string[] = [];
    try { entries = await readdir(currentHome); } catch { entries = []; }
    for (const name of entries) {
      if (name === REDIRECT_FILE) continue; // the pointer itself never moves with the data
      const src = join(currentHome, name);
      try {
        const info = await lstat(src);
        if (!info.isFile()) continue; // this app only ever keeps flat files at the home root
        await moveFile(src, join(newDir, name));
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
