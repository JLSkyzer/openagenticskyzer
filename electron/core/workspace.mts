import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import type { AgentTool } from './agent.mts';
import { metadataDirectory } from './json-store.mts';
import { isSensitiveFile, protectedPathMatcher } from './file-filter.mts';
import { defineTool, type ParamRule } from './tool-kit.mts';

/** Only the agent's permission gate should call these capability implementations. */
export async function workspaceTools(folder: string, ignoredPatterns: string): Promise<AgentTool[]> {
  if (!isAbsolute(folder)) throw new Error('Dossier projet absolu requis');
  const root = await realpath(folder);
  if (!(await lstat(root)).isDirectory()) throw new Error('Dossier projet invalide');
  // .env*, .git, .openagent and the project's ignored_patterns — core/file-filter.mts, shared with the semantic index.
  const blocked = protectedPathMatcher(ignoredPatterns);
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
  /** Opens a text file for read_file, view_file, grep_file and edit_file: key material by name (core/file-filter.mts)
   * is refused here, so none of them ever returns or rewrites its content. list_dir still names it. */
  const textFile = async (path: string, signal: AbortSignal) => {
    const file = await safePath(path);
    if (isSensitiveFile(file)) throw new Error('Fichier secret (clé ou identifiants) : lecture et modification refusées');
    const info = await lstat(file);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('Fichier non texte ou trop volumineux (2 Mio maximum)');
    const bytes = await readFile(file, { signal });
    if (bytes.includes(0)) throw new Error('Fichier binaire');
    return { file, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), bytes: info.size };
  };
  /** Lines of a text, without the empty element a final newline would add: "a\nb\n" has 2 lines, not 3. */
  const splitLines = (text: string) => {
    const lines = text.split(/\r?\n/);
    if (lines.length > 1 && lines.at(-1) === '') lines.pop();
    return lines;
  };
  const pathField: ParamRule = { type: 'string', description: 'Chemin dans le projet actif' };
  // read_file's cap, header and resume marker included: agent.mts's own 50 000-character cut must never
  // swallow the marker that tells the model where to resume.
  const READ_FILE_MAX_CHARS = 50000;
  /**
   * Creates each missing level of `dir` (inside the project) one at a time, and checks every level, new or
   * old, is a real directory: never a link, a junction or a file. safePath() already refused the levels
   * that existed; this closes the gap for the ones created here. Returns how many levels were created.
   */
  const ensureDirectories = async (dir: string): Promise<number> => {
    let created = 0;
    let cursor = root;
    for (const segment of relative(root, dir).split(sep).filter(Boolean)) {
      cursor = join(cursor, segment);
      try { await mkdir(cursor); created++; }
      catch (e: any) { if (e.code !== 'EEXIST') throw e; }
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Dossier impossible : un élément du chemin est un fichier, un lien ou une jonction');
    }
    return created;
  };

  // ── Search helpers ──────────────────────────────────────────────────────────────
  // Build/vendor directories and dot-directories are never worth searching, and key
  // material is skipped on top of blocked() (.env*, .git, .openagent, ignored patterns) so
  // a broad search cannot hand it to the model.
  const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git', 'dist', '.next', 'build', 'venv', '.venv', 'env']);
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
        } else if (entry.isFile() && !isSensitiveFile(entry.name)) found.push({ abs, rel });
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
      const offset = Math.max(1, Number(args.offset ?? 1)); const limit = Math.max(1, Number(args.limit ?? 1000));
      const lines = splitLines(text);
      const total = lines.length;
      if (offset > total) return `[Le fichier a ${total} lignes : rien à partir de la ligne ${offset}]`;
      // Room for "[Lignes X–Y sur N]\n", the cut-line note and "\n[Tronqué : relis avec offset=Z]" inside the 50 000 characters.
      const room = READ_FILE_MAX_CHARS - 300;
      const shown: string[] = [];
      let size = 0;
      let cut = false;
      let cutLine = 0;
      for (let index = offset - 1; index < Math.min(total, offset - 1 + limit); index++) {
        const line = `${index + 1}|${lines[index]}`;
        const cost = line.length + (shown.length ? 1 : 0);
        if (size + cost > room) {
          // A single line longer than the whole budget is shown cut rather than not at all.
          if (!shown.length) { shown.push(line.slice(0, room)); cutLine = index + 1; }
          cut = true;
          break;
        }
        shown.push(line);
        size += cost;
      }
      const last = offset + shown.length - 1;
      if (offset === 1 && last >= total && !cut) return shown.join('\n');
      // The model must know it did not see everything, and where to go on (audit M3). The resume offset always
      // moves forward: pointing back at a cut line would return the same prefix, and the rest of an over-long
      // line is not reachable with the file tools, so the note says so.
      const note = cutLine
        ? `\n[Ligne ${cutLine} coupée : ${shown[0].length - `${cutLine}|`.length} caractères affichés sur ${lines[cutLine - 1].length} ; la suite de cette ligne n'est pas lisible avec read_file]`
        : '';
      const resume = last < total ? `\n[Tronqué : relis avec offset=${last + 1}]` : '';
      return `[Lignes ${offset}–${last} sur ${total}]\n${shown.join('\n')}${note}${resume}`;
    }),
    make('view_file', 'Voir la taille, le nombre de lignes et les dix premières lignes.', 'read', { path: pathField }, ['path'], async (args, signal) => {
      const { text, bytes } = await textFile(args.path as string, signal); const lines = splitLines(text);
      return JSON.stringify({ bytes, lines: lines.length, preview: lines.slice(0, 10).join('\n') });
    }),
    make('list_dir', 'Lister les entrées visibles d’un dossier du projet.', 'read', { path: pathField }, [], async args => {
      const dir = await safePath(args.path as string || '.', true);
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter(e => !e.isSymbolicLink() && !blocked(relative(root, join(dir, e.name))))
        .map(e => e.name + (e.isDirectory() ? '/' : '')).sort().join('\n').slice(0, 50000);
    }),
    make('create_file', 'Créer un fichier (et ses dossiers parents) sans écraser un fichier existant.', 'write', { path: pathField, content: { type: 'string' } }, ['path'], async (args, signal) => {
      const file = await safePath(args.path as string);
      // Missing parents are created under the same guards as the file: safePath above (inside the project,
      // not ignored or protected, no existing link), each new level checked as it is made, and the full path
      // checked again just before the file is opened.
      await ensureDirectories(dirname(file));
      await safePath(args.path as string);
      const handle = await open(file, 'wx', 0o600).catch((e: NodeJS.ErrnoException) => {
        throw e.code === 'EEXIST' ? new Error('le fichier existe : utilise edit_file, ou delete_file puis create_file') : e;
      });
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
    make('create_dir', 'Créer un dossier du projet, dossiers parents compris.', 'write', { path: pathField }, ['path'], async args => {
      const dir = await safePath(args.path as string);
      const created = await ensureDirectories(dir);
      return created ? `Créé : ${relative(root, dir)}` : `Existe déjà : ${relative(root, dir)}`;
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
