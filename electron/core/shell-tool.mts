import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AgentTool } from './agent.mts';
import { killTree, runProcess } from './process.mts';
import { defineTool } from './tool-kit.mts';

// ── environment ───────────────────────────────────────────────────────────────────
// A command the model runs must not inherit the app's secrets: `printenv`/`env` would hand
// them straight back. Names are matched, not values, so nothing needs to be known in advance.
const SECRET_NAME = /API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSW(?:OR)?D|CREDENTIAL|PRIVATE[_-]?KEY|_KEY$/i;
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined && !SECRET_NAME.test(name)) clean[name] = value;
  return clean;
}

// ── output shaping (ported from shell_exec.py: it protects the model's context window) ──
const MAX_OUTPUT_CHARS = 3000;
const NOISE = /^(?:Progress: resolved \d+|\++$|\.{3,}\/\S+ \|)/;
function collapseNoise(text: string): string {
  const result: string[] = [];
  let count = 0;
  let last = '';
  for (const line of text.split(/\r?\n/)) {
    if (NOISE.test(line)) { count++; last = line; continue; }
    if (count > 2) result.push(`  ... (${count} lines collapsed: install/listing progress) ...`);
    else if (count > 0) result.push(last);
    count = 0;
    result.push(line);
  }
  if (count > 2) result.push(`  ... (${count} lines collapsed) ...`);
  else if (count > 0) result.push(last);
  return result.join('\n');
}
export function shapeOutput(raw: string): string {
  let output = collapseNoise(raw.trim() || '(no output)');
  const head200 = output.slice(0, 200).toLowerCase();
  if (head200.startsWith('<!doctype') || head200.startsWith('<html') || (output.startsWith('{') && output.length > MAX_OUTPUT_CHARS)) {
    const firstLine = output.split(/\r?\n/)[0].slice(0, 120);
    return `${firstLine}\n... (HTML/JSON response truncated — ${output.length} chars total) ...\nTip: use \`curl -s -o /dev/null -w "%{http_code}"\` to check status only.`;
  }
  if (output.length > MAX_OUTPUT_CHARS) {
    const lines = output.split(/\r?\n/);
    const omitted = Math.max(0, lines.length - 25);
    output = `${lines.slice(0, 5).join('\n')}\n... (${omitted} lines omitted) ...\n${lines.slice(-20).join('\n')}`;
    if (output.length > MAX_OUTPUT_CHARS) output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n... (truncated at ${MAX_OUTPUT_CHARS} chars)`;
  }
  return output;
}

// ── dev servers ───────────────────────────────────────────────────────────────────
const SERVER_KEYWORDS = [
  'streamlit run', 'uvicorn', 'flask run', 'fastapi run', 'next dev',
  'npm start', 'npm run dev', 'npm run start', 'yarn start', 'yarn dev',
  'pnpm dev', 'pnpm start', 'pnpm run dev', 'pnpm run start',
];
/**
 * True when a command of the chain STARTS with a server launcher. Python matched the keyword
 * anywhere, so `git commit -m "fix uvicorn"` was detached as a server and its output lost.
 */
export function isServerCommand(command: string): boolean {
  const withoutQuotes = command.replace(/"[^"]*"|'[^']*'/g, '""');
  return withoutQuotes.split(/&&|\|\||[;|&\n]/).some(segment => {
    const s = segment.replace(/^\s*(?:[A-Za-z_]\w*=\S*\s+)*/, '').trim().toLowerCase();
    return SERVER_KEYWORDS.some(keyword => s === keyword || s.startsWith(keyword + ' '));
  });
}

interface RunningServer { child: ChildProcess }
const servers = new Map<string, RunningServer>();
const STARTUP_WINDOW_MS = 2500;
const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

/** Stops every background server started by run_command, whole process trees included. */
export async function stopAllServers(): Promise<void> {
  const running = [...servers.values()].map(entry => entry.child).filter(alive);
  servers.clear();
  await Promise.all(running.map(child => killTree(child)));
}

async function startServer(command: string, shellCommand: string, root: string, env: NodeJS.ProcessEnv): Promise<string> {
  const key = `${root}\n${command}`;
  const existing = servers.get(key)?.child;
  if (existing && alive(existing)) return `Server is already running (pid=${existing.pid}): \`${command}\``;

  const child = spawn(shellCommand, { shell: true, cwd: root, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  servers.set(key, { child });
  // The first seconds of output are what tells the model the server really came up (or why not);
  // afterwards the pipes keep being drained and dropped so the server never blocks on them.
  let startup = '';
  let collecting = true;
  const onData = (chunk: Buffer) => { if (collecting && startup.length < 4000) startup += chunk.toString('utf8'); };
  child.stdout!.on('data', onData);
  child.stderr!.on('data', onData);

  const outcome = await new Promise<{ code: number | null } | { error: Error } | null>(resolveOutcome => {
    const timer = setTimeout(() => resolveOutcome(null), STARTUP_WINDOW_MS);
    child.once('exit', code => { clearTimeout(timer); resolveOutcome({ code }); });
    child.once('error', error => { clearTimeout(timer); resolveOutcome({ error }); });
  });
  collecting = false;
  if (outcome !== null) {
    servers.delete(key);
    if ('error' in outcome) return `Error executing command: ${outcome.error.message}`;
    return `Server exited immediately (exit code ${outcome.code}):\n${shapeOutput(startup)}`;
  }
  return `Server started in background (pid=${child.pid}): \`${command}\`` + (startup.trim() ? `\n[startup output]\n${shapeOutput(startup)}` : '');
}

// ── Next.js starter gate (ported): do not serve the untouched create-next-app page ──
const NEXT_DEFAULT_MARKERS = ['vercel.svg', 'next.svg', 'create-next-app', 'To get started, edit', 'get-started'];
async function checkNextPage(command: string, root: string): Promise<string | null> {
  if (!['pnpm run dev', 'npm run dev', 'next dev'].some(keyword => command.toLowerCase().includes(keyword))) return null;
  const cd = /^cd\s+"?([^"&]+?)"?\s*&&/.exec(command);
  const projectDir = cd ? resolve(root, cd[1].trim()) : root;
  const inside = relative(root, projectDir);
  if (inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) return null;
  for (const candidate of [join(projectDir, 'app', 'page.tsx'), join(projectDir, 'src', 'app', 'page.tsx')]) {
    let content: string;
    try {
      const info = await lstat(candidate);
      if (!info.isFile() || info.size > 1024 * 1024) continue;
      content = await readFile(candidate, 'utf8');
    } catch { continue; }
    if (NEXT_DEFAULT_MARKERS.some(marker => content.includes(marker))) {
      const rel = relative(root, candidate).split(sep).join('/');
      return `BLOCKED: ${rel} still has the default Next.js starter content (found default marker).\n` +
        'You MUST overwrite it with the real landing page that imports and renders your components before launching the dev server.\n' +
        `Call create_file('${rel}', <full page content>) now.`;
    }
  }
  return null;
}

// ── the tool ──────────────────────────────────────────────────────────────────────
export interface ShellOptions { env?: NodeJS.ProcessEnv }

/**
 * run_command. It always asks for permission (category "shell"); what it guarantees on top:
 * it runs in the project root, without the app's secrets, and a timeout or Stop kills the
 * whole process tree instead of just the shell.
 */
export async function shellTools(folder: string, options: ShellOptions = {}): Promise<AgentTool[]> {
  if (!isAbsolute(folder)) throw new Error('Dossier projet absolu requis');
  const root = await realpath(folder);
  if (!(await lstat(root)).isDirectory()) throw new Error('Dossier projet invalide');

  return [
    defineTool({
      name: 'run_command',
      description: 'Exécuter une commande shell dans le dossier du projet et renvoyer sa sortie (stdout + stderr). Un « cd » n’a aucun effet durable : le dossier de travail ne change jamais. Les serveurs de développement (npm run dev, uvicorn…) sont lancés en arrière-plan.',
      category: 'shell',
      properties: {
        command: { type: 'string', maxLength: 8000, description: 'Commande à exécuter' },
        timeout: { type: 'integer', maximum: 600, description: 'Délai maximal en secondes (300 par défaut)' },
      },
      required: ['command'],
      execute: async (args, signal) => {
        const command = (args.command as string).trim();
        if (!command) throw new Error('Commande vide');
        const timeout = (args.timeout as number | undefined) ?? 300;
        const env = scrubbedEnv(options.env ?? process.env);
        // The Windows shell prints in the OEM code page: switch it to UTF-8 so accents survive.
        const shellCommand = process.platform === 'win32' ? `chcp 65001>nul & ${command}` : command;

        if (isServerCommand(command)) {
          const blocked = await checkNextPage(command, root);
          return blocked ?? startServer(command, shellCommand, root, env);
        }

        const result = await runProcess(shellCommand, [], { cwd: root, env, timeout: timeout * 1000, signal, shell: true, maxBytes: 1024 * 1024 });
        const out = result.stdout.replace(/\r\n/g, '\n').replace(/\n$/, '');
        const err = result.stderr.replace(/\r\n/g, '\n').replace(/\n$/, '');
        let output = out;
        if (err) output += `\n[stderr]\n${err}`;
        if (result.truncated) output += '\n[output cut at 1 MiB per stream]';

        if (result.timedOut) {
          const partial = output.trim();
          return `Command timed out after ${timeout}s.` + (partial ? `\n[partial output]\n${shapeOutput(partial)}` : '');
        }
        if (result.code !== 0) output += `\n[exit code: ${result.code}]`;
        let shaped = shapeOutput(output);
        if (/\bcd\b/i.test(command)) shaped += `\n[cwd: ${root}]`;
        return shaped;
      },
    }),
  ];
}
