import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { AgentTool } from './agent.mts';
import { runProcess } from './process.mts';
import { defineTool, type ParamRule } from './tool-kit.mts';

const QUICK_TIMEOUT = 15000;
// Commits run hooks, and checkout/push/pull can touch the network or the disk for a while.
const SLOW_TIMEOUT = 60000;

// Names taken from the model end up as git arguments, so they are checked at the boundary
// instead of being trusted and guarded afterwards:
//  - a remote is the NAME of a configured remote: no URL, no ':' (so no ext:: transport that
//    runs commands), never an option;
//  - a branch/revision has no ':' or leading '+' (no refspec: nothing can delete or force a
//    remote branch) and never starts with '-' (nothing can become an option).
const REMOTE_NAME = /^[A-Za-z0-9][\w.\-/]*$/;
const REF_NAME = /^[A-Za-z0-9_][\w.\-/@{}~^]*$/;
function remoteName(value: string) {
  if (!REMOTE_NAME.test(value)) throw new Error('Nom de dépôt distant invalide (un nom de remote configuré est attendu, pas une URL)');
  return value;
}
function refName(value: string, what: string) {
  if (!REF_NAME.test(value)) throw new Error(`Nom de ${what} invalide`);
  return value;
}

// Files that must never reach the model through a diff or blame, whatever their tracking state.
const isProtected = (path: string) => path.replace(/\\/g, '/').split('/').some(s => /^\.env(?:\.|$)/i.test(s) || ['.git', '.openagent'].includes(s.toLowerCase()));
const EXCLUDE_ENV = [':(exclude,glob)**/.env', ':(exclude,glob)**/.env.*'];

/** shlex-like split (quotes group words); backslashes become '/' first so Windows paths survive. */
function splitFiles(input: string): string[] {
  const text = input.replace(/\\/g, '/');
  const files: string[] = [];
  let current = '';
  let quote: string | null = null;
  let started = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null; else current += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; started = true; }
    else if (/\s/.test(ch)) { if (started || current) files.push(current); current = ''; started = false; }
    else current += ch;
  }
  if (quote) throw new Error('Guillemet non fermé dans la liste de fichiers');
  if (started || current) files.push(current);
  const kept = files.filter(Boolean);
  if (!kept.length) throw new Error('Aucun fichier indiqué');
  if (kept.length > 200) throw new Error('Trop de fichiers (200 maximum)');
  return kept;
}

/** Git tools for the active project. No shell is ever involved: every value is one argv entry. */
export async function gitTools(folder: string): Promise<AgentTool[]> {
  if (!isAbsolute(folder)) throw new Error('Dossier projet absolu requis');
  const root = await realpath(folder);
  if (!(await lstat(root)).isDirectory()) throw new Error('Dossier projet invalide');

  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C' };
  // core.fsmonitor and ext:: are code-execution hooks a repository (or a remote name) could carry.
  const base = ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never'];
  const git = async (args: string[], signal: AbortSignal, timeout = QUICK_TIMEOUT): Promise<string> => {
    let result;
    try { result = await runProcess('git', [...base, ...args], { cwd: root, env, timeout, signal, maxBytes: 1024 * 1024 }); }
    catch (error: any) {
      if (error?.code === 'ENOENT') throw new Error('git non trouvé : installez Git et ajoutez-le au PATH');
      throw error;
    }
    if (result.timedOut) throw new Error(`timeout (>${timeout / 1000}s)`);
    if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'commande échouée');
    return result.stdout.trim();
  };
  const okIfEmpty = (out: string) => out || 'OK (pas de sortie)';
  const fileRule: ParamRule = { type: 'string', maxLength: 4000, description: 'Fichiers séparés par des espaces (guillemets pour les noms avec espaces)' };
  const pick = (value: unknown, fallback: string) => (typeof value === 'string' && value ? value : fallback);

  return [
    defineTool({ name: 'git_status', description: 'État du dépôt (branche et fichiers modifiés).', category: 'read', properties: {}, execute: async (_a, signal) => {
      const out = await git(['status', '--short', '--branch'], signal);
      return out.split('\n').length <= 1 ? 'Working tree clean.' : out;
    } }),
    defineTool({ name: 'git_diff', description: 'Différences non indexées, éventuellement pour un seul fichier.', category: 'read',
      properties: { file: { type: 'string', maxLength: 1000, description: 'Fichier ou dossier (facultatif)' } }, execute: async (args, signal) => {
        const file = args.file as string | undefined;
        if (file && isProtected(file)) throw new Error('Fichier protégé : diff refusé');
        // .env files are excluded even when tracked: a committed secret must not leak through a diff.
        return (await git(['diff', '--no-ext-diff', '--no-textconv', '--', ...(file ? [file] : []), ...EXCLUDE_ENV], signal)) || 'No changes.';
      } }),
    defineTool({ name: 'git_diff_staged', description: 'Différences indexées (prêtes à être commitées).', category: 'read', properties: {}, execute: async (_a, signal) =>
      (await git(['diff', '--staged', '--no-ext-diff', '--no-textconv', '--', ...EXCLUDE_ENV], signal)) || 'No changes (staged).' }),
    defineTool({ name: 'git_log', description: 'Derniers commits.', category: 'read',
      properties: { n: { type: 'integer', maximum: 200, description: 'Nombre de commits (10 par défaut)' }, oneline: { type: 'boolean', description: 'Une ligne par commit (vrai par défaut)' } },
      execute: async (args, signal) => {
        const n = (args.n as number | undefined) ?? 10;
        const oneline = (args.oneline as boolean | undefined) ?? true;
        return okIfEmpty(await git(['log', '-n', String(n), oneline ? '--oneline' : '--format=%h %an %ar%n%s%n'], signal));
      } }),
    defineTool({ name: 'git_blame', description: 'Qui a modifié chaque ligne d’un fichier (plage facultative).', category: 'read',
      properties: { file: { type: 'string', maxLength: 1000 }, start: { type: 'integer', description: 'Première ligne (1 par défaut)' }, end: { type: 'integer', minimum: 0, description: 'Dernière ligne (0 = jusqu’à la fin)' } },
      required: ['file'], execute: async (args, signal) => {
        const file = args.file as string;
        const start = (args.start as number | undefined) ?? 1;
        const end = (args.end as number | undefined) ?? 0;
        if (isProtected(file)) throw new Error('Fichier protégé : blame refusé');
        if (end > 0 && end < start) throw new Error('Plage de lignes invalide');
        const range = end > 0 || start > 1 ? ['-L', `${start},${end > 0 ? end : ''}`] : [];
        return okIfEmpty(await git(['blame', ...range, '--', file], signal));
      } }),
    defineTool({ name: 'git_branch_list', description: 'Liste des branches locales et distantes.', category: 'read', properties: {}, execute: async (_a, signal) => okIfEmpty(await git(['branch', '-a'], signal)) }),

    defineTool({ name: 'git_add', description: 'Indexer des fichiers (ou « . » pour tout).', category: 'write', properties: { files: fileRule }, required: ['files'],
      execute: async (args, signal) => okIfEmpty(await git(['add', '--', ...splitFiles(args.files as string)], signal)) }),
    defineTool({ name: 'git_commit', description: 'Créer un commit (indexe d’abord les fichiers donnés, sinon commite l’index).', category: 'write',
      properties: { message: { type: 'string', maxLength: 5000 }, files: fileRule }, required: ['message'],
      execute: async (args, signal) => {
        const message = (args.message as string).trim();
        if (!message) throw new Error('Message de commit vide');
        if (typeof args.files === 'string' && args.files.trim()) await git(['add', '--', ...splitFiles(args.files)], signal);
        return okIfEmpty(await git(['commit', '-m', message], signal, SLOW_TIMEOUT));
      } }),
    defineTool({ name: 'git_checkout', description: 'Changer de branche (ne restaure jamais un fichier).', category: 'write', properties: { branch: { type: 'string', maxLength: 200 } }, required: ['branch'],
      // The trailing "--" makes git read the value as a revision only: naming a file fails
      // instead of silently discarding its uncommitted changes.
      execute: async (args, signal) => okIfEmpty(await git(['checkout', refName(args.branch as string, 'branche'), '--'], signal, SLOW_TIMEOUT)) }),
    defineTool({ name: 'git_create_branch', description: 'Créer une branche et s’y placer (depuis from_branch si donné).', category: 'write',
      properties: { name: { type: 'string', maxLength: 200 }, from_branch: { type: 'string', maxLength: 200 } }, required: ['name'],
      execute: async (args, signal) => {
        const name = refName(args.name as string, 'branche');
        const from = typeof args.from_branch === 'string' && args.from_branch ? [refName(args.from_branch, 'point de départ')] : [];
        return okIfEmpty(await git(['checkout', '-b', name, ...from], signal, SLOW_TIMEOUT));
      } }),
    defineTool({ name: 'git_stash', description: 'Mettre les modifications de côté.', category: 'write', properties: { message: { type: 'string', maxLength: 200 } },
      execute: async (args, signal) => okIfEmpty(await git(['stash', 'push', ...(typeof args.message === 'string' && args.message ? ['-m', args.message] : [])], signal)) }),
    defineTool({ name: 'git_stash_pop', description: 'Réappliquer la dernière mise de côté.', category: 'write', properties: {}, execute: async (_a, signal) => okIfEmpty(await git(['stash', 'pop'], signal)) }),

    // Remote operations: category "shell" so they always ask, even when file writes are pre-approved.
    defineTool({ name: 'git_push', description: 'Envoyer les commits vers un remote configuré (jamais de force ni de suppression).', category: 'shell',
      properties: { remote: { type: 'string', maxLength: 100 }, branch: { type: 'string', maxLength: 200 } },
      execute: async (args, signal) => {
        const remote = remoteName(pick(args.remote, 'origin'));
        const branch = typeof args.branch === 'string' && args.branch ? [refName(args.branch, 'branche')] : [];
        return okIfEmpty(await git(['push', '--', remote, ...branch], signal, SLOW_TIMEOUT));
      } }),
    defineTool({ name: 'git_pull', description: 'Récupérer un remote configuré et avancer en fast-forward uniquement.', category: 'shell',
      properties: { remote: { type: 'string', maxLength: 100 } },
      execute: async (args, signal) => {
        const remote = remoteName(pick(args.remote, 'origin'));
        // "git pull -- <remote>" re-invokes fetch without forwarding the "--": fetch then merge instead.
        await git(['fetch', '--', remote], signal, SLOW_TIMEOUT);
        return okIfEmpty(await git(['merge', '--ff-only', 'FETCH_HEAD'], signal, SLOW_TIMEOUT));
      } }),
  ];
}
