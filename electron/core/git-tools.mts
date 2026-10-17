import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import type { AgentTool } from './agent.mts';
import { isSensitiveFile } from './file-filter.mts';
import { NO_SUBMODULE_WORKTREES, readOnlyGitArgs } from './git-safety.mts';
import { projectPathGuard } from './path-guard.mts';
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

// Files whose content never reaches the model through a diff or blame, whatever their tracking state (2026-10-17): key
// material by name (isSensitiveFile), .env*, .git, .openagent and the project's ignored_patterns (protectedPathMatcher)
// — the same rule as the file tools. git_blame and git_diff's `file` go through the file tools' own path check
// (core/path-guard.mts), on the typed name and on the name on disk. The diffs list the changed paths first and exclude
// the hidden ones, then NAME them on one final line: the model knows a secret file changed, never what it holds.
// EXCLUDE_ENV stays on every real diff as defence in depth.
const EXCLUDE_ENV = [':(exclude,glob)**/.env', ':(exclude,glob)**/.env.*'];
const MASKED_LINE = 'Fichiers masqués (secrets ou exclus), contenu non affiché : ';
// Windows caps a whole command line at 32 767 characters: the pathspecs a diff adds stay well under it, leaving room for
// git's own arguments and the read guard's (git-safety.mts). Beyond it, the visible paths are diffed in batches instead.
const PATHSPEC_BUDGET = 16000;
// agent.mts cuts a tool result at 50 000 characters: the masked line must survive that cut, so the diff before it is cut
// here first. The line itself names at most MASKED_NAMES paths.
const DIFF_OUTPUT_MAX = 48000;
const MASKED_NAMES = 200;

/** One entry of `git diff --name-status -z`: one path, or both names of a rename or copy (old first, as git gives them). */
function parseNameStatus(out: string): string[][] {
  const tokens = out.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const entries: string[][] = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    const count = /^[RC]/.test(status) ? 2 : 1;
    const paths = tokens.slice(i, i + count);
    if (!status || paths.length !== count) throw new Error('Sortie de git diff --name-status illisible');
    entries.push(paths);
    i += count;
  }
  return entries;
}

/** Splits arguments into batches whose total length (plus quoting room) stays under PATHSPEC_BUDGET. */
function batches(groups: string[][]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const group of groups) {
    const length = group.reduce((sum, arg) => sum + arg.length + 3, 0);
    if (current.length && size + length > PATHSPEC_BUDGET) { out.push(current); current = []; size = 0; }
    current.push(...group);
    size += length;
  }
  if (current.length) out.push(current);
  return out;
}

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
export async function gitTools(folder: string, ignoredPatterns: string): Promise<AgentTool[]> {
  if (!isAbsolute(folder)) throw new Error('Dossier projet absolu requis');
  const root = await realpath(folder);
  if (!(await lstat(root)).isDirectory()) throw new Error('Dossier projet invalide');
  // The file tools' own path check and matcher (core/path-guard.mts, core/file-filter.mts), for the same project.
  const { blocked, typedPath, safePath } = projectPathGuard(root, ignoredPatterns);

  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C' };
  // core.fsmonitor and ext:: are code-execution hooks a repository (or a remote name) could carry.
  const base = ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never'];
  const gitMissing = (error: any) => (error?.code === 'ENOENT' ? new Error('git non trouvé : installez Git et ajoutez-le au PATH') : error);
  /** stdout as git wrote it (not trimmed), and whether it went past the 1 MiB kept. */
  const gitRaw = async (args: string[], signal: AbortSignal, timeout = QUICK_TIMEOUT) => {
    let result;
    try { result = await runProcess('git', [...base, ...args], { cwd: root, env, timeout, signal, maxBytes: 1024 * 1024 }); }
    catch (error: any) { throw gitMissing(error); }
    if (result.timedOut) throw new Error(`timeout (>${timeout / 1000}s)`);
    if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'commande échouée');
    return { stdout: result.stdout, truncated: result.truncated };
  };
  const git = async (args: string[], signal: AbortSignal, timeout = QUICK_TIMEOUT): Promise<string> =>
    (await gitRaw(args, signal, timeout)).stdout.trim();
  // Read tools run without confirmation, so they also neutralise every command the repository's own
  // config declares (git-safety.mts), recomputed per call since the config can change. Write/network
  // tools act under the user's permission settings and keep the repository's filters and hooks
  // (git-crypt, git-lfs, husky…): neutralising a clean filter there would commit the wrong content.
  const readGuard = async (signal: AbortSignal): Promise<string[]> => {
    try { return await readOnlyGitArgs(root, env, { timeout: QUICK_TIMEOUT, signal }); }
    catch (error: any) {
      if (signal.aborted || error?.code === 'ENOENT') throw gitMissing(error);
      throw new Error(`Impossible de lire la configuration git du dépôt : commande non lancée (${error?.message ?? error})`);
    }
  };
  const gitRead = async (args: string[], signal: AbortSignal): Promise<string> => git([...await readGuard(signal), ...args], signal);

  /** A path the model gave to git_blame or git_diff, checked as the file tools check theirs (typed name and name on
   * disk), key material refused on both names. Returns the name on disk, relative to the project with '/', for git. */
  const checkedPath = async (value: string, action: 'blame' | 'diff', allowRoot: boolean): Promise<string> => {
    let onDisk: string;
    try { onDisk = await safePath(value, allowRoot); }
    catch (error: any) { throw new Error(`${error?.message ?? error} : ${action} refusé`); }
    const rel = relative(root, onDisk);
    if (rel && (isSensitiveFile(typedPath(value)) || isSensitiveFile(onDisk))) throw new Error(`Fichier secret : ${action} refusé`);
    return rel ? rel.split(sep).join('/') : '.';
  };

  /**
   * A diff with the hidden files left out and named. `flags` are the diff's own (--staged, --no-ext-diff…), `scope` its
   * pathspec. The changed paths are listed first with the same flags and scope, then the real diff excludes each hidden
   * one by a literal pathspec. A rename or copy is hidden, both names, when either name is: its other side holds the
   * hidden content. git gives paths from the top of the repository, the project may be a folder inside it: a path is
   * matched both as git gives it and relative to the project.
   */
  const filteredDiff = async (flags: string[], scope: string[], empty: string, signal: AbortSignal): Promise<string> => {
    const guard = await readGuard(signal);
    const prefix = (await git([...guard, 'rev-parse', '--show-prefix'], signal));
    const hidden = (path: string) => isSensitiveFile(path) || blocked(path) ||
      (!!prefix && path.startsWith(prefix) && blocked(path.slice(prefix.length)));
    const listing = await gitRaw([...guard, 'diff', '--name-status', '-z', ...flags, '--', ...scope], signal);
    if (listing.truncated) throw new Error('Trop de fichiers modifiés pour un diff sûr : indiquez un fichier ou un dossier');
    const entries = parseNameStatus(listing.stdout);
    const masked = entries.filter(paths => paths.some(hidden));
    if (!masked.length) return (await git([...guard, 'diff', ...flags, '--', ...scope, ...EXCLUDE_ENV], signal)) || empty;

    const names = [...new Set(masked.flat())];
    const literal = (path: string, magic: string) => `:(top,literal${magic})${path}`;
    const excludes = names.map(path => literal(path, ',exclude'));
    let body: string;
    if (excludes.reduce((sum, arg) => sum + arg.length + 3, 0) <= PATHSPEC_BUDGET) {
      body = await git([...guard, 'diff', ...flags, '--', ...scope, ...excludes, ...EXCLUDE_ENV], signal);
    } else {
      // Too many hidden paths for one command line: the visible entries are diffed instead, in batches, each rename or
      // copy kept whole in one batch. Nothing hidden is ever named to git as something to show.
      const visible = entries.filter(paths => !paths.some(hidden)).map(paths => paths.map(path => literal(path, '')));
      const parts: string[] = [];
      for (const batch of batches(visible)) {
        parts.push(await git([...guard, 'diff', ...flags, '--', ...batch, ...EXCLUDE_ENV], signal));
        if (parts.join('\n').length > DIFF_OUTPUT_MAX) break;
      }
      body = parts.filter(Boolean).join('\n');
    }
    const shown = names.slice(0, MASKED_NAMES).join(', ') + (names.length > MASKED_NAMES ? `, … (+${names.length - MASKED_NAMES})` : '');
    if (body.length > DIFF_OUTPUT_MAX) body = body.slice(0, DIFF_OUTPUT_MAX) + '\n[Diff tronqué]';
    return `${body || empty}\n${MASKED_LINE}${shown}`;
  };
  const okIfEmpty = (out: string) => out || 'OK (pas de sortie)';
  const fileRule: ParamRule = { type: 'string', maxLength: 4000, description: 'Fichiers séparés par des espaces (guillemets pour les noms avec espaces)' };
  const pick = (value: unknown, fallback: string) => (typeof value === 'string' && value ? value : fallback);

  return [
    defineTool({ name: 'git_status', description: 'État du dépôt (branche et fichiers modifiés).', category: 'read', properties: {}, execute: async (_a, signal) => {
      // Changes inside a submodule's work tree are not reported (see NO_SUBMODULE_WORKTREES).
      const out = await gitRead(['status', '--short', '--branch', NO_SUBMODULE_WORKTREES], signal);
      return out.split('\n').length <= 1 ? 'Working tree clean.' : out;
    } }),
    defineTool({ name: 'git_diff', description: 'Différences non indexées, éventuellement pour un seul fichier.', category: 'read',
      properties: { file: { type: 'string', maxLength: 1000, description: 'Fichier ou dossier (facultatif)' } }, execute: async (args, signal) => {
        const file = args.file as string | undefined;
        // A folder is allowed when it is itself: the files inside it are then filtered one by one.
        const scope = file ? [await checkedPath(file, 'diff', true)] : [];
        return filteredDiff(['--no-ext-diff', '--no-textconv', NO_SUBMODULE_WORKTREES], scope, 'No changes.', signal);
      } }),
    defineTool({ name: 'git_diff_staged', description: 'Différences indexées (prêtes à être commitées).', category: 'read', properties: {}, execute: async (_a, signal) =>
      filteredDiff(['--staged', '--no-ext-diff', '--no-textconv'], [], 'No changes (staged).', signal) }),
    defineTool({ name: 'git_log', description: 'Derniers commits.', category: 'read',
      properties: { n: { type: 'integer', maximum: 200, description: 'Nombre de commits (10 par défaut)' }, oneline: { type: 'boolean', description: 'Une ligne par commit (vrai par défaut)' } },
      execute: async (args, signal) => {
        const n = (args.n as number | undefined) ?? 10;
        const oneline = (args.oneline as boolean | undefined) ?? true;
        return okIfEmpty(await gitRead(['log', '-n', String(n), oneline ? '--oneline' : '--format=%h %an %ar%n%s%n'], signal));
      } }),
    defineTool({ name: 'git_blame', description: 'Qui a modifié chaque ligne d’un fichier (plage facultative).', category: 'read',
      properties: { file: { type: 'string', maxLength: 1000 }, start: { type: 'integer', description: 'Première ligne (1 par défaut)' }, end: { type: 'integer', minimum: 0, description: 'Dernière ligne (0 = jusqu’à la fin)' } },
      required: ['file'], execute: async (args, signal) => {
        const start = (args.start as number | undefined) ?? 1;
        const end = (args.end as number | undefined) ?? 0;
        const file = await checkedPath(args.file as string, 'blame', false);
        if (end > 0 && end < start) throw new Error('Plage de lignes invalide');
        const range = end > 0 || start > 1 ? ['-L', `${start},${end > 0 ? end : ''}`] : [];
        // blame applies textconv by default (verified): never run the repository's converter.
        return okIfEmpty(await gitRead(['blame', '--no-textconv', ...range, '--', file], signal));
      } }),
    defineTool({ name: 'git_branch_list', description: 'Liste des branches locales et distantes.', category: 'read', properties: {}, execute: async (_a, signal) => okIfEmpty(await gitRead(['branch', '-a'], signal)) }),

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
