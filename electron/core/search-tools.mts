import { isAbsolute } from 'node:path';
import type { AgentTool } from './agent.mts';
import { defineTool } from './tool-kit.mts';
import { searchCollection, storePath } from './semantic-index.mts';
import { searchKnowledge } from './knowledge-base.mts';
import { searchExclusion } from './file-filter.mts';

const N_RULE = { type: 'integer' as const, minimum: 1, maximum: 20, description: 'Nombre de résultats (défaut 5)' };
const QUERY_RULE = { type: 'string' as const, maxLength: 2000, description: 'Requête en langage naturel' };

/**
 * `semantic_search`/`knowledge_search` — same text contract as `index_tools.py`. Unlike Python,
 * where tools are registered once globally and must check `state.active_folder` themselves,
 * `registerTools` in this codebase already re-builds every tool for a specific, real, validated
 * `folder` on each turn (every other read tool here, e.g. gitTools, relies on the same
 * guarantee) — so there is no "no active folder" case to report here.
 *
 * `ignoredPatterns` is the project's ignored_patterns: semantic_search never renders a chunk of a file the file tools'
 * searches hide (core/file-filter.mts), even from an index built before that file was excluded.
 */
export async function searchTools(folder: string, home: string, ignoredPatterns = ''): Promise<AgentTool[]> {
  if (!isAbsolute(folder) || !isAbsolute(home)) throw new Error('Chemins absolus requis');
  const excluded = searchExclusion(ignoredPatterns);
  return [
    defineTool({
      name: 'semantic_search',
      description: 'Recherche sémantique dans le code du dossier actif pour des correspondances conceptuelles.',
      category: 'read',
      properties: { query: QUERY_RULE, n: N_RULE },
      required: ['query'],
      execute: async args => {
        const n = (args.n as number | undefined) ?? 5;
        let results;
        try {
          results = await searchCollection(await storePath(folder), args.query as string, home, n, excluded);
        } catch (error) {
          return `Index not ready: ${error instanceof Error ? error.message : 'Erreur interne'}. Index the project first.`;
        }
        if (!results.length) return 'No results found. The index may not be built yet.';
        return results.map(r => `[${r.file}] (score: ${r.score.toFixed(2)})\n${r.content}`).join('\n\n---\n\n');
      },
    }),
    defineTool({
      name: 'knowledge_search',
      description: 'Recherche dans les documents explicitement ajoutés à la base de connaissances personnelle.',
      category: 'read',
      properties: { query: QUERY_RULE, n: N_RULE },
      required: ['query'],
      execute: async args => {
        const n = (args.n as number | undefined) ?? 5;
        let results;
        try {
          results = await searchKnowledge(args.query as string, home, n);
        } catch (error) {
          return `Erreur base de connaissances : ${error instanceof Error ? error.message : 'Erreur interne'}`;
        }
        if (!results.length) return 'La base de connaissances est vide ou aucun résultat pertinent.';
        return results.map(r => `[Source: ${r.source}] (score: ${r.score.toFixed(2)})\n${r.content}`).join('\n\n---\n\n');
      },
    }),
  ];
}
