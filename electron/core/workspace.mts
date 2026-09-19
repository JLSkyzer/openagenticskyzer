import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import type { AgentTool } from './agent.mts';
import { metadataDirectory } from './json-store.mts';
import { defineTool, type ParamRule } from './tool-kit.mts';

/** Only the agent's permission gate should call these capability implementations. */
export async function workspaceTools(folder: string, ignoredPatterns: string): Promise<AgentTool[]> {
  if (!isAbsolute(folder)) throw new Error('Dossier projet absolu requis');
  const root = await realpath(folder);
  if (!(await lstat(root)).isDirectory()) throw new Error('Dossier projet invalide');
  const ignored = ignoredPatterns.split(',').map(v => v.trim().replace(/\\/g, '/').replace(/\/+$/, '')).filter(Boolean);
  const blocked = (rel: string) => {
    const normalized = rel.replace(/\\/g, '/');
    const segments = normalized.split('/');
    if (segments.some(s => /^\.env(?:\.|$)/i.test(s) || ['.git', '.openagent'].includes(s.toLowerCase()))) return true;
    return ignored.some(pattern => posix.matchesGlob(normalized, pattern) || posix.matchesGlob(normalized, pattern + '/**') ||
      (!pattern.includes('/') && segments.some(s => posix.matchesGlob(s, pattern))));
  };
  const safePath = async (value: string, allowRoot = false) => {
    if (!value || value.includes('\0')) throw new Error('Chemin invalide');
    const file = resolve(root, value.replace(/[\\/]/g, sep));
    const rel = relative(root, file);
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || rel.includes(':') || (!rel && !allowRoot)) throw new Error('Chemin hors projet ou racine protégée');
    if (blocked(rel)) throw new Error('Fichier ignoré ou protégé');
    let cursor = root;
    for (const segment of rel.split(sep).filter(Boolean)) {
      if (/[. ]$/.test(segment)) throw new Error('Chemin ambigu refusé');
      cursor = join(cursor, segment);
      try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Lien ou jonction refusé'); }
      catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    }
    return file;
  };
  const textFile = async (path: string, signal: AbortSignal) => {
    const file = await safePath(path);
    const info = await lstat(file);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('Fichier non texte ou trop volumineux (2 Mio maximum)');
    const bytes = await readFile(file, { signal });
    if (bytes.includes(0)) throw new Error('Fichier binaire');
    return { file, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), bytes: info.size };
  };
  const pathField: ParamRule = { type: 'string', description: 'Chemin dans le projet actif' };

  // ── Search helpers ──────────────────────────────────────────────────────────────
  // Build/vendor directories and dot-directories are never worth searching, and key
  // material is skipped on top of blocked() (.env*, .git, .openagent, ignored patterns) so
  // a broad search cannot hand it to the model.
  const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git', 'dist', '.next', 'build', 'venv', '.venv', 'env']);
  const SENSITIVE_FILE = /^id_(rsa|dsa|ecdsa|ed25519)$|\.(pem|key|p12|pfx)$|^(credentials|secrets)\.json$/i;
  const MAX_WALKED = 20000;
  const MAX_FILE_BYTES = 2 * 1024 * 1024;
  /** Regular files under `start`, in name order. Symlinks and junctions are never followed. */
  const walkFiles = async (start: string, signal: AbortSignal): Promise<Array<{ abs: string; rel: string }>> => {
    const found: Array<{ abs: string; rel: string }> = [];
    let visited = 0;
    const visit = async (dir: string) => {
      signal.throwIfAborted();
      const entries = (await readdir(dir, { withFileTypes: true })).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
      for (const entry of entries) {
        if (++visited > MAX_WALKED) return;
        if (entry.isSymbolicLink()) continue;
        const abs = join(dir, entry.name);
        const rel = relative(root, abs).split(sep).join('/');
        if (blocked(rel)) continue;
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
          await visit(abs);
        } else if (entry.isFile() && !SENSITIVE_FILE.test(entry.name)) found.push({ abs, rel });
      }
    };
    await visit(start);
    return found;
  };
  const readSearchable = async (abs: string): Promise<string | null> => {
    const info = await lstat(abs);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    const bytes = await readFile(abs);
    return bytes.includes(0) ? null : bytes.toString('utf8');
  };
  const toTrash = async (target: string, original: string, signal: AbortSignal) => {
    const metadata = await metadataDirectory(root);
    const trash = join(metadata, 'trash');
    await mkdir(trash, { recursive: true });
    if ((await lstat(trash)).isSymbolicLink()) throw new Error('Corbeille redirigée');
    const recovery = join(trash, randomUUID() + '-' + basename(target));
    signal.throwIfAborted(); await safePath(original); await rename(target, recovery);
    return JSON.stringify({ removed: relative(root, target), recovery_path: relative(root, recovery) });
  };
  const make = (name: string, description: string, category: AgentTool['category'], properties: Record<string, ParamRule>, required: string[], execute: AgentTool['execute']): AgentTool =>
    defineTool({ name, description, category, properties, required, execute });
  return [
    make('read_file', 'Lire un fichier texte avec numéros de lignes.', 'read', { path: pathField, offset: { type: 'integer' }, limit: { type: 'integer' } }, ['path'], async (args, signal) => {
      const { text } = await textFile(args.path as string, signal);
      const offset = Number(args.offset ?? 1); const limit = Number(args.limit ?? 1000);
      const lines = text.split(/\r?\n/);
      return lines.slice(offset - 1, offset - 1 + limit).map((line, index) => `${index + offset}|${line}`).join('\n').slice(0, 50000);
    }),
    make('view_file', 'Voir la taille, le nombre de lignes et les dix premières lignes.', 'read', { path: pathField }, ['path'], async (args, signal) => {
      const { text, bytes } = await textFile(args.path as string, signal); const lines = text.split(/\r?\n/);
      return JSON.stringify({ bytes, lines: lines.length, preview: lines.slice(0, 10).join('\n') });
    }),
    make('list_dir', 'Lister les entrées visibles d’un dossier du projet.', 'read', { path: pathField }, [], async args => {
      const dir = await safePath(args.path as string || '.', true);
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter(e => !e.isSymbolicLink() && !blocked(relative(root, join(dir, e.name))))
        .map(e => e.name + (e.isDirectory() ? '/' : '')).sort().join('\n').slice(0, 50000);
    }),
    make('create_file', 'Créer un fichier sans écraser un fichier existant.', 'write', { path: pathField, content: { type: 'string' } }, ['path'], async (args, signal) => {
      const file = await safePath(args.path as string);
      // Parent must exist; create_dir is an explicit, separately authorized operation.
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(args.content as string || '', { encoding: 'utf8', signal }); await handle.sync(); }
      finally { await handle.close(); }
      return `Créé : ${relative(root, file)}`;
    }),
    make('edit_file', 'Remplacer une occurrence exacte et non ambiguë dans un fichier.', 'write', { path: pathField, old_string: { type: 'string' }, new_string: { type: 'string' } }, ['path', 'old_string', 'new_string'], async (args, signal) => {
      const { file, text } = await textFile(args.path as string, signal);
      const old = args.old_string as string;
      if (!old || text.split(old).length !== 2) throw new Error('Le texte à remplacer doit avoir exactement une occurrence');
      const next = text.replace(old, () => args.new_string as string);
      const temp = join(dirname(file), '.' + basename(file) + '.' + randomUUID() + '.tmp');
      try {
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(next, { encoding: 'utf8', signal }); await handle.sync(); } finally { await handle.close(); }
        await safePath(args.path as string);
        if (await readFile(file, 'utf8') !== text) throw new Error('Fichier modifié entre-temps : relire avant de réessayer');
        signal.throwIfAborted(); await rename(temp, file);
      } finally { await rm(temp, { force: true }); }
      return `Modifié : ${relative(root, file)}\n-${old}\n+${args.new_string}`;
    }),
    make('create_dir', 'Créer un dossier du projet.', 'write', { path: pathField }, ['path'], async args => {
      const dir = await safePath(args.path as string); await mkdir(dir); return `Créé : ${relative(root, dir)}`;
    }),
    make('delete_file', 'Retirer un fichier en le conservant dans la corbeille du projet.', 'write', { path: pathField }, ['path'], async (args, signal) => {
      const file = await safePath(args.path as string);
      if (!(await lstat(file)).isFile()) throw new Error('Fichier régulier requis');
      return toTrash(file, args.path as string, signal);
    }),
    make('delete_dir', 'Retirer un dossier du projet en le conservant dans la corbeille du projet.', 'write', { path: pathField }, ['path'], async (args, signal) => {
      // safePath refuses the project root, protected/ignored paths and anything reached
      // through a link; a link inside the directory is moved as a link, never followed.
      const dir = await safePath(args.path as string);
      if (!(await lstat(dir)).isDirectory()) throw new Error('Dossier régulier requis');
      return toTrash(dir, args.path as string, signal);
    }),
    make('grep_file', 'Chercher un texte exact (sensible à la casse) dans un fichier ; renvoie les lignes.', 'read', { path: pathField, pattern: { type: 'string', maxLength: 1000, description: 'Texte littéral à trouver' } }, ['path', 'pattern'], async (args, signal) => {
      const pattern = args.pattern as string;
      if (!pattern) throw new Error('Motif vide');
      const { text } = await textFile(args.path as string, signal);
      const hits: string[] = [];
      let total = 0;
      text.split(/\r?\n/).forEach((line, index) => {
        if (!line.includes(pattern)) return;
        total++;
        if (hits.length < 200) hits.push(`Line ${index + 1}: ${line.slice(0, 300)}`);
      });
      if (!total) return `No matches for '${pattern}'.`;
      return hits.join('\n') + (total > hits.length ? '\n... [capped at 200 matches]' : '');
    }),
    make('glob_files', 'Lister les fichiers du projet correspondant à un motif glob (ex. src/**/*.ts, *.md).', 'read', {
      pattern: { type: 'string', maxLength: 500, description: 'Motif glob ; sans « / » il s’applique au nom du fichier à toute profondeur' },
      path: pathField,
    }, ['pattern'], async (args, signal) => {
      const pattern = (args.pattern as string).replace(/\\/g, '/');
      if (!pattern) throw new Error('Motif vide');
      const start = await safePath((args.path as string) || '.', true);
      const matches = (await walkFiles(start, signal))
        .filter(({ abs }) => {
          const fromStart = relative(start, abs).split(sep).join('/');
          return posix.matchesGlob(fromStart, pattern) || (!pattern.includes('/') && posix.matchesGlob(basename(abs), pattern));
        })
        .map(({ rel }) => rel);
      const shown = matches.slice(0, 500);
      return `${shown.join('\n')}\n\n${matches.length} file(s) found.${matches.length > shown.length ? ' [capped at 500 shown]' : ''}`;
    }),
    make('grep_codebase', 'Chercher une expression régulière (insensible à la casse) dans les fichiers texte du projet.', 'read', {
      pattern: { type: 'string', maxLength: 500, description: 'Expression régulière' },
      path: pathField,
      file_glob: { type: 'string', maxLength: 200, description: 'Filtre sur le nom des fichiers, ex. *.ts' },
    }, ['pattern'], async (args, signal) => {
      const pattern = args.pattern as string;
      if (!pattern) throw new Error('Motif vide');
      try { new RegExp(pattern, 'i'); } catch (error) { return `Motif regex invalide : ${(error as Error).message}`; }
      const fileGlob = (args.file_glob as string) || '*';
      const start = await safePath((args.path as string) || '.', true);
      const out: string[] = [];
      let capped = false;
      const deadline = Date.now() + 30000;
      for (const { abs, rel } of await walkFiles(start, signal)) {
        signal.throwIfAborted();
        if (!posix.matchesGlob(basename(abs), fileGlob)) continue;
        if (Date.now() > deadline) { out.push('... [search stopped after 30 s]'); break; }
        const text = await readSearchable(abs);
        if (text === null) continue;
        let indexes: number[];
        try {
          // The regex runs in its own context with a hard time limit: a catastrophic
          // pattern (e.g. (a+)+$) is interrupted instead of freezing the whole engine.
          indexes = Array.from(runInNewContext(
            'const re = new RegExp(pattern, "i"); const hits = []; const lines = text.split(/\\r?\\n/);' +
            'for (let i = 0; i < lines.length && hits.length < limit; i++) if (re.test(lines[i].slice(0, 2000))) hits.push(i);' +
            'hits', { pattern, text, limit: 201 - out.length }, { timeout: 1500 },
          ) as number[]);
        } catch (error: any) {
          if (error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new Error('Motif trop coûteux (délai dépassé) : simplifiez l’expression régulière');
          throw error;
        }
        const lines = text.split(/\r?\n/);
        for (const index of indexes) {
          if (out.length >= 200) { capped = true; break; }
          out.push(`${rel}:${index + 1}: ${lines[index].slice(0, 300)}`);
        }
        if (capped) break;
      }
      if (!out.length) return `No matches for '${pattern}'.`;
      return out.join('\n') + (capped ? '\n... [capped at 200 matches]' : '');
    }),
  ];
}
