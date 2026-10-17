import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { protectedPathMatcher } from './file-filter.mts';

// The path check of every tool that takes a path from the model (2026-10-17): moved here from workspaceTools() unchanged,
// so the git read tools (core/git-tools.mts) refuse exactly what the file tools refuse. core/file-filter.mts stays the
// pure name matcher (no disk access, shared with the semantic index); this module is the part that looks at the disk.

export interface ProjectPathGuard {
  /** core/file-filter.mts's protectedPathMatcher for the project: .env*, .git, .openagent and the ignored patterns. */
  blocked: (rel: string) => boolean;
  /** The typed value as an absolute path under the root, either separator accepted. Nothing is checked. */
  typedPath: (value: string) => string;
  /** The checked path on disk (see below), or a French error. `allowRoot` accepts the project root itself. */
  safePath: (value: string, allowRoot?: boolean) => Promise<string>;
}

/**
 * The guard for one project. `root` must already be a realpath (the callers realpath the project folder once).
 *
 * safePath checks the typed name first (inside the project, not protected nor ignored, no ambiguous level, no link or
 * junction on the way), then the name on disk: a Windows 8.3 short name (GIT~1, OPENAG~1, SECRET~1.JSO) or another case
 * (PRIVATE/ for an ignored private/) reaches the same place under a name the typed checks do not recognise, and realpath
 * gives the real one. It returns the path on disk, so a caller works with — and shows — the real names. Key material
 * (isSensitiveFile) is NOT checked here: list_dir and the searches still name it, each content tool refuses it itself.
 */
export function projectPathGuard(root: string, ignoredPatterns: string): ProjectPathGuard {
  const blocked = protectedPathMatcher(ignoredPatterns);
  const typedPath = (value: string) => resolve(root, value.replace(/[\\/]/g, sep));
  const outside = (rel: string, allowRoot: boolean) =>
    rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || rel.includes(':') || (!rel && !allowRoot);
  /** `file` under the names on disk: the realpath of its longest existing prefix, then the levels not created yet. */
  const onDiskPath = async (file: string) => {
    const missing: string[] = [];
    for (let cursor = file; ; cursor = dirname(cursor)) {
      try { return join(await realpath(cursor), ...missing); }
      catch (e: any) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
      if (dirname(cursor) === cursor) throw new Error('Chemin invalide');
      missing.unshift(basename(cursor));
    }
  };
  const safePath = async (value: string, allowRoot = false) => {
    if (!value || value.includes('\0')) throw new Error('Chemin invalide');
    const file = typedPath(value);
    const rel = relative(root, file);
    if (outside(rel, allowRoot)) throw new Error('Chemin hors projet ou racine protégée');
    if (blocked(rel)) throw new Error('Fichier ignoré ou protégé');
    let cursor = root;
    for (const segment of rel.split(sep).filter(Boolean)) {
      if (/[. ]$/.test(segment)) throw new Error('Chemin ambigu refusé');
      cursor = join(cursor, segment);
      try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Lien ou jonction refusé'); }
      catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    }
    const onDisk = await onDiskPath(file);
    const relOnDisk = relative(root, onDisk);
    if (outside(relOnDisk, allowRoot)) throw new Error('Chemin hors projet ou racine protégée');
    if (blocked(relOnDisk)) throw new Error('Fichier ignoré ou protégé');
    return onDisk;
  };
  return { blocked, typedPath, safePath };
}
