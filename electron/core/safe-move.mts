import { constants, createReadStream } from 'node:fs';
import { copyFile, cp, lstat, readdir, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** True when something (file, folder or link) is at `path`; only "not found" is false, any other error is thrown. */
export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
}

function digest(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

/** True when `copy` holds exactly what `original` holds: the same names at every level, the same bytes in every file
 * (compared by SHA-256, streamed — a data home can hold large files). A link has no bytes of its own to compare. */
export async function sameContent(original: string, copy: string): Promise<boolean> {
  const info = await lstat(original);
  let other: import('node:fs').Stats;
  try { other = await lstat(copy); } catch { return false; }
  if (info.isDirectory()) {
    if (!other.isDirectory()) return false;
    const [left, right] = await Promise.all([readdir(original), readdir(copy)]);
    if (left.length !== right.length) return false;
    const names = new Set(right);
    for (const name of left) {
      if (!names.has(name) || !(await sameContent(join(original, name), join(copy, name)))) return false;
    }
    return true;
  }
  if (info.isFile()) return other.isFile() && info.size === other.size && (await digest(original)) === (await digest(copy));
  return true;
}

/** The half of a move that crosses drives: copy, check every byte, then remove the source. A copy that fails or
 * differs is removed and the source kept — nothing is ever lost. Exported so a test can drive it on one drive. */
export async function copyThenRemove(src: string, dst: string): Promise<void> {
  if (await exists(dst)) throw new Error('la destination existe déjà');
  const info = await lstat(src);
  try {
    if (info.isDirectory()) await cp(src, dst, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    else await copyFile(src, dst, constants.COPYFILE_EXCL);
    if (!(await sameContent(src, dst))) throw new Error('copie différente de l’original');
  } catch (error: any) {
    // Something that appeared at `dst` after the check above is not ours to remove.
    if (error?.code !== 'EEXIST' && error?.code !== 'ERR_FS_CP_EEXIST') await rm(dst, { recursive: true, force: true });
    throw error;
  }
  // Only now, the whole copy checked, is anything removed. A removal can still stop partway (a file or folder held
  // by another program): the error then says exactly what is where — never that the source is intact when it is not.
  try {
    await rm(src, { recursive: true });
  } catch (error: any) {
    const reason = error instanceof Error ? error.message : String(error);
    let left: boolean;
    try { left = await exists(src); } catch { left = true; }
    if (!left) return; // gone after all: the move is complete
    let untouched: boolean;
    try { untouched = await sameContent(src, dst); } catch { untouched = false; }
    throw new Error(`copie complète dans ${dst}, ${untouched ? 'source non supprimée (les deux sont conservés)' : 'source partiellement supprimée'} : ${reason}`);
  }
}

/** Moves a file or a whole directory, never over something already at `dst` (fs.rename would replace a file under
 * Windows). Same drive: one rename. Another drive (EXDEV): copyThenRemove. When it throws, either `src` is still in
 * place, or — only when removing the source of a complete, checked copy failed — the message says so precisely
 * (« copie complète dans <dst>, source … »). */
export async function moveEntry(src: string, dst: string): Promise<void> {
  if (await exists(dst)) throw new Error('la destination existe déjà');
  try {
    await rename(src, dst);
  } catch (error: any) {
    if (error?.code !== 'EXDEV') throw error;
    await copyThenRemove(src, dst);
  }
}
