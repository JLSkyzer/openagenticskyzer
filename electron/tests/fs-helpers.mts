// File-system helpers shared by several test files (not a test file: tests/all.mts does not import it).
// Used by safe-move.test.mts and cleanup.test.mts (R1/R2), and meant for the data-dir migration tests (R4).
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

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
