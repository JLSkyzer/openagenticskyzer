// The reuse verdicts of a bench results file (plan 2026-10-25-llm-performance, Task 2), measured before any lever:
// for each generation of A and B, how much of the held context the engine read again, and where the new prompt
// diverged from what the sequence held.
//
//   node --experimental-strip-types bench/reuse-report.mts <results.json>      (npm run bench:reuse -- <file>)
//
// Verdicts:
// - « froid »: the sequence held nothing (the first generation of a process, or after a reload);
// - « réutilisé »: everything held up to the divergence was reused, give or take RESTORE_SLACK tokens;
// - « point de sauvegarde manquant »: the common prefix was there, but it was read again. On a hybrid or recurrent
//   model (no attention-only KV to truncate), the state can only be restored from a checkpoint taken before the
//   divergence: none was close enough.
// Where it diverged (against the previous generation of the same worker): before the end of the previous prompt (the
// system text, the tools or the history changed), or inside the previous reply (what was generated is not what is
// sent back, e.g. a stripped thought). C is left out: each of its sessions is a fresh process, always cold.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { ReuseFigures } from '../core/reuse.mts';
import type { BenchRun } from './metrics.mts';

/** Tokens: re-reading this little after the divergence still counts as reuse. */
export const RESTORE_SLACK = 16;
export type ReuseVerdict = 'froid' | 'réutilisé' | 'point de sauvegarde manquant';
export type Divergence = 'dans le prompt précédent' | 'dans la réponse précédente';

export function classifyReuse(r: ReuseFigures): ReuseVerdict {
  if (r.held === 0) return 'froid';
  return r.reused >= r.common - RESTORE_SLACK ? 'réutilisé' : 'point de sauvegarde manquant';
}

/** null when there is no previous generation; else whether the common prefix ends before the previous prompt's end. */
export function divergenceAt(previous: ReuseFigures | null, current: ReuseFigures): Divergence | null {
  if (previous === null) return null;
  return current.common < previous.prompt ? 'dans le prompt précédent' : 'dans la réponse précédente';
}

/**
 * One line per A and B generation, in run order:
 * `A·2 étape 0 : tenus 4180 · communs 4091 · relus 4213 · réutilisés 0 — point de sauvegarde manquant (dans la réponse précédente)`.
 * A and B share one worker, so B's first generation is compared with A's last. Where it diverged is left out of a
 * « froid » line (nothing was held). A generation without figures says so, and the next one has no previous.
 */
export function formatReuseReport(run: BenchRun): string {
  const lines = [`${run.label} · ${run.model?.file ?? '?'} · moteur ${run.backend ?? '?'} · node-llama-cpp ${run.nodeLlamaCpp ?? '?'}`];
  let previous: ReuseFigures | null = null;
  for (const turn of Array.isArray(run.turns) ? run.turns : []) {
    if (turn.scenario !== 'A' && turn.scenario !== 'B') continue;
    for (const generation of Array.isArray(turn.generations) ? turn.generations : []) {
      const name = `${turn.scenario}·${turn.message} étape ${generation.step}`;
      const r = generation.reuse;
      if (!r) {
        lines.push(`${name} : sans mesure de réutilisation`);
        previous = null;
        continue;
      }
      const verdict = classifyReuse(r);
      const where = verdict === 'froid' ? null : divergenceAt(previous, r);
      lines.push(`${name} : tenus ${r.held} · communs ${r.common} · relus ${r.evaluated} · réutilisés ${r.reused} — ${verdict}${where ? ` (${where})` : ''}`);
      previous = r;
    }
  }
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [path] = process.argv.slice(2);
  if (!path) {
    console.error('Usage : bench/reuse-report.mts <résultats.json>');
    process.exit(2);
  }
  let run: BenchRun;
  try {
    run = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    console.error(`Fichier de résultats illisible : ${path} (${error instanceof Error ? error.message : error})`);
    process.exit(2);
  }
  process.stdout.write(formatReuseReport(run));
}
