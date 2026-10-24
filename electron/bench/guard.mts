// The game guard of the benchmark: a heavy run (a real model) never starts while a game runs (lesson 2026-10-24).
// Run directly: `node --experimental-strip-types bench/guard.mts` exits 1 and names the games, else exits 0 — chain it
// with `&&`, never `;`. bench/run.mts checks it again before each session of a heavy run.
// Tolerated (other sessions' tests): Unity in batch mode (`Unity.exe`) and the AxionEngine processes.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { csvFields } from './csv.mts';

export const GAME_PROCESSES: readonly string[] = ['javaw.exe', 'Minecraft.exe', 'MinecraftLauncher.exe'];

const TOLERATED = (image: string) => /^unity\.exe$/i.test(image) || /^axionengine/i.test(image);

/** The games in CSV process rows (`"image","pid",…,"window title"`: `tasklist /v /fo csv`, or the PowerShell list of
 * runningGames): an image in GAME_PROCESSES (any case), or a window title that names Minecraft; Unity.exe and
 * AxionEngine* never count. A header (localised on a French Windows) is skipped: its PID column is not a number. Each
 * image once, in order. */
export function gamesIn(tasklistCsv: string): string[] {
  const games = GAME_PROCESSES.map(name => name.toLowerCase());
  const found: string[] = [];
  for (const row of tasklistCsv.split(/\r?\n/)) {
    const [image, pid, ...rest] = csvFields(row);
    if (!image || !/^\d+$/.test(pid ?? '') || TOLERATED(image)) continue;
    const title = rest.at(-1) ?? '';
    if ((games.includes(image.toLowerCase()) || /minecraft/i.test(title)) && !found.includes(image)) found.push(image);
  }
  return found;
}

// Every process as `"name.exe","pid","window title"`, UTF-8. Get-Process answers in well under a second, where
// `tasklist /v` took about 24 s (it resolves every process's user and CPU time).
const LIST = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  "Get-Process | ForEach-Object { '\"{0}.exe\",\"{1}\",\"{2}\"' -f $_.ProcessName, $_.Id, ($_.MainWindowTitle -replace '\"', '\"\"') }",
].join('; ');

/** The games running now; [] outside Windows. */
export async function runningGames(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const encoded = Buffer.from(LIST, 'utf16le').toString('base64');
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 60000 });
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
