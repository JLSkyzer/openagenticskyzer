// File-system helpers shared by several test files (not a test file: tests/all.mts does not import it).
// Users: safe-move.test.mts (seedTree, snapshot), cleanup.test.mts (localDay, expectedArchive),
// worker-cleanup.test.mts (expectedArchive); meant for the data-dir migration tests (R4: seedTree, snapshot).
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

/** A small tree with a binary file large enough to span several read chunks. */
export async function seedTree(dir: string): Promise<void> {
  await mkdir(join(dir, 'sub', 'deeper'), { recursive: true });
  await writeFile(join(dir, 'a.json'), '{"a":1}');
  await writeFile(join(dir, 'sub', 'b.bin'), randomBytes(300_000));
  await writeFile(join(dir, 'sub', 'deeper', 'c.txt'), 'profond');
}

/** Every file under `dir`, by relative path, as base64 — two equal snapshots mean the same bytes everywhere. */
export async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    out[full.slice(dir.length)] = (await readFile(full)).toString('base64');
  }
  return out;
}

/** The local calendar day `AAAA-MM-JJ`, as the retention archive names its folders — computed here independently of
 * core/cleanup.mts, so a test does not check the module against itself. */
export function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** <home>/retention-archive/<AAAA-MM-JJ>/<nom>-<8 premiers caractères du SHA-256 du chemin canonique>, computed here
 * independently of core/cleanup.mts (for a folder whose name needs no sanitising). */
export async function expectedArchive(home: string, folder: string, now: Date): Promise<string> {
  const canonical = await realpath(folder);
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 8);
  return join(home, 'retention-archive', localDay(now), `${canonical.split(/[\\/]/).pop()}-${hash}`);
}
