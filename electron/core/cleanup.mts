import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { metadataDirectory } from './json-store.mts';
import { exists, moveEntry } from './safe-move.mts';
import { lastUsedTime, type FoldersService } from './folders.mts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The Python app's chat_history.json goes FIRST. core/conversations.mts reads it as the main branch whenever
 * conversations.json is absent: archiving conversations.json first and then failing on chat_history.json would make
 * the next start serve that stale Python history. In this order, a failure stops the project's archiving, and what
 * stays in place is still what the app read before. */
const HISTORY_FILES = ['chat_history.json', 'conversations.json'];
export const ARCHIVE_DIR = 'retention-archive';

function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `<home>/retention-archive/<AAAA-MM-JJ>/<nom du projet>-<8 premiers caractères du SHA-256 du chemin canonique>`.
 * The day is local (the cleanup's own day); the hash keeps two projects of the same name apart. The name is made a
 * valid Windows file name: a project at a drive root (`D:\`) would otherwise give `D:`, a folder that cannot exist. */
export function archiveDirectory(home: string, canonicalPath: string, date: Date): string {
  const last = canonicalPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const name = last.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'projet';
  const hash = createHash('sha256').update(canonicalPath).digest('hex').slice(0, 8);
  return join(home, ARCHIVE_DIR, localDay(date), `${name}-${hash}`);
}

/**
 * Archives — never deletes — the conversation history (the Python app's chat_history.json, then conversations.json)
 * of every project whose `last_used` is older than `retentionDays`: the files are MOVED into the data home's
 * retention-archive/ (core/safe-move.mts: rename, or a copy checked byte for byte across drives; never over an
 * existing file). A move that fails leaves the file where it was, is logged, and stops that project's archiving.
 * A `last_used` that is not a date is unknown and never expires. The folder-history entry itself is never touched,
 * and nothing ever empties retention-archive/. `retentionDays <= 0` means "keep forever" (no-op), the setting's `0`.
 * Returns `cleaned`, the projects with at least one file archived, and `failed`, the projects whose archiving
 * stopped on a move that failed — at most one per project, since a failure stops that project.
 */
export async function cleanupOldFolders(folders: FoldersService, retentionDays: number, home: string, now: Date = new Date()): Promise<{ cleaned: number; failed: number }> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return { cleaned: 0, failed: 0 };
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  let cleaned = 0;
  let failed = 0;
  for (const entry of await folders.list()) {
    const lastUsed = lastUsedTime(entry.last_used);
    if (lastUsed === undefined || lastUsed >= cutoff) continue;
    let dir: string;
    try { dir = await metadataDirectory(entry.path); }
    catch { continue; }
    const target = archiveDirectory(home, entry.path, now);
    let moved = 0;
    for (const name of HISTORY_FILES) {
      const file = join(dir, name);
      try {
        if (!(await exists(file))) continue;
        await mkdir(target, { recursive: true });
        await moveEntry(file, join(target, name));
        moved++;
      } catch (error) {
        failed++;
        console.error(`[rétention] ${file} n’a pas pu être archivé, il reste en place : ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
    if (moved) cleaned++;
  }
  return { cleaned, failed };
}
