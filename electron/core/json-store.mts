import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, rename, rm, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Un objet JSON est attendu');
}

async function regularFile(file: string) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Fichier de données non régulier');
  } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
}

/** Project metadata cannot be redirected outside its project by a junction. */
export async function metadataDirectory(folder: string) {
  if (!isAbsolute(folder)) throw new Error('Dossier absolu requis');
  const root = await realpath(folder);
  if (!(await lstat(root)).isDirectory()) throw new Error('Projet introuvable');
  const dir = join(root, '.openagent');
  try {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Dossier .openagent redirigé ou invalide');
  } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  return dir;
}

// The main process is the sole data writer. This queue also spans service instances.
const writes = new Map<string, Promise<unknown>>();
export class JsonStore {
  async read<T>(file: string, fallback: T): Promise<T> {
    await regularFile(file);
    let raw: string;
    try { raw = await readFile(file, 'utf8'); }
    catch (e: any) { if (e.code === 'ENOENT') return structuredClone(fallback); throw e; }
    try { return JSON.parse(raw.replace(/^\uFEFF/, '')); }
    catch { throw new Error(`JSON illisible : ${file}. Le fichier est conservé.`); }
  }

  update<T>(file: string, fallback: T, change: (value: T) => T | Promise<T>): Promise<T> {
    const resolved = resolve(file);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const previous = writes.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const current = await this.read(file, fallback);
      const value = await change(current);
      const encoded = JSON.stringify(value, null, 2);
      if (encoded === undefined) throw new Error('Valeur JSON invalide');
      await mkdir(dirname(file), { recursive: true });
      await regularFile(file);
      await regularFile(file + '.pre-electron.bak');
      try { await copyFile(file, file + '.pre-electron.bak', constants.COPYFILE_EXCL); }
      catch (e: any) { if (e.code !== 'ENOENT' && e.code !== 'EEXIST') throw e; }
      const temp = file + '.' + randomUUID() + '.tmp';
      try {
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(encoded + '\n', 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temp, file);
      } finally { await rm(temp, { force: true }); }
      return structuredClone(value);
    });
    writes.set(key, next);
    void next.finally(() => { if (writes.get(key) === next) writes.delete(key); }).catch(() => {});
    return next;
  }
}
