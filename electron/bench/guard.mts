// The game guard of the benchmark: a heavy run (a real model) never starts while a game runs (lesson 2026-10-24).
// Run directly: `node --experimental-strip-types bench/guard.mts` exits 1 and names the games, else exits 0 — chain it
// with `&&`, never `;`.
// Tolerated (other sessions' tests): Unity in batch mode (`Unity.exe`) and the AxionEngine processes.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

export const GAME_PROCESSES: readonly string[] = ['javaw.exe', 'Minecraft.exe', 'MinecraftLauncher.exe'];

const TOLERATED = (image: string) => /^unity\.exe$/i.test(image) || /^axionengine/i.test(image);

/** One CSV row of `tasklist /fo csv`: its quoted fields. */
function fields(row: string): string[] {
  const out: string[] = [];
  const pattern = /"((?:[^"]|"")*)"/g;
  for (const match of row.matchAll(pattern)) out.push(match[1].replace(/""/g, '"'));
  return out;
}

/** The games in `tasklist /v /fo csv` output: an image in GAME_PROCESSES (any case), or a window title that names
 * Minecraft; Unity.exe and AxionEngine* never count. The header (localised on a French Windows) is skipped: its PID
 * column is not a number. Each image once, in order. */
export function gamesIn(tasklistCsv: string): string[] {
  const games = GAME_PROCESSES.map(name => name.toLowerCase());
  const found: string[] = [];
  for (const row of tasklistCsv.split(/\r?\n/)) {
    const [image, pid, ...rest] = fields(row);
    if (!image || !/^\d+$/.test(pid ?? '') || TOLERATED(image)) continue;
    const title = rest.at(-1) ?? '';
    if ((games.includes(image.toLowerCase()) || /minecraft/i.test(title)) && !found.includes(image)) found.push(image);
  }
  return found;
}

/** The games running now; [] outside Windows. */
export async function runningGames(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const { stdout } = await promisify(execFile)('tasklist', ['/v', '/fo', 'csv'], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  return gamesIn(stdout);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const names = await runningGames();
  if (names.length) {
    console.error(`Jeu en cours : ${names.join(', ')} — passage lourd refusé.`);
    process.exit(1);
  }
  process.exit(0);
}
