import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { metadataDirectory } from './json-store.mts';
import type { FoldersService } from './folders.mts';

const DAY_MS = 24 * 60 * 60 * 1000;

async function removeIfExists(file: string): Promise<boolean> {
  try {
    await rm(file);
    return true;
  } catch (e: any) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

/**
 * Wipes stored conversation data (never the folder-history entry itself) for every project whose
 * `last_used` is older than `retentionDays`. `retentionDays <= 0` means "keep forever" (no-op),
 * matching the `session_retention_days` setting's `0` choice.
 */
export async function cleanupOldFolders(folders: FoldersService, retentionDays: number): Promise<{ cleaned: number }> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return { cleaned: 0 };
  const cutoff = Date.now() - retentionDays * DAY_MS;
  let cleaned = 0;
  for (const entry of await folders.list()) {
    if (new Date(entry.last_used).getTime() >= cutoff) continue;
    let dir: string;
    try { dir = await metadataDirectory(entry.path); }
    catch { continue; }
    const removedCurrent = await removeIfExists(join(dir, 'conversations.json'));
    const removedLegacy = await removeIfExists(join(dir, 'chat_history.json'));
    if (removedCurrent || removedLegacy) cleaned++;
  }
  return { cleaned };
}
