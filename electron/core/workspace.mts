import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentTool } from './agent.mts';
import { metadataDirectory, object } from './json-store.mts';

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
  const pathField = { type: 'string', description: 'Chemin dans le projet actif' };
  const make = (name: string, description: string, category: AgentTool['category'], properties: Record<string, any>, required: string[], execute: AgentTool['execute']): AgentTool => ({
    name, description, category, parameters: { type: 'object', properties, required, additionalProperties: false },
    validate(args) {
      object(args);
      for (const key of required) if (!Object.hasOwn(args, key)) throw new Error('Argument requis');
      for (const [key, value] of Object.entries(args)) {
        const rule = Object.hasOwn(properties, key) ? properties[key] : undefined;
        if (!rule) throw new Error('Argument inconnu');
        if (rule.type === 'string' && (typeof value !== 'string' || value.length > 1048576 || value.includes('\0'))) throw new Error('Texte invalide');
        if (rule.type === 'integer' && (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 1000000)) throw new Error('Nombre invalide');
      }
    }, execute: async (args, signal) => { signal.throwIfAborted(); return execute(args, signal); },
  });
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
      const metadata = await metadataDirectory(root);
      const trash = join(metadata, 'trash');
      await mkdir(trash, { recursive: true });
      if ((await lstat(trash)).isSymbolicLink()) throw new Error('Corbeille redirigée');
      const recovery = join(trash, randomUUID() + '-' + basename(file));
      signal.throwIfAborted(); await safePath(args.path as string); await rename(file, recovery);
      return JSON.stringify({ removed: relative(root, file), recovery_path: relative(root, recovery) });
    }),
  ];
}
