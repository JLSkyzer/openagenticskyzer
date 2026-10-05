import { posix } from 'node:path';

// The file tools' filter, shared (2026-10-05): the semantic index applies exactly what the file tools' searches apply,
// so a file the model cannot find with grep_codebase cannot reach it through semantic_search either. Moved here from
// core/workspace.mts unchanged — never copied.

/** Key material, by file name: never listed by a search (glob_files, grep_codebase) nor indexed. */
export const SENSITIVE_FILE = /^id_(rsa|dsa|ecdsa|ed25519)$|\.(pem|key|p12|pfx)$|^(credentials|secrets)\.json$/i;

/** True when the file name of `path` (relative or absolute, either separator) is key material (SENSITIVE_FILE). The
 * file tools that open a file's content (read_file, view_file, grep_file, edit_file) refuse it; list_dir still names it. */
export function isSensitiveFile(path: string): boolean {
  return SENSITIVE_FILE.test(posix.basename(path.replace(/\\/g, '/')));
}

/**
 * A matcher for a project-relative path (either separator): true for `.env*`, `.git` and `.openagent` at any depth, and
 * for a match of the project's `ignored_patterns` (comma-separated globs; a pattern without « / » matches a name at any
 * depth, `dir/` covers everything under it). Every file tool refuses such a path.
 */
export function protectedPathMatcher(ignoredPatterns: string): (rel: string) => boolean {
  const ignored = ignoredPatterns.split(',').map(v => v.trim().replace(/\\/g, '/').replace(/\/+$/, '')).filter(Boolean);
  return (rel: string) => {
    const normalized = rel.replace(/\\/g, '/');
    const segments = normalized.split('/');
    if (segments.some(s => /^\.env(?:\.|$)/i.test(s) || ['.git', '.openagent'].includes(s.toLowerCase()))) return true;
    return ignored.some(pattern => posix.matchesGlob(normalized, pattern) || posix.matchesGlob(normalized, pattern + '/**') ||
      (!pattern.includes('/') && segments.some(s => posix.matchesGlob(s, pattern))));
  };
}

/** What a search never shows the model: a protected or ignored path, or key material by name. Applied by the
 * semantic index when it indexes and again when semantic_search reads (core/semantic-index.mts). */
export function searchExclusion(ignoredPatterns: string): (rel: string) => boolean {
  const blocked = protectedPathMatcher(ignoredPatterns);
  return (rel: string) => blocked(rel) || isSensitiveFile(rel);
}
